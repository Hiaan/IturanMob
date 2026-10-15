import { addDays, addMonths, diffDays, formatDateBR, type ISODate } from "@/lib/dates";

/**
 * Regras de recorrência (funções puras, sem acesso a banco).
 *
 * - WEEKLY / BIWEEKLY / CUSTOM_DAYS: a cada 7, 14 ou `interval` dias a partir de `startDate`.
 * - MONTHLY / QUARTERLY / SEMIANNUAL / YEARLY / CUSTOM_MONTHS: a cada 1, 3, 6, 12 ou `interval`
 *   meses, no dia `dayOfMonth` (padrão: o dia de `startDate`), ajustado ao último dia quando o
 *   mês é mais curto (31 → 30/28/29). O ciclo começa no mês de `startDate`; se o dia já passou
 *   naquele mês, a primeira ocorrência é no ciclo seguinte.
 * - `startDate` e `endDate` são inclusivos.
 */
export const RECURRENCE_FREQUENCIES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY", "CUSTOM_DAYS", "CUSTOM_MONTHS"] as const;
export type RecurrenceFrequencyValue = (typeof RECURRENCE_FREQUENCIES)[number];

export interface RecurrenceRule {
  frequency: RecurrenceFrequencyValue;
  /** Intervalo das frequências personalizadas (dias ou meses). Ignorado nas demais. */
  interval?: number | null;
  /** Dia do mês (1..31) das frequências mensais; padrão = dia de `startDate`. */
  dayOfMonth?: number | null;
  startDate: ISODate;
  endDate?: ISODate | null;
}

interface Step {
  unit: "day" | "month";
  size: number;
}

/** Média de dias por mês (365,25 / 12), usada para equivalências mensais. */
export const AVERAGE_DAYS_PER_MONTH = 365.25 / 12;

function safeInterval(interval: number | null | undefined): number {
  const n = Math.trunc(interval ?? 1);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function recurrenceStep(rule: Pick<RecurrenceRule, "frequency" | "interval">): Step {
  switch (rule.frequency) {
    case "WEEKLY":
      return { unit: "day", size: 7 };
    case "BIWEEKLY":
      return { unit: "day", size: 14 };
    case "CUSTOM_DAYS":
      return { unit: "day", size: safeInterval(rule.interval) };
    case "MONTHLY":
      return { unit: "month", size: 1 };
    case "QUARTERLY":
      return { unit: "month", size: 3 };
    case "SEMIANNUAL":
      return { unit: "month", size: 6 };
    case "YEARLY":
      return { unit: "month", size: 12 };
    case "CUSTOM_MONTHS":
      return { unit: "month", size: safeInterval(rule.interval) };
  }
}

function monthIndex(iso: ISODate): number {
  return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
}

/**
 * Datas de ocorrência entre `fromISO` e `toISO` (inclusive), respeitando `startDate` e `endDate`.
 * `limit` protege contra intervalos muito longos.
 */
export function occurrencesBetween(rule: RecurrenceRule, fromISO: ISODate, toISO: ISODate, limit = 1000): ISODate[] {
  const start = rule.startDate;
  const upper = rule.endDate && rule.endDate < toISO ? rule.endDate : toISO;
  const lower = fromISO > start ? fromISO : start;
  if (lower > upper || limit <= 0) return [];

  const step = recurrenceStep(rule);
  const result: ISODate[] = [];

  if (step.unit === "day") {
    let k = Math.max(0, Math.ceil(diffDays(lower, start) / step.size));
    for (;;) {
      const date = addDays(start, k * step.size);
      if (date > upper || result.length >= limit) break;
      if (date >= lower) result.push(date);
      k++;
    }
    return result;
  }

  const day = rule.dayOfMonth && rule.dayOfMonth >= 1 && rule.dayOfMonth <= 31 ? rule.dayOfMonth : Number(start.slice(8, 10));
  const anchor = `${start.slice(0, 7)}-01`;
  // Começa um ciclo antes do mês de `lower` para não perder ocorrências no limite.
  let k = Math.max(0, Math.floor((monthIndex(lower) - monthIndex(anchor)) / step.size) - 1);
  for (let guard = 0; guard < 100_000; guard++) {
    const date = addMonths(anchor, k * step.size, day);
    k++;
    if (date < lower) continue;
    if (date > upper || result.length >= limit) break;
    result.push(date);
  }
  return result;
}

/** Próxima ocorrência a partir de `onOrAfter` (inclusive), ou null se a recorrência já terminou. */
export function nextOccurrence(rule: RecurrenceRule, onOrAfter: ISODate): ISODate | null {
  const step = recurrenceStep(rule);
  const from = onOrAfter > rule.startDate ? onOrAfter : rule.startDate;
  const horizon = step.unit === "day" ? addDays(from, step.size + 1) : addMonths(from, step.size + 1);
  return occurrencesBetween(rule, from, horizon, 1)[0] ?? null;
}

/** Valor mensal equivalente (ex.: semanal de R$ 100 ≈ R$ 434,82/mês). */
export function monthlyEquivalentCents(amountCents: number, rule: Pick<RecurrenceRule, "frequency" | "interval">): number {
  const step = recurrenceStep(rule);
  if (step.unit === "day") return Math.round((amountCents * AVERAGE_DAYS_PER_MONTH) / step.size);
  return Math.round(amountCents / step.size);
}

/** Descrição curta da frequência em português (ex.: "Mensal, todo dia 5"). */
export function describeRecurrence(rule: RecurrenceRule): string {
  const interval = safeInterval(rule.interval);
  const day = rule.dayOfMonth ?? Number(rule.startDate.slice(8, 10));
  let text: string;
  switch (rule.frequency) {
    case "WEEKLY":
      text = "Semanal";
      break;
    case "BIWEEKLY":
      text = "Quinzenal";
      break;
    case "CUSTOM_DAYS":
      text = interval === 1 ? "Diária" : `A cada ${interval} dias`;
      break;
    case "MONTHLY":
      text = `Mensal, todo dia ${day}`;
      break;
    case "QUARTERLY":
      text = `Trimestral, dia ${day}`;
      break;
    case "SEMIANNUAL":
      text = `Semestral, dia ${day}`;
      break;
    case "YEARLY":
      text = `Anual, em ${String(day).padStart(2, "0")}/${rule.startDate.slice(5, 7)}`;
      break;
    case "CUSTOM_MONTHS":
      text = interval === 1 ? `Mensal, todo dia ${day}` : `A cada ${interval} meses, dia ${day}`;
      break;
  }
  if (rule.endDate) text += ` (até ${formatDateBR(rule.endDate)})`;
  return text;
}
