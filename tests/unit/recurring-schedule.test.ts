import { describe, expect, it } from "vitest";
import { describeRecurrence, monthlyEquivalentCents, nextOccurrence, occurrencesBetween } from "@/server/modules/recurring/schedule";

describe("agenda de recorrências", () => {
  it("semanal a partir da data inicial", () => {
    const rule = { frequency: "WEEKLY" as const, startDate: "2026-10-01" };
    expect(occurrencesBetween(rule, "2026-10-01", "2026-10-31")).toEqual(["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]);
    // Janela começando no meio do ciclo
    expect(occurrencesBetween(rule, "2026-10-10", "2026-10-20")).toEqual(["2026-10-15"]);
  });

  it("quinzenal e a cada N dias", () => {
    expect(occurrencesBetween({ frequency: "BIWEEKLY", startDate: "2026-10-05" }, "2026-10-01", "2026-11-30")).toEqual([
      "2026-10-05",
      "2026-10-19",
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
    ]);
    expect(occurrencesBetween({ frequency: "CUSTOM_DAYS", interval: 10, startDate: "2026-10-01" }, "2026-10-12", "2026-11-05")).toEqual(["2026-10-21", "2026-10-31"]);
  });

  it("mensal com dia informado ajusta ao último dia do mês", () => {
    const rule = { frequency: "MONTHLY" as const, dayOfMonth: 31, startDate: "2026-01-01" };
    expect(occurrencesBetween(rule, "2026-01-01", "2026-05-31")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    // Ano bissexto
    expect(occurrencesBetween(rule, "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });

  it("mensal: se o dia já passou no mês inicial, começa no mês seguinte", () => {
    const rule = { frequency: "MONTHLY" as const, dayOfMonth: 5, startDate: "2026-10-20" };
    expect(occurrencesBetween(rule, "2026-10-01", "2026-12-31")).toEqual(["2026-11-05", "2026-12-05"]);
  });

  it("mensal usa o dia da data inicial quando o dia não é informado", () => {
    const rule = { frequency: "MONTHLY" as const, startDate: "2026-08-15" };
    expect(occurrencesBetween(rule, "2026-10-01", "2026-12-31")).toEqual(["2026-10-15", "2026-11-15", "2026-12-15"]);
  });

  it("trimestral, semestral, anual e a cada N meses", () => {
    expect(occurrencesBetween({ frequency: "QUARTERLY", dayOfMonth: 10, startDate: "2026-01-10" }, "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-10",
      "2026-04-10",
      "2026-07-10",
      "2026-10-10",
    ]);
    expect(occurrencesBetween({ frequency: "SEMIANNUAL", startDate: "2026-03-20" }, "2026-01-01", "2027-12-31")).toEqual([
      "2026-03-20",
      "2026-09-20",
      "2027-03-20",
      "2027-09-20",
    ]);
    expect(occurrencesBetween({ frequency: "YEARLY", startDate: "2024-02-29" }, "2025-01-01", "2028-12-31")).toEqual([
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
    expect(occurrencesBetween({ frequency: "CUSTOM_MONTHS", interval: 2, dayOfMonth: 30, startDate: "2026-01-01" }, "2026-01-01", "2026-06-30")).toEqual([
      "2026-01-30",
      "2026-03-30",
      "2026-05-30",
    ]);
  });

  it("respeita data final e janela fora do período", () => {
    const rule = { frequency: "MONTHLY" as const, dayOfMonth: 10, startDate: "2026-01-01", endDate: "2026-03-10" };
    expect(occurrencesBetween(rule, "2026-01-01", "2026-12-31")).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
    expect(occurrencesBetween(rule, "2026-04-01", "2026-12-31")).toEqual([]);
    expect(occurrencesBetween({ frequency: "WEEKLY", startDate: "2027-01-01" }, "2026-10-01", "2026-12-31")).toEqual([]);
    expect(occurrencesBetween({ frequency: "WEEKLY", startDate: "2026-01-01" }, "2026-12-31", "2026-10-01")).toEqual([]);
  });

  it("janela distante da data inicial é calculada sem iterar desde o início", () => {
    const rule = { frequency: "MONTHLY" as const, dayOfMonth: 1, startDate: "2000-01-01" };
    expect(occurrencesBetween(rule, "2026-10-02", "2026-12-31")).toEqual(["2026-11-01", "2026-12-01"]);
    expect(occurrencesBetween({ frequency: "WEEKLY", startDate: "2000-01-03" }, "2026-10-12", "2026-10-18")).toHaveLength(1);
  });

  it("limita a quantidade de ocorrências", () => {
    expect(occurrencesBetween({ frequency: "CUSTOM_DAYS", interval: 1, startDate: "2026-01-01" }, "2026-01-01", "2026-12-31", 5)).toHaveLength(5);
  });

  it("próxima ocorrência", () => {
    const rule = { frequency: "MONTHLY" as const, dayOfMonth: 10, startDate: "2026-01-10" };
    expect(nextOccurrence(rule, "2026-10-10")).toBe("2026-10-10");
    expect(nextOccurrence(rule, "2026-10-11")).toBe("2026-11-10");
    expect(nextOccurrence({ ...rule, endDate: "2026-10-10" }, "2026-10-11")).toBeNull();
    expect(nextOccurrence({ frequency: "YEARLY", startDate: "2026-12-25" }, "2026-01-01")).toBe("2026-12-25");
    expect(nextOccurrence({ frequency: "CUSTOM_MONTHS", interval: 12, startDate: "2020-05-01" }, "2026-05-02")).toBe("2027-05-01");
  });

  it("valor mensal equivalente", () => {
    expect(monthlyEquivalentCents(12_000, { frequency: "MONTHLY" })).toBe(12_000);
    expect(monthlyEquivalentCents(120_000, { frequency: "YEARLY" })).toBe(10_000);
    expect(monthlyEquivalentCents(30_000, { frequency: "QUARTERLY" })).toBe(10_000);
    expect(monthlyEquivalentCents(60_000, { frequency: "SEMIANNUAL" })).toBe(10_000);
    expect(monthlyEquivalentCents(20_000, { frequency: "CUSTOM_MONTHS", interval: 2 })).toBe(10_000);
    expect(monthlyEquivalentCents(10_000, { frequency: "WEEKLY" })).toBe(43_482);
    expect(monthlyEquivalentCents(10_000, { frequency: "BIWEEKLY" })).toBe(21_741);
    expect(monthlyEquivalentCents(10_000, { frequency: "CUSTOM_DAYS", interval: 30 })).toBe(10_146);
  });

  it("descrição da frequência", () => {
    expect(describeRecurrence({ frequency: "MONTHLY", dayOfMonth: 5, startDate: "2026-01-01" })).toBe("Mensal, todo dia 5");
    expect(describeRecurrence({ frequency: "YEARLY", startDate: "2026-03-15" })).toBe("Anual, em 15/03");
    expect(describeRecurrence({ frequency: "CUSTOM_DAYS", interval: 10, startDate: "2026-01-01", endDate: "2026-12-31" })).toBe("A cada 10 dias (até 31/12/2026)");
  });
});
