import { describe, expect, it } from "vitest";
import { extractAgendaTime, parseAgendaCommand } from "@/server/ai/engine/agenda-commands";
import { zonedToInstant, timeInTimezone } from "@/lib/dates";

const TODAY = "2026-10-20"; // terça-feira

describe("agenda pelo WhatsApp", () => {
  it("marca compromisso com data e hora em vários jeitos de falar", () => {
    expect(parseAgendaCommand("marca dentista amanhã às 15h", TODAY)).toEqual({ kind: "CREATE", title: "Dentista", date: "2026-10-21", time: "15:00" });
    expect(parseAgendaCommand("Agendar reunião da escola dia 25 às 19:30", TODAY)).toEqual({ kind: "CREATE", title: "Reunião da escola", date: "2026-10-25", time: "19:30" });
    expect(parseAgendaCommand("lembrete pagar o IPVA sexta", TODAY)).toEqual({ kind: "CREATE", title: "Pagar o IPVA", date: "2026-10-23", time: null });
    expect(parseAgendaCommand("marcar vacina do Pedro 05/11 8 da manhã", TODAY)).toEqual({ kind: "CREATE", title: "Vacina do Pedro", date: "2026-11-05", time: "08:00" });
    expect(parseAgendaCommand("me lembra de buscar a Ana na escola hoje às 5 da tarde", TODAY)).toEqual({ kind: "CREATE", title: "Buscar a Ana na escola", date: "2026-10-20", time: "17:00" });
    expect(parseAgendaCommand("marca almoço com a sogra domingo meio dia", TODAY)).toEqual({ kind: "CREATE", title: "Almoço com a sogra", date: "2026-10-25", time: "12:00" });
    expect(parseAgendaCommand("marca corte de cabelo dia 3", TODAY)).toMatchObject({ date: "2026-11-03" });
    expect(parseAgendaCommand("agenda médico na terça 9h30", TODAY)).toMatchObject({ title: "Médico", date: "2026-10-27", time: "09:30" });
  });

  it("não confunde com lançamento nem com frase sem data/hora", () => {
    expect(parseAgendaCommand("marca 50 reais no mercado hoje", TODAY)).toBeNull();
    expect(parseAgendaCommand("marca dentista", TODAY)).toBeNull();
    expect(parseAgendaCommand("gastei 30 na padaria amanhã", TODAY)).toBeNull();
    expect(parseAgendaCommand("marca amanhã 15h", TODAY)).toBeNull();
  });

  it("consulta e desmarcar", () => {
    expect(parseAgendaCommand("agenda de hoje", TODAY)).toEqual({ kind: "LIST", start: TODAY, days: 1, label: "de hoje" });
    expect(parseAgendaCommand("o que tenho amanhã?", TODAY)).toEqual({ kind: "LIST", start: "2026-10-21", days: 1, label: "de amanhã" });
    expect(parseAgendaCommand("Agenda da semana", TODAY)).toMatchObject({ kind: "LIST", days: 7 });
    expect(parseAgendaCommand("agenda", TODAY)).toMatchObject({ kind: "LIST", days: 1 });
    expect(parseAgendaCommand("desmarcar dentista", TODAY)).toEqual({ kind: "DELETE", title: "dentista" });
    expect(parseAgendaCommand("cancela a reunião da escola", TODAY)).toEqual({ kind: "DELETE", title: "escola" });
  });

  it("horas e fuso", () => {
    expect(extractAgendaTime("as 7 da noite")).toMatchObject({ time: "19:00" });
    expect(extractAgendaTime("15h e meia")).toMatchObject({ time: "15:30" });
    const at = zonedToInstant("2026-10-21", "15:00", "America/Recife");
    expect(at.toISOString()).toBe("2026-10-21T18:00:00.000Z");
    expect(timeInTimezone(at, "America/Recife")).toBe("15:00");
    expect(zonedToInstant("2026-03-08", "10:00", "America/New_York").toISOString()).toBe("2026-03-08T14:00:00.000Z");
  });
});
