import { describe, expect, it } from "vitest";
import { dayLabel, durationLabel, groupByDay, reminderLabel, timeLabel } from "@/features/agenda/format";
import type { AppointmentDTO } from "@/features/agenda/types";

describe("agenda: rótulos da tela", () => {
  it("dia: Hoje, Amanhã e dia da semana", () => {
    expect(dayLabel("2026-10-20", "2026-10-20")).toBe("Hoje");
    expect(dayLabel("2026-10-21", "2026-10-20")).toBe("Amanhã");
    expect(dayLabel("2026-10-22", "2026-10-20")).toBe("qui, 22/10");
    expect(dayLabel("2026-10-25", "2026-10-20")).toBe("dom, 25/10");
  });

  it("hora e lembrete", () => {
    expect(timeLabel({ time: null, endTime: null, allDay: true })).toBe("Dia todo");
    expect(timeLabel({ time: "15:00", endTime: "16:30", allDay: false })).toBe("15:00–16:30");
    expect(reminderLabel(null)).toBeNull();
    expect(reminderLabel(0)).toBe("Aviso na hora");
    expect(reminderLabel(60)).toBe("Aviso 1 h antes");
    expect(reminderLabel(15)).toBe("Aviso 15 min antes");
    expect(reminderLabel(1440)).toBe("Aviso 1 dia antes");
    expect(durationLabel(90)).toBe("1 h 30 min");
    expect(durationLabel(2880)).toBe("2 dias");
  });

  it("agrupa por dia mantendo a ordem", () => {
    const mk = (id: string, date: string) => ({ id, date }) as AppointmentDTO;
    const g = groupByDay([mk("a", "2026-10-20"), mk("b", "2026-10-20"), mk("c", "2026-10-22")]);
    expect(g.map((x) => [x.date, x.items.map((i) => i.id)])).toEqual([
      ["2026-10-20", ["a", "b"]],
      ["2026-10-22", ["c"]],
    ]);
  });
});
