import type { ISODate } from "@/lib/dates";

/**
 * Cálculo do rendimento bruto de uma conta de investimento, dia útil a dia útil, sobre o saldo do
 * fim do dia anterior (aplicações e resgates do próprio dia contam a partir do dia seguinte).
 *
 * - CDI/Selic: fator do dia = taxa do dia (% a.d., BCB) × percentual contratado (ex.: 101,5%).
 * - Prefixado: (1 + taxa anual)^(1/252) por dia útil.
 * - IPCA + x%: (1 + IPCA do mês)^(1/dias úteis do mês) × (1 + x)^(1/252); só apura meses com IPCA
 *   publicado.
 * Os dias úteis são os dias com CDI publicado (calendário oficial do mercado).
 * Pura: sem banco nem rede; o resultado é agrupado por mês e arredondado só no final de cada mês.
 */

export type YieldIndexValue = "CDI" | "SELIC" | "IPCA" | "PREFIXED";

export interface YieldConfig {
  index: YieldIndexValue;
  /** CDI/Selic: % do indexador × 100 (10150 = 101,5%). Prefixado/IPCA: % a.a. × 100. */
  rateBps: number;
  startDate: ISODate;
}

export interface Movement {
  date: ISODate;
  /** Centavos com sinal (entrada positiva). Inclui o saldo inicial da conta. */
  amountCents: number;
}

export interface RateTables {
  /** Dias úteis com CDI publicado, em ordem. */
  businessDays: ISODate[];
  /** % ao dia por data (CDI ou Selic, conforme o indexador). */
  daily: Map<ISODate, number>;
  /** IPCA % no mês, por "AAAA-MM". */
  monthlyIpca: Map<string, number>;
}

export interface MonthYield {
  month: string;
  /** Rendimento bruto exato (centavos fracionários). */
  exactCents: number;
  grossCents: number;
  businessDays: number;
  accruedThrough: ISODate;
}

export interface YieldResult {
  months: MonthYield[];
  /** Saldo com o rendimento apurado (centavos fracionários). */
  balanceExact: number;
  lastAccrued: ISODate | null;
  /** Meses sem IPCA publicado (a apuração para no início do primeiro). */
  waitingIpca: string[];
}

const dailyPrefixed = (annualBps: number) => Math.pow(1 + annualBps / 10_000, 1 / 252) - 1;

export function computeYield(cfg: YieldConfig, movements: Movement[], rates: RateTables, until: ISODate): YieldResult {
  const sorted = [...movements].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const days = rates.businessDays.filter((d) => d >= cfg.startDate && d <= until);
  const perMonthDays = new Map<string, number>();
  for (const d of rates.businessDays) perMonthDays.set(d.slice(0, 7), (perMonthDays.get(d.slice(0, 7)) ?? 0) + 1);

  let balance = 0;
  let i = 0;
  const months = new Map<string, MonthYield>();
  const waitingIpca: string[] = [];
  let lastAccrued: ISODate | null = null;

  for (const d of days) {
    // Movimentos até o dia anterior compõem o saldo que rende hoje.
    while (i < sorted.length && sorted[i]!.date < d) balance += sorted[i++]!.amountCents;

    let factor: number | null;
    if (cfg.index === "CDI" || cfg.index === "SELIC") {
      const r = rates.daily.get(d);
      factor = r === undefined ? null : (r / 100) * (cfg.rateBps / 10_000);
    } else if (cfg.index === "PREFIXED") {
      factor = dailyPrefixed(cfg.rateBps);
    } else {
      const month = d.slice(0, 7);
      const ipca = rates.monthlyIpca.get(month);
      if (ipca === undefined) {
        if (!waitingIpca.includes(month)) waitingIpca.push(month);
        break;
      }
      factor = Math.pow(1 + ipca / 100, 1 / (perMonthDays.get(month) ?? 21)) * (1 + dailyPrefixed(cfg.rateBps)) - 1;
    }
    if (factor === null) break; // taxa do dia ainda não publicada: para aqui e continua na próxima execução

    const gain = balance > 0 ? balance * factor : 0;
    balance += gain;
    lastAccrued = d;
    const key = d.slice(0, 7);
    const m = months.get(key) ?? { month: key, exactCents: 0, grossCents: 0, businessDays: 0, accruedThrough: d };
    m.exactCents += gain;
    m.businessDays++;
    m.accruedThrough = d;
    months.set(key, m);
  }
  while (i < sorted.length && sorted[i]!.date <= until) balance += sorted[i++]!.amountCents;

  const list = [...months.values()].map((m) => ({ ...m, grossCents: Math.round(m.exactCents) }));
  return { months: list, balanceExact: balance, lastAccrued, waitingIpca };
}

// -----------------------------------------------------------------------------
// Estimativa líquida (IR regressivo e IOF) — sempre apresentada como estimativa
// -----------------------------------------------------------------------------

/** IR regressivo de renda fixa pelo prazo da aplicação (dias corridos). */
export function irRate(daysHeld: number): number {
  if (daysHeld <= 180) return 0.225;
  if (daysHeld <= 360) return 0.2;
  if (daysHeld <= 720) return 0.175;
  return 0.15;
}

/** IOF regressivo sobre o rendimento nos primeiros 30 dias (dia 1 = 96% … dia 30 = 0%). */
const IOF_TABLE = [96, 93, 90, 86, 83, 80, 76, 73, 70, 66, 63, 60, 56, 53, 50, 46, 43, 40, 36, 33, 30, 26, 23, 20, 16, 13, 10, 6, 3, 0];
export function iofRate(daysHeld: number): number {
  if (daysHeld <= 0) return 0.96;
  if (daysHeld >= 30) return 0;
  return IOF_TABLE[daysHeld - 1]! / 100;
}

export interface NetEstimate {
  grossGainCents: number;
  irCents: number;
  iofCents: number;
  netGainCents: number;
  exempt: boolean;
}

/**
 * Estimativa do líquido se tudo fosse resgatado em `asOf`: os aportes formam lotes (o mais antigo é
 * resgatado primeiro) e o ganho é dividido entre os lotes pelo capital × tempo aplicado.
 */
export function estimateNet(movements: Movement[], gainCents: number, asOf: ISODate, opts: { exempt: boolean }): NetEstimate {
  const gain = Math.max(0, gainCents);
  if (opts.exempt || gain === 0) return { grossGainCents: Math.round(gain), irCents: 0, iofCents: 0, netGainCents: Math.round(gain), exempt: opts.exempt };
  const lots: Array<{ date: ISODate; cents: number }> = [];
  for (const m of [...movements].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (m.date > asOf) break;
    if (m.amountCents > 0) lots.push({ date: m.date, cents: m.amountCents });
    else {
      let out = -m.amountCents;
      while (out > 0 && lots.length) {
        const first = lots[0]!;
        const take = Math.min(first.cents, out);
        first.cents -= take;
        out -= take;
        if (first.cents <= 0) lots.shift();
      }
    }
  }
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const held = lots.map((l) => ({ ...l, days: Math.max(0, Math.round((asOfMs - Date.parse(`${l.date}T00:00:00Z`)) / 86_400_000)) }));
  const weight = held.reduce((s, l) => s + l.cents * Math.max(1, l.days), 0);
  let ir = 0;
  let iof = 0;
  for (const l of held) {
    const share = weight ? (gain * l.cents * Math.max(1, l.days)) / weight : 0;
    const lotIof = share * iofRate(l.days);
    iof += lotIof;
    ir += (share - lotIof) * irRate(l.days);
  }
  const irCents = Math.round(ir);
  const iofCents = Math.round(iof);
  return { grossGainCents: Math.round(gain), irCents, iofCents, netGainCents: Math.round(gain) - irCents - iofCents, exempt: false };
}
