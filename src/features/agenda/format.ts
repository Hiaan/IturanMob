import { addDays, formatDayMonthBR, weekday } from "@/lib/dates";
import type { AppointmentDTO } from "./types";

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

/** "Hoje", "Amanhã", "Ontem" ou "qua, 22/10". */
export function dayLabel(iso: string, today: string): string {
  if (iso === today) return "Hoje";
  if (iso === addDays(today, 1)) return "Amanhã";
  if (iso === addDays(today, -1)) return "Ontem";
  return `${WEEKDAY_SHORT[weekday(iso)]}, ${formatDayMonthBR(iso)}`;
}

/** "15:00", "15:00–16:00" ou "Dia todo". */
export function timeLabel(a: Pick<AppointmentDTO, "time" | "endTime" | "allDay">): string {
  if (a.allDay || !a.time) return "Dia todo";
  return a.endTime ? `${a.time}–${a.endTime}` : a.time;
}

/** Duração curta: 15 min, 1 h, 1 h 30 min, 1 dia, 2 dias. */
export function durationLabel(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} ${d === 1 ? "dia" : "dias"}`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

/** "Aviso 1 h antes", "Aviso na hora" ou null (sem lembrete). */
export function reminderLabel(minutes: number | null): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (minutes === 0) return "Aviso na hora";
  return `Aviso ${durationLabel(minutes)} antes`;
}

/** Opções do campo Lembrete ("none" = sem lembrete). */
export const REMINDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "none", label: "Sem lembrete" },
  { value: "15", label: "15 min antes" },
  { value: "30", label: "30 min antes" },
  { value: "60", label: "1 h antes" },
  { value: "120", label: "2 h antes" },
  { value: "1440", label: "1 dia antes" },
];

/** Agrupa por data, na ordem em que vieram (a API já ordena por início). */
export function groupByDay(items: AppointmentDTO[]): Array<{ date: string; items: AppointmentDTO[] }> {
  const groups: Array<{ date: string; items: AppointmentDTO[] }> = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === it.date) last.items.push(it);
    else groups.push({ date: it.date, items: [it] });
  }
  return groups;
}
