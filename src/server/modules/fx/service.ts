import { Prisma } from "@prisma/client";
import { prisma, type Db } from "../../db";
import { errorInfo, logger } from "../../logger";
import { addDays, dateToISO, isoToDate, todayISO, type ISODate } from "@/lib/dates";
import { BcbUnavailableError, fetchSgsSeries, type FetchLike } from "../bcb/sgs";

/**
 * Câmbio: cotação PTAX (venda) do Banco Central por dia útil. Contas em moeda estrangeira guardam
 * lançamentos e saldo na própria moeda; os totais em reais usam a cotação (com a data informada).
 * Fim de semana/feriado: vale a última cotação publicada até a data.
 */

/** Moedas aceitas nas contas e a série PTAX (venda) no SGS. */
export const FX_SERIES: Record<string, number> = { USD: 1, EUR: 21619, GBP: 21623 };
export const SUPPORTED_CURRENCIES = ["BRL", ...Object.keys(FX_SERIES)] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export function isForeign(currency: string | null | undefined): boolean {
  return Boolean(currency && currency !== "BRL");
}

/** Cotação (reais por unidade) em vigor na data: a última publicada até ela. */
export async function rateOn(currency: string, date: ISODate, db: Db = prisma): Promise<{ rate: number; date: ISODate } | null> {
  if (!isForeign(currency)) return { rate: 1, date };
  const row = await db.exchangeRate.findFirst({ where: { currency, date: { lte: isoToDate(date) } }, orderBy: { date: "desc" }, select: { rateBrl: true, date: true } });
  return row ? { rate: Number(row.rateBrl), date: dateToISO(row.date) } : null;
}

export async function latestRates(currencies: string[], db: Db = prisma): Promise<Map<string, { rate: number; date: ISODate }>> {
  const out = new Map<string, { rate: number; date: ISODate }>();
  for (const c of [...new Set(currencies)].filter(isForeign)) {
    const row = await db.exchangeRate.findFirst({ where: { currency: c }, orderBy: { date: "desc" }, select: { rateBrl: true, date: true } });
    if (row) out.set(c, { rate: Number(row.rateBrl), date: dateToISO(row.date) });
  }
  return out;
}

/** Valor em reais (centavos) pela cotação da data; null quando ainda não há cotação. */
export async function toBrlCents(amountCents: number, currency: string, date: ISODate, db: Db = prisma): Promise<number | null> {
  if (!isForeign(currency)) return amountCents;
  const r = await rateOn(currency, date, db);
  return r ? Math.round(amountCents * r.rate) : null;
}

/** Busca as cotações que faltam das moedas em uso (desde o lançamento mais antigo). Falha → tenta depois. */
export async function refreshFxRates(opts: { now?: Date; fetchImpl?: FetchLike } = {}) {
  const used = await prisma.account.findMany({ where: { currency: { not: "BRL" } }, select: { currency: true, initialBalanceDate: true } });
  const errors: string[] = [];
  let fetched = 0;
  const today = todayISO("America/Sao_Paulo", opts.now);
  const byCurrency = new Map<string, ISODate>();
  for (const a of used) {
    if (!FX_SERIES[a.currency]) continue;
    const from = dateToISO(a.initialBalanceDate);
    const oldestTx = await prisma.transaction.findFirst({ where: { currency: a.currency }, orderBy: { date: "asc" }, select: { date: true } });
    const start = [from, oldestTx ? dateToISO(oldestTx.date) : from].sort()[0]!;
    // Alguns dias antes, para ter a cotação vigente no início (fim de semana/feriado).
    const withMargin = addDays(start, -7);
    if (!byCurrency.has(a.currency) || withMargin < byCurrency.get(a.currency)!) byCurrency.set(a.currency, withMargin);
  }
  for (const [currency, from] of byCurrency) {
    const agg = await prisma.exchangeRate.aggregate({ where: { currency }, _min: { date: true }, _max: { date: true } });
    const ranges: Array<[ISODate, ISODate]> = [];
    if (!agg._min.date || !agg._max.date) ranges.push([from, today]);
    else {
      const first = dateToISO(agg._min.date);
      const last = dateToISO(agg._max.date);
      if (from < first) ranges.push([from, addDays(first, -1)]);
      if (addDays(last, 1) <= today) ranges.push([addDays(last, 1), today]);
    }
    for (const [a, b] of ranges) {
      try {
        const rows = await fetchSgsSeries(FX_SERIES[currency]!, a, b, opts.fetchImpl);
        if (rows.length) {
          const res = await prisma.exchangeRate.createMany({ data: rows.map((r) => ({ currency, date: isoToDate(r.date), rateBrl: new Prisma.Decimal(r.value) })), skipDuplicates: true });
          fetched += res.count;
        }
      } catch (err) {
        errors.push(`${currency}: ${err instanceof BcbUnavailableError ? err.message : "falha ao buscar a cotação."}`);
        logger.warn({ currency, err: errorInfo(err).message }, "câmbio: cotação PTAX indisponível — nova tentativa na próxima execução");
      }
    }
  }
  return { fetched, errors };
}

/** Preenche o valor em reais de receitas/despesas em moeda estrangeira lançadas sem cotação. */
export async function backfillBrlAmounts(): Promise<number> {
  const missing = await prisma.transaction.findMany({
    where: { currency: { not: "BRL" }, amountBrlCents: null, type: { in: ["INCOME", "EXPENSE", "ADJUSTMENT"] } },
    select: { id: true, amountCents: true, currency: true, date: true },
    take: 2000,
  });
  let filled = 0;
  for (const t of missing) {
    const brl = await toBrlCents(t.amountCents, t.currency, dateToISO(t.date));
    if (brl === null) continue;
    await prisma.transaction.update({ where: { id: t.id }, data: { amountBrlCents: brl } });
    filled++;
  }
  return filled;
}

/** Tarefa periódica do worker. */
export async function runFxJobs(now: Date = new Date()) {
  const rates = await refreshFxRates({ now });
  const filled = await backfillBrlAmounts();
  return { ratesFetched: rates.fetched, rateErrors: rates.errors.length, filled };
}

// -----------------------------------------------------------------------------
// Variação cambial de uma conta em moeda estrangeira
// -----------------------------------------------------------------------------

/**
 * Quanto do valor em reais da conta vem só da cotação: valor hoje (saldo × cotação atual) menos o
 * custo em reais dos movimentos (cada um pela cotação da data; transferência vinda de conta em reais
 * pelo valor efetivamente pago). Não é receita nem despesa.
 */
export async function fxVariation(account: { id: string; currency: string; initialBalanceCents: number; initialBalanceDate: Date }, balanceCents: number) {
  if (!isForeign(account.currency)) return null;
  const now = await latestRates([account.currency]);
  const current = now.get(account.currency);
  if (!current) return null;
  const entries = await prisma.ledgerEntry.findMany({
    where: { accountId: account.id },
    select: {
      amountCents: true,
      date: true,
      kind: true,
      transaction: { select: { type: true, amountCents: true, currency: true, destinationAmountCents: true, destinationAccount: { select: { currency: true } } } },
    },
  });
  let cost = 0;
  let missing = false;
  const initial = await toBrlCents(account.initialBalanceCents, account.currency, dateToISO(account.initialBalanceDate));
  if (initial === null && account.initialBalanceCents) missing = true;
  cost += initial ?? 0;
  for (const e of entries) {
    const t = e.transaction;
    const crossCurrency = t.type === "TRANSFER" && t.destinationAmountCents !== null;
    // Transferência com conta em reais: o custo é o valor em reais efetivamente pago/recebido.
    if (crossCurrency && e.kind === "TRANSFER_IN" && t.currency === "BRL") {
      cost += t.amountCents;
      continue;
    }
    if (crossCurrency && e.kind === "TRANSFER_OUT" && t.destinationAccount?.currency === "BRL") {
      cost -= t.destinationAmountCents!;
      continue;
    }
    const brl = await toBrlCents(e.amountCents, account.currency, dateToISO(e.date));
    if (brl === null) missing = true;
    cost += brl ?? 0;
  }
  const valueBrl = Math.round(balanceCents * current.rate);
  return { valueBrlCents: valueBrl, costBrlCents: cost, variationBrlCents: valueBrl - cost, rate: current.rate, rateDate: current.date, incomplete: missing };
}
