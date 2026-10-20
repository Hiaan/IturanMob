import { describe, expect, it } from "vitest";
import { parseIncomeGoalCommand } from "@/server/ai/engine/income-goal-commands";
import { computeIncomeProgress, effectiveThresholds } from "@/server/modules/income-goals/service";
import { notificationPriority, notificationUrl } from "@/lib/notification-meta";

/** Meta de ganho pelo WhatsApp: criar/atualizar ("meta de ganho da empresa 30 mil") e perguntar. */
describe("parseIncomeGoalCommand", () => {
  it("define a meta com recorte e valor", () => {
    expect(parseIncomeGoalCommand("meta de ganho da empresa 30 mil")).toEqual({ kind: "SET", scope: "BUSINESS", targetCents: 3_000_000 });
    expect(parseIncomeGoalCommand("Meta de faturamento PJ 45k")).toEqual({ kind: "SET", scope: "BUSINESS", targetCents: 4_500_000 });
    expect(parseIncomeGoalCommand("minha meta de renda pessoal é 12 mil")).toEqual({ kind: "SET", scope: "PERSONAL", targetCents: 1_200_000 });
    expect(parseIncomeGoalCommand("meta de ganho R$ 20.000")).toEqual({ kind: "SET", scope: null, targetCents: 2_000_000 });
  });

  it("pergunta pela meta (com ou sem recorte)", () => {
    expect(parseIncomeGoalCommand("qual minha meta de ganho?")).toEqual({ kind: "QUERY", scope: null, generic: false });
    expect(parseIncomeGoalCommand("quanto falta pra meta de faturamento da empresa?")).toEqual({ kind: "QUERY", scope: "BUSINESS", generic: false });
    expect(parseIncomeGoalCommand("quanto falta pra meta?")).toEqual({ kind: "QUERY", scope: null, generic: true });
    expect(parseIncomeGoalCommand("Quanto falta para bater a meta")).toEqual({ kind: "QUERY", scope: null, generic: true });
    expect(parseIncomeGoalCommand("meta de ganho")).toEqual({ kind: "QUERY", scope: null, generic: false });
  });

  it("não confunde com lançamentos nem com metas de economia", () => {
    expect(parseIncomeGoalCommand("recebi 3000 de faturamento do cliente")).toBeNull();
    expect(parseIncomeGoalCommand("guardei 500 na meta viagem")).toBeNull();
    expect(parseIncomeGoalCommand("quanto falta pra meta viagem?")).toBeNull();
    expect(parseIncomeGoalCommand("gastei 50 no mercado")).toBeNull();
  });
});

describe("progresso da meta de ganho", () => {
  it("percentual, falta, dias restantes e projeção pelo ritmo do mês", () => {
    // 10 de outubro (31 dias): R$ 10.000 de R$ 30.000 → projeção R$ 31.000.
    expect(computeIncomeProgress(3_000_000, 1_000_000, "2026-10", "2026-10-10")).toEqual({ percent: 33, remainingCents: 2_000_000, reached: false, projectedCents: 3_100_000, daysLeft: 22 });
    // Mês passado: sem projeção e sem dias restantes.
    expect(computeIncomeProgress(3_000_000, 3_120_000, "2026-09", "2026-10-10")).toMatchObject({ percent: 104, remainingCents: 0, reached: true, projectedCents: null, daysLeft: 0 });
  });

  it("faixas: as da meta ou, sem elas, as do orçamento", () => {
    expect(effectiveThresholds([], [100, 50, 75, 90])).toEqual([50, 75, 90, 100]);
    expect(effectiveThresholds([80, 100], [50, 75])).toEqual([80, 100]);
  });
});

describe("destino e importância das notificações", () => {
  it("vencidas → vence hoje → metas → o resto", () => {
    expect(notificationPriority("BILL_OVERDUE", {})).toBe(0);
    expect(notificationPriority("STATEMENT_DUE", { stage: "OVERDUE" })).toBe(0);
    expect(notificationPriority("BILL_DUE", { stage: "TODAY" })).toBe(1);
    expect(notificationPriority("INCOME_GOAL", {})).toBe(2);
    expect(notificationPriority("WEEKLY_REPORT", null)).toBe(4);
  });

  it("usa data.url relativo; ignora endereços externos", () => {
    expect(notificationUrl("BILL_OVERDUE", { url: "/contas-a-pagar" })).toBe("/contas-a-pagar");
    expect(notificationUrl("INCOME_GOAL", { url: "https://exemplo.com" })).toBe("/metas");
    expect(notificationUrl("INCOME_GOAL", { url: "//exemplo.com" })).toBe("/metas");
    expect(notificationUrl("SYSTEM", null)).toBe("/");
  });
});
