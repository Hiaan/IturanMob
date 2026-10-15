/**
 * Datas de calendário como strings ISO "YYYY-MM-DD" (sem fuso).
 * No banco, campos @db.Date são representados como Date à meia-noite UTC do dia.
 * O "hoje" é sempre calculado no fuso da família (padrão America/Recife).
 */

export const DEFAULT_TIMEZONE = "America/Recife";

export type ISODate = string; // "YYYY-MM-DD"
export type MonthKey = string; // "YYYY-MM"

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

export const MONTH_SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;

export const WEEKDAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"] as const;

export function isISODate(value: unknown): value is ISODate {
  if (typeof value !== "string") return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d);
}

function parts(iso: ISODate): [number, number, number] {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`Data inválida: ${iso}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

export function makeISO(year: number, month: number, day: number): ISODate {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Data ISO → Date (meia-noite UTC), formato usado em colunas @db.Date. */
export function isoToDate(iso: ISODate): Date {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Date (meia-noite UTC de colunas @db.Date) → data ISO. */
export function dateToISO(date: Date | string): ISODate {
  if (typeof date === "string") return date.slice(0, 10);
  return makeISO(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Data ISO do instante informado no fuso desejado. */
export function instantToISO(instant: Date, timeZone: string = DEFAULT_TIMEZONE): ISODate {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(instant);
}

/** "Hoje" no fuso da família. */
export function todayISO(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): ISODate {
  return instantToISO(now, timeZone);
}

/** Hora (0-23) atual no fuso. */
export function hourInTimezone(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" });
  return Number(fmt.format(now));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(iso: ISODate, days: number): ISODate {
  const d = isoToDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return dateToISO(d);
}

/** Soma meses preservando o dia quando possível (31/01 + 1 mês → 28/02 ou 29/02). */
export function addMonths(iso: ISODate, months: number, preferredDay?: number): ISODate {
  const [y, m, d] = parts(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(preferredDay ?? d, daysInMonth(ny, nm));
  return makeISO(ny, nm, day);
}

export function addYears(iso: ISODate, years: number): ISODate {
  return addMonths(iso, years * 12);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((isoToDate(a).getTime() - isoToDate(b).getTime()) / 86_400_000);
}

export function compareISO(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minISO(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxISO(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

export function monthKey(iso: ISODate): MonthKey {
  return iso.slice(0, 7);
}

export function monthKeyFromParts(year: number, month: number): MonthKey {
  return `${pad(year, 4)}-${pad(month)}`;
}

export function isMonthKey(value: unknown): value is MonthKey {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function startOfMonth(iso: ISODate): ISODate {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso: ISODate): ISODate {
  const [y, m] = parts(iso);
  return makeISO(y, m, daysInMonth(y, m));
}

export function monthRange(key: MonthKey): { start: ISODate; end: ISODate } {
  const start = `${key}-01`;
  return { start, end: endOfMonth(start) };
}

export function addMonthsToKey(key: MonthKey, months: number): MonthKey {
  return monthKey(addMonths(`${key}-01`, months));
}

export function startOfYear(iso: ISODate): ISODate {
  return `${iso.slice(0, 4)}-01-01`;
}

export function endOfYear(iso: ISODate): ISODate {
  return `${iso.slice(0, 4)}-12-31`;
}

/** Dia da semana (0 = domingo). */
export function weekday(iso: ISODate): number {
  return isoToDate(iso).getUTCDay();
}

/** Início da semana (segunda-feira). */
export function startOfWeek(iso: ISODate): ISODate {
  const wd = weekday(iso);
  const diff = wd === 0 ? -6 : 1 - wd;
  return addDays(iso, diff);
}

export function endOfWeek(iso: ISODate): ISODate {
  return addDays(startOfWeek(iso), 6);
}

/** Lista de chaves de mês entre dois meses (inclusive). */
export function monthsBetween(startKey: MonthKey, endKey: MonthKey): MonthKey[] {
  const result: MonthKey[] = [];
  let k = startKey;
  let guard = 0;
  while (k <= endKey && guard++ < 600) {
    result.push(k);
    k = addMonthsToKey(k, 1);
  }
  return result;
}

/** Lista de dias entre duas datas (inclusive). */
export function daysBetween(start: ISODate, end: ISODate): ISODate[] {
  const result: ISODate[] = [];
  let d = start;
  let guard = 0;
  while (d <= end && guard++ < 4000) {
    result.push(d);
    d = addDays(d, 1);
  }
  return result;
}

/** dd/mm/aaaa */
export function formatDateBR(iso: ISODate | Date | null | undefined): string {
  if (!iso) return "—";
  const s = typeof iso === "string" ? iso.slice(0, 10) : dateToISO(iso);
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
}

/** dd/mm */
export function formatDayMonthBR(iso: ISODate): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}`;
}

/** "15 de outubro" */
export function formatLongDateBR(iso: ISODate, withYear = false): string {
  const [y, m, d] = parts(iso.slice(0, 10));
  return `${d} de ${MONTH_NAMES[m - 1]}${withYear ? ` de ${y}` : ""}`;
}

/** "outubro de 2026" */
export function formatMonthBR(key: MonthKey, opts?: { short?: boolean; capitalize?: boolean }): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const name = opts?.short ? `${MONTH_SHORT[m - 1]}/${String(y).slice(2)}` : `${MONTH_NAMES[m - 1]} de ${y}`;
  return opts?.capitalize ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** Data e hora no fuso informado: "15/10/2026 14:32". */
export function formatDateTimeBR(instant: Date | string | null | undefined, timeZone: string = DEFAULT_TIMEZONE): string {
  if (!instant) return "—";
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Converte "dd/mm/aaaa" ou "dd/mm/aa" ou "aaaa-mm-dd" em ISO. */
export function parseBRDate(input: string): ISODate | null {
  const s = input.trim();
  if (isISODate(s.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const iso = makeISO(year, Number(m[2]), Number(m[1]));
  return isISODate(iso) ? iso : null;
}

// -----------------------------------------------------------------------------
// Períodos (filtros)
// -----------------------------------------------------------------------------

export type PeriodPreset =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thisWeek"
  | "thisMonth"
  | "lastMonth"
  | "last3Months"
  | "last6Months"
  | "last12Months"
  | "thisYear"
  | "lastYear"
  | "custom";

export const PERIOD_PRESET_LABELS: Record<PeriodPreset, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  last7: "Últimos 7 dias",
  last30: "Últimos 30 dias",
  thisWeek: "Esta semana",
  thisMonth: "Este mês",
  lastMonth: "Mês anterior",
  last3Months: "Últimos 3 meses",
  last6Months: "Últimos 6 meses",
  last12Months: "Últimos 12 meses",
  thisYear: "Este ano",
  lastYear: "Ano anterior",
  custom: "Personalizado",
};

export interface Period {
  start: ISODate;
  end: ISODate;
}

export function resolvePeriod(preset: PeriodPreset, today: ISODate, custom?: Partial<Period>): Period {
  switch (preset) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: y, end: y };
    }
    case "last7":
      return { start: addDays(today, -6), end: today };
    case "last30":
      return { start: addDays(today, -29), end: today };
    case "thisWeek":
      return { start: startOfWeek(today), end: endOfWeek(today) };
    case "thisMonth":
      return { start: startOfMonth(today), end: endOfMonth(today) };
    case "lastMonth": {
      const prev = addMonths(startOfMonth(today), -1);
      return { start: prev, end: endOfMonth(prev) };
    }
    case "last3Months":
      return { start: addMonths(startOfMonth(today), -2), end: endOfMonth(today) };
    case "last6Months":
      return { start: addMonths(startOfMonth(today), -5), end: endOfMonth(today) };
    case "last12Months":
      return { start: addMonths(startOfMonth(today), -11), end: endOfMonth(today) };
    case "thisYear":
      return { start: startOfYear(today), end: endOfYear(today) };
    case "lastYear": {
      const prev = addYears(startOfYear(today), -1);
      return { start: prev, end: endOfYear(prev) };
    }
    case "custom": {
      const start = custom?.start && isISODate(custom.start) ? custom.start : startOfMonth(today);
      const end = custom?.end && isISODate(custom.end) ? custom.end : endOfMonth(today);
      return start <= end ? { start, end } : { start: end, end: start };
    }
  }
}

/** Período imediatamente anterior, com a mesma duração (para comparativos). */
export function previousPeriod(period: Period): Period {
  const isFullMonth = period.start === startOfMonth(period.start) && period.end === endOfMonth(period.start);
  if (isFullMonth) {
    const prev = addMonths(period.start, -1);
    return { start: prev, end: endOfMonth(prev) };
  }
  const len = diffDays(period.end, period.start) + 1;
  const end = addDays(period.start, -1);
  return { start: addDays(end, -(len - 1)), end };
}

export function describePeriod(period: Period): string {
  if (period.start === period.end) return formatDateBR(period.start);
  if (period.start === startOfMonth(period.start) && period.end === endOfMonth(period.start)) {
    return formatMonthBR(monthKey(period.start));
  }
  return `${formatDateBR(period.start)} a ${formatDateBR(period.end)}`;
}
