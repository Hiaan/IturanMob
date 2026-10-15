import { describe, expect, it } from "vitest";
import { extractDate, extractPeriods } from "@/server/ai/nlu/dates";

const today = "2026-10-15"; // quinta-feira

describe("NLU — datas", () => {
  it.each([
    ["gastei 45 na farmácia", "2026-10-15", false],
    ["hoje abasteci 150", "2026-10-15", true],
    ["ontem minha esposa gastou 78", "2026-10-14", true],
    ["anteontem paguei a luz", "2026-10-13", true],
    ["na segunda paguei 50", "2026-10-12", true],
    ["quinta passada gastei 10", "2026-10-08", true],
    ["dia 5 paguei 89,90", "2026-10-05", true],
    ["dia 20 paguei 89,90", "2026-09-20", true],
    ["05/10 mercado 200", "2026-10-05", true],
    ["12 de setembro recebi 300", "2026-09-12", true],
  ])("%s", (text, expected, explicit) => {
    const d = extractDate(text, today);
    expect(d.date).toBe(expected);
    expect(d.explicit).toBe(explicit);
  });
});

describe("NLU — períodos", () => {
  it("mês atual e anterior", () => {
    expect(extractPeriods("Quanto gastamos esse mês?", today)[0]!.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(extractPeriods("e no mês passado?", today)[0]!.period).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });
  it("meses por nome e comparações", () => {
    const p = extractPeriods("Compara nossos gastos de agosto e setembro.", today);
    expect(p.map((x) => x.period.start)).toEqual(["2026-08-01", "2026-09-01"]);
    expect(extractPeriods("Me mostra um resumo de setembro.", today)[0]!.period.end).toBe("2026-09-30");
    expect(extractPeriods("resumo de novembro", today)[0]!.period.start).toBe("2025-11-01");
  });
  it("últimos N", () => {
    expect(extractPeriods("Quanto gastamos em gasolina nos últimos seis meses?", today)[0]!.period).toEqual({ start: "2026-05-01", end: "2026-10-31" });
    expect(extractPeriods("média dos últimos três meses", today)[0]!.period.start).toBe("2026-08-01");
    expect(extractPeriods("últimos 7 dias", today)[0]!.period).toEqual({ start: "2026-10-09", end: "2026-10-15" });
  });
  it("semana e ano", () => {
    expect(extractPeriods("Qual foi nossa maior despesa da semana?", today)[0]!.period).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(extractPeriods("Quanto gastamos com nosso filho neste ano?", today)[0]!.period.start).toBe("2026-01-01");
  });
});
