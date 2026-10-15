import { describe, expect, it } from "vitest";
import { buildInstallmentPlan, statementForPurchase, statementStatus } from "@/server/modules/cards/billing";
import { buildLedgerPostings } from "@/server/modules/transactions/postings";

const card = { closingDay: 3, dueDay: 10 };

describe("faturamento do cartão", () => {
  it("compra antes do fechamento entra na fatura do mês", () => {
    const s = statementForPurchase("2026-10-02", card);
    expect(s).toEqual({ referenceMonth: "2026-10", closingDate: "2026-10-03", dueDate: "2026-10-10" });
  });

  it("compra no dia do fechamento ou depois entra na próxima fatura", () => {
    expect(statementForPurchase("2026-10-03", card).referenceMonth).toBe("2026-11");
    expect(statementForPurchase("2026-10-15", card).referenceMonth).toBe("2026-11");
  });

  it("vencimento no mês seguinte quando o dia de vencimento é menor que o de fechamento", () => {
    const s = statementForPurchase("2026-10-20", { closingDay: 25, dueDay: 5 });
    expect(s).toEqual({ referenceMonth: "2026-11", closingDate: "2026-10-25", dueDate: "2026-11-05" });
  });

  it("ajusta dias inexistentes (fechamento dia 31 em fevereiro)", () => {
    const s = statementForPurchase("2027-02-10", { closingDay: 31, dueDay: 10 });
    expect(s.closingDate).toBe("2027-02-28");
    expect(s.dueDate).toBe("2027-03-10");
  });

  it("notebook de R$ 3.600 em 12x gera 12 parcelas de R$ 300 em faturas consecutivas", () => {
    const plan = buildInstallmentPlan(360000, 12, "2026-10-15", card);
    expect(plan).toHaveLength(12);
    expect(plan.every((p) => p.amountCents === 30000)).toBe(true);
    expect(plan[0]!.referenceMonth).toBe("2026-11");
    expect(plan[11]!.referenceMonth).toBe("2027-10");
    expect(new Set(plan.map((p) => p.referenceMonth)).size).toBe(12);
  });

  it("status da fatura", () => {
    expect(statementStatus({ today: "2026-10-01", closingDate: "2026-10-03", dueDate: "2026-10-10", totalCents: 100, paidCents: 0, isCurrent: true })).toBe("OPEN");
    expect(statementStatus({ today: "2026-10-05", closingDate: "2026-10-03", dueDate: "2026-10-10", totalCents: 100, paidCents: 0 })).toBe("CLOSED");
    expect(statementStatus({ today: "2026-10-11", closingDate: "2026-10-03", dueDate: "2026-10-10", totalCents: 100, paidCents: 0 })).toBe("OVERDUE");
    expect(statementStatus({ today: "2026-10-11", closingDate: "2026-10-03", dueDate: "2026-10-10", totalCents: 100, paidCents: 100 })).toBe("PAID");
  });
});

describe("ledger", () => {
  const base = { status: "CONFIRMED" as const, amountCents: 1000, date: new Date("2026-10-15"), deletedAt: null };
  it("compra no crédito não movimenta caixa", () => {
    expect(buildLedgerPostings({ ...base, type: "EXPENSE", accountId: null, destinationAccountId: null, creditCardId: "c1" })).toEqual([]);
  });
  it("transferência soma zero", () => {
    const p = buildLedgerPostings({ ...base, type: "TRANSFER", accountId: "a", destinationAccountId: "b", creditCardId: null });
    expect(p.reduce((s, x) => s + x.amountCents, 0)).toBe(0);
    expect(p).toHaveLength(2);
  });
  it("pendente ou excluída não movimenta", () => {
    expect(buildLedgerPostings({ ...base, status: "PENDING", type: "EXPENSE", accountId: "a", destinationAccountId: null, creditCardId: null })).toEqual([]);
    expect(buildLedgerPostings({ ...base, deletedAt: new Date(), type: "EXPENSE", accountId: "a", destinationAccountId: null, creditCardId: null })).toEqual([]);
  });
  it("pagamento de fatura é saída de caixa", () => {
    const p = buildLedgerPostings({ ...base, type: "CARD_PAYMENT", accountId: "a", destinationAccountId: null, creditCardId: "c" });
    expect(p).toEqual([{ accountId: "a", kind: "CARD_PAYMENT", amountCents: -1000, date: base.date }]);
  });
});
