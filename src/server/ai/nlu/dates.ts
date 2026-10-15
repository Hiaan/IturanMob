import {
  addDays,
  addMonths,
  addYears,
  endOfMonth,
  endOfWeek,
  endOfYear,
  isISODate,
  makeISO,
  monthKey,
  startOfMonth,
  startOfWeek,
  startOfYear,
  weekday,
  type ISODate,
  type Period,
} from "@/lib/dates";
import { normalizeForNlu } from "./text";
import { spelledToNumber } from "./numbers";

const MONTHS: Record<string, number> = {
  janeiro: 1,
  jan: 1,
  fevereiro: 2,
  fev: 2,
  marco: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  maio: 5,
  mai: 5,
  junho: 6,
  jun: 6,
  julho: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  setembro: 9,
  set: 9,
  outubro: 10,
  out: 10,
  novembro: 11,
  nov: 11,
  dezembro: 12,
  dez: 12,
};
const MONTH_FULL = Object.keys(MONTHS).filter((m) => m.length > 3);

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

export interface DateMention {
  date: ISODate;
  /** A data foi informada (não é o padrão "hoje"). */
  explicit: boolean;
  raw: string | null;
}

/** Data mais recente (<= hoje) para o dia da semana informado. */
function lastWeekday(today: ISODate, target: number, forcePrevious: boolean): ISODate {
  const cur = weekday(today);
  let diff = (cur - target + 7) % 7;
  if (diff === 0 && forcePrevious) diff = 7;
  return addDays(today, -diff);
}

/** Extrai a data de ocorrência de uma mensagem. Sem menção → hoje (explicit=false). */
export function extractDate(input: string, today: ISODate): DateMention {
  const t = normalizeForNlu(input);

  // dd/mm(/aaaa)
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (numeric) {
    const d = Number(numeric[1]);
    const m = Number(numeric[2]);
    let y = numeric[3] ? Number(numeric[3]) : Number(today.slice(0, 4));
    if (y < 100) y += 2000;
    let iso = makeISO(y, m, d);
    if (isISODate(iso)) {
      if (!numeric[3] && iso > addDays(today, 7)) iso = makeISO(y - 1, m, d);
      return { date: iso, explicit: true, raw: numeric[0] };
    }
  }

  // "5 de outubro", "dia 12 de setembro"
  const longForm = new RegExp(`\\b(?:dia\\s+)?(\\d{1,2})\\s+de\\s+(${MONTH_FULL.join("|")})(?:\\s+de\\s+(\\d{4}))?\\b`).exec(t);
  if (longForm) {
    const d = Number(longForm[1]);
    const m = MONTHS[longForm[2]!]!;
    let y = longForm[3] ? Number(longForm[3]) : Number(today.slice(0, 4));
    let iso = makeISO(y, m, d);
    if (isISODate(iso)) {
      if (!longForm[3] && iso > addDays(today, 7)) {
        y -= 1;
        iso = makeISO(y, m, d);
      }
      return { date: iso, explicit: true, raw: longForm[0] };
    }
  }

  if (/\banteontem\b/.test(t)) return { date: addDays(today, -2), explicit: true, raw: "anteontem" };
  if (/\bontem\b/.test(t)) return { date: addDays(today, -1), explicit: true, raw: "ontem" };
  if (/\bamanha\b/.test(t)) return { date: addDays(today, 1), explicit: true, raw: "amanhã" };
  if (/\bhoje\b|\bagora\b|\bhj\b/.test(t)) return { date: today, explicit: true, raw: "hoje" };

  // "segunda passada", "na sexta", "sabado"
  const wd = /\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:[\s-]+feira)?(\s+passad[oa])?\b/.exec(t);
  if (wd) {
    const target = WEEKDAYS[wd[1]!]!;
    return { date: lastWeekday(today, target, Boolean(wd[2])), explicit: true, raw: wd[0] };
  }

  // "dia 5"
  const day = /\bdia\s+(\d{1,2})\b/.exec(t);
  if (day) {
    const d = Number(day[1]);
    const [y, m] = today.split("-").map(Number) as [number, number];
    let iso = makeISO(y, m, d);
    if (isISODate(iso)) {
      if (iso > today) iso = addMonths(makeISO(y, m, 1), -1, d);
      return { date: iso, explicit: true, raw: day[0] };
    }
  }

  if (/\bsemana passada\b/.test(t)) return { date: addDays(today, -7), explicit: true, raw: "semana passada" };
  return { date: today, explicit: false, raw: null };
}

// -----------------------------------------------------------------------------
// Períodos para consultas
// -----------------------------------------------------------------------------

export interface PeriodMention {
  period: Period;
  label: string;
}

function monthPeriod(y: number, m: number): PeriodMention {
  const start = makeISO(y, m, 1);
  const names = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  return { period: { start, end: endOfMonth(start) }, label: `${names[m - 1]} de ${y}` };
}

/** Todos os meses mencionados por nome ("agosto e setembro"). */
function namedMonths(t: string, today: ISODate): PeriodMention[] {
  const re = new RegExp(`\\b(${MONTH_FULL.join("|")})(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`, "g");
  const result: PeriodMention[] = [];
  let m: RegExpExecArray | null;
  const curY = Number(today.slice(0, 4));
  const curM = Number(today.slice(5, 7));
  while ((m = re.exec(t))) {
    const month = MONTHS[m[1]!]!;
    // "marco" também é substantivo; só aceita se houver contexto de período.
    if (m[1] === "marco" && !/\b(em|de|no mes de|mes de)\s+marco\b/.test(t)) continue;
    let y = m[2] ? Number(m[2]) : curY;
    if (!m[2] && month > curM) y -= 1;
    result.push(monthPeriod(y, month));
  }
  return result;
}

/** Interpreta o período de uma consulta. Retorna lista (comparações têm dois períodos). */
export function extractPeriods(input: string, today: ISODate): PeriodMention[] {
  const t = normalizeForNlu(input);
  const months = namedMonths(t, today);
  if (months.length) return months;

  const lastN = /\bultim[oa]s?\s+(\d{1,3}|\p{L}+(?:\s+e\s+\p{L}+)?)\s+(dias|semanas|meses|anos)\b/u.exec(t);
  if (lastN) {
    const n = /^\d+$/.test(lastN[1]!) ? Number(lastN[1]) : spelledToNumber(lastN[1]!.split(" ")) ?? 1;
    const unit = lastN[2];
    if (unit === "dias") return [{ period: { start: addDays(today, -(n - 1)), end: today }, label: `últimos ${n} dias` }];
    if (unit === "semanas") return [{ period: { start: addDays(today, -(n * 7 - 1)), end: today }, label: `últimas ${n} semanas` }];
    if (unit === "meses") return [{ period: { start: addMonths(startOfMonth(today), -(n - 1)), end: endOfMonth(today) }, label: `últimos ${n} meses` }];
    return [{ period: { start: addYears(startOfYear(today), -(n - 1)), end: endOfYear(today) }, label: `últimos ${n} anos` }];
  }
  if (/\bhoje\b/.test(t)) return [{ period: { start: today, end: today }, label: "hoje" }];
  if (/\bontem\b/.test(t)) return [{ period: { start: addDays(today, -1), end: addDays(today, -1) }, label: "ontem" }];
  if (/\bsemana passada\b/.test(t)) {
    const s = addDays(startOfWeek(today), -7);
    return [{ period: { start: s, end: addDays(s, 6) }, label: "semana passada" }];
  }
  if (/\b(dess?a|dest?a|nest?a|ness?a)?\s*semana\b/.test(t)) return [{ period: { start: startOfWeek(today), end: endOfWeek(today) }, label: "esta semana" }];
  if (/\b(mes passado|ultimo mes|mes anterior)\b/.test(t)) {
    const s = addMonths(startOfMonth(today), -1);
    return [{ period: { start: s, end: endOfMonth(s) }, label: "o mês passado" }];
  }
  if (/\b(ano passado|ano anterior)\b/.test(t)) {
    const s = addYears(startOfYear(today), -1);
    return [{ period: { start: s, end: endOfYear(s) }, label: "o ano passado" }];
  }
  if (/\b(ess?e|est?e|nest?e|ness?e|no)\s+ano\b|\bno ano\b|\bano todo\b/.test(t)) return [{ period: { start: startOfYear(today), end: endOfYear(today) }, label: "este ano" }];
  if (/\btrimestre\b/.test(t)) return [{ period: { start: addMonths(startOfMonth(today), -2), end: endOfMonth(today) }, label: "os últimos 3 meses" }];
  if (/\bmes\b/.test(t)) return [{ period: { start: startOfMonth(today), end: endOfMonth(today) }, label: "este mês" }];
  return [];
}

export function defaultMonthPeriod(today: ISODate): PeriodMention {
  return { period: { start: startOfMonth(today), end: endOfMonth(today) }, label: "este mês" };
}

export { monthKey };
