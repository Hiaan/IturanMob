import { TZDate } from "@date-fns/tz";
import { addDays, addMonthsToKey, daysInMonth, instantToISO, monthKey, monthRange, startOfWeek, weekday, type ISODate, type Period } from "@/lib/dates";

/**
 * Cálculo dos horários dos relatórios programados, sempre no fuso da família.
 * - Semanal: dia da semana (0 = domingo) e hora → relatório da semana anterior completa (seg–dom).
 * - Mensal: dia do mês (ajustado ao último dia) e hora → relatório do mês anterior completo.
 */

export interface ScheduleConfig {
  type: "WEEKLY" | "MONTHLY";
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
}

/** Instante (UTC) correspondente a uma data/hora local no fuso informado. */
export function zonedInstant(date: ISODate, hour: number, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(new TZDate(y, m - 1, d, hour, 0, 0, timeZone).getTime());
}

function candidates(cfg: ScheduleConfig, timeZone: string, now: Date): Date[] {
  const today = instantToISO(now, timeZone);
  const hour = Math.min(23, Math.max(0, cfg.hour));
  const result: Date[] = [];
  if (cfg.type === "WEEKLY") {
    const dow = cfg.dayOfWeek ?? 1;
    for (let i = -8; i <= 8; i++) {
      const date = addDays(today, i);
      if (weekday(date) === dow) result.push(zonedInstant(date, hour, timeZone));
    }
  } else {
    const dom = cfg.dayOfMonth ?? 1;
    for (let i = -2; i <= 2; i++) {
      const key = addMonthsToKey(monthKey(today), i);
      const [y, m] = key.split("-").map(Number) as [number, number];
      const day = Math.min(dom, daysInMonth(y, m));
      result.push(zonedInstant(`${key}-${String(day).padStart(2, "0")}`, hour, timeZone));
    }
  }
  return result.sort((a, b) => a.getTime() - b.getTime());
}

/** Próxima execução estritamente após `now`. */
export function nextOccurrence(cfg: ScheduleConfig, timeZone: string, now: Date = new Date()): Date {
  const next = candidates(cfg, timeZone, now).find((d) => d.getTime() > now.getTime());
  if (!next) throw new Error("Não foi possível calcular a próxima execução do relatório.");
  return next;
}

/** Execução mais recente que já deveria ter ocorrido (≤ now). */
export function latestOccurrence(cfg: ScheduleConfig, timeZone: string, now: Date = new Date()): Date {
  const past = candidates(cfg, timeZone, now).filter((d) => d.getTime() <= now.getTime());
  const last = past[past.length - 1];
  if (!last) throw new Error("Não foi possível calcular a última execução do relatório.");
  return last;
}

/** Semana anterior completa (segunda a domingo) em relação à data da execução. */
export function previousCompleteWeek(runDate: ISODate): Period {
  const start = addDays(startOfWeek(runDate), -7);
  return { start, end: addDays(start, 6) };
}

/** Mês anterior completo em relação à data da execução. */
export function previousCompleteMonth(runDate: ISODate): string {
  return addMonthsToKey(monthKey(runDate), -1);
}

export function reportPeriodForRun(type: "WEEKLY" | "MONTHLY", runInstant: Date, timeZone: string): Period {
  const runDate = instantToISO(runInstant, timeZone);
  return type === "WEEKLY" ? previousCompleteWeek(runDate) : monthRange(previousCompleteMonth(runDate));
}
