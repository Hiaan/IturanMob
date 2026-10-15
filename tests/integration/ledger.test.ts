import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { categoryId, createBasicAccounts, createFamily, resetDatabase, subcategory } from "./helpers";
import { createTransaction, deleteTransaction, restoreTransaction, updateTransaction, rebuildHouseholdLedger, getTransaction, listTransactions } from "@/server/modules/transactions/service";
import { getAccount, verifyLedgerIntegrity, listAccounts } from "@/server/modules/accounts/service";
import { getStatement, listStatements, payStatement } from "@/server/modules/cards/service";
import { dashboardSummary, expensesByCategory } from "@/server/modules/analytics/service";

describe("núcleo financeiro (ledger, cartões, transferências)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("despesa em conta reduz o saldo e edição atualiza corretamente", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const sub = await subcategory(fam.householdId, "Supermercado");
    const { transaction } = await createTransaction(fam.ctx, {
      type: "EXPENSE",
      amountCents: 25_800,
      description: "Mercado",
      date: "2026-10-10",
      subcategoryId: sub.id,
      accountId: nubank.id,
      paymentMethod: "DEBIT_CARD",
    });
    expect(transaction.category?.name).toBe("Alimentação");
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(100_000 - 25_800);

    await updateTransaction(fam.ctx, transaction.id, { amountCents: 28_500 });
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(100_000 - 28_500);

    const history = await prisma.auditLog.findMany({ where: { entityId: transaction.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => h.action)).toEqual(["CREATE", "UPDATE"]);
  });

  it("exclusão lógica e restauração preservam o saldo", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 4_500, description: "Farmácia", date: "2026-10-10", accountId: nubank.id });
    await deleteTransaction(fam.ctx, transaction.id);
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(100_000);
    const deleted = await listTransactions(fam.ctx, { deleted: "only" });
    expect(deleted.items).toHaveLength(1);
    await restoreTransaction(fam.ctx, transaction.id);
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(95_500);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: transaction.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["CREATE", "DELETE", "RESTORE"]);
  });

  it("transferência entre contas não é receita nem despesa", async () => {
    const fam = await createFamily();
    const { nubank, itau } = await createBasicAccounts(fam.ctx);
    await createTransaction(fam.ctx, { type: "TRANSFER", amountCents: 50_000, description: "Transferência", date: "2026-10-10", accountId: itau.id, destinationAccountId: nubank.id });
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(450_000);
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(150_000);
    const summary = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" } });
    expect(summary.incomeCents).toBe(0);
    expect(summary.expenseCents).toBe(0);
    expect(summary.availableBalanceCents).toBe(600_000);
  });

  it("compra parcelada gera faturas futuras e o pagamento da fatura não duplica despesa", async () => {
    const fam = await createFamily();
    const { nubank, card } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.ctx, {
      type: "EXPENSE",
      amountCents: 360_000,
      description: "Notebook",
      date: "2026-10-15",
      creditCardId: card.id,
      installmentCount: 12,
    });
    // Compra no crédito não altera o saldo da conta.
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(100_000);
    const detail = await getTransaction(fam.ctx, transaction.id);
    expect((detail.installments as unknown[]).length).toBe(12);

    const statements = await listStatements(fam.ctx, card.id);
    const withTotals = statements.filter((s) => s.totalCents > 0);
    expect(withTotals).toHaveLength(12);
    expect(withTotals.every((s) => s.totalCents === 30_000)).toBe(true);

    // Competência: despesa total na data da compra.
    const accrual = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" }, regime: "ACCRUAL" });
    expect(accrual.expenseCents).toBe(360_000);
    // Caixa: cada parcela no vencimento da fatura (primeira em novembro).
    const cashOct = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" }, regime: "CASH" });
    expect(cashOct.expenseCents).toBe(0);
    const cashNov = await dashboardSummary(fam.ctx, { period: { start: "2026-11-01", end: "2026-11-30" }, regime: "CASH" });
    expect(cashNov.expenseCents).toBe(30_000);

    // Paga a primeira fatura.
    const first = withTotals[0]!;
    await payStatement(fam.ctx, first.id, { date: "2026-11-09" });
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(70_000);
    const paid = await getStatement(fam.ctx, first.id);
    expect(paid.remainingCents).toBe(0);

    // A despesa continua sendo apenas a compra (sem dupla contagem).
    const cashNovAfter = await dashboardSummary(fam.ctx, { period: { start: "2026-11-01", end: "2026-11-30" }, regime: "CASH" });
    expect(cashNovAfter.expenseCents).toBe(30_000);
    const accrualYear = await dashboardSummary(fam.ctx, { period: { start: "2026-01-01", end: "2026-12-31" }, regime: "ACCRUAL" });
    expect(accrualYear.expenseCents).toBe(360_000);
  });

  it("alterar o número de parcelas recalcula as faturas", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 240_000, description: "Televisão", date: "2026-10-15", creditCardId: card.id, installmentCount: 10 });
    await updateTransaction(fam.ctx, transaction.id, { installmentCount: 3 });
    const detail = await getTransaction(fam.ctx, transaction.id);
    expect((detail.installments as Array<{ amountCents: number }>).map((i) => i.amountCents)).toEqual([80_000, 80_000, 80_000]);
  });

  it("recalcula saldos e verifica integridade", async () => {
    const fam = await createFamily();
    const { nubank, itau, card } = await createBasicAccounts(fam.ctx);
    await createTransaction(fam.ctx, { type: "INCOME", amountCents: 350_000, description: "Cliente", date: "2026-10-05", accountId: itau.id, categoryId: await categoryId(fam.householdId, "Trabalho", "INCOME") });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 12_000, description: "Internet", date: "2026-10-06", accountId: nubank.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 9_999, description: "Delivery", date: "2026-10-06", creditCardId: card.id, installmentCount: 3 });
    const before = await listAccounts(fam.ctx);
    // Corrompe o ledger propositalmente e recalcula.
    await prisma.ledgerEntry.deleteMany({ where: { householdId: fam.householdId } });
    await rebuildHouseholdLedger(fam.householdId);
    const after = await listAccounts(fam.ctx);
    expect(after.map((a) => a.balanceCents)).toEqual(before.map((a) => a.balanceCents));
    const integrity = await verifyLedgerIntegrity(fam.householdId);
    expect(integrity.ok).toBe(true);
  });

  it("isola os dados entre famílias", async () => {
    const a = await createFamily("Família A");
    const b = await createFamily("Família B");
    const { nubank } = await createBasicAccounts(a.ctx);
    const { transaction } = await createTransaction(a.ctx, { type: "EXPENSE", amountCents: 1_000, description: "Café", date: "2026-10-10", accountId: nubank.id });
    await expect(getTransaction(b.ctx, transaction.id)).rejects.toThrow(/não encontrad/);
    await expect(updateTransaction(b.ctx, transaction.id, { amountCents: 1 })).rejects.toThrow(/não encontrad/);
    await expect(deleteTransaction(b.ctx, transaction.id)).rejects.toThrow(/não encontrad/);
    await expect(createTransaction(b.ctx, { type: "EXPENSE", amountCents: 1_000, description: "x", date: "2026-10-10", accountId: nubank.id })).rejects.toThrow(/Conta inválida/);
    expect((await listTransactions(b.ctx, {})).total).toBe(0);
    expect((await expensesByCategory(b.ctx, { period: { start: "2026-01-01", end: "2026-12-31" } })).totalCents).toBe(0);
  });

  it("contas privadas ficam ocultas para outros membros", async () => {
    const fam = await createFamily();
    const { createAccount } = await import("@/server/modules/accounts/service");
    const priv = await createAccount(fam.wifeCtx, { name: "Conta da Maria", visibility: "PRIVATE", initialBalanceCents: 10_000 });
    await createTransaction(fam.wifeCtx, { type: "EXPENSE", amountCents: 2_000, description: "Presente surpresa", date: "2026-10-10", accountId: priv.id });
    expect((await listAccounts(fam.ctx)).find((a) => a.id === priv.id)).toBeUndefined();
    expect((await listTransactions(fam.ctx, {})).total).toBe(0);
    expect((await listTransactions(fam.wifeCtx, {})).total).toBe(1);
  });

  it("despesa com rateio e responsabilidade individual", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.ctx, {
      type: "EXPENSE",
      amountCents: 30_000,
      description: "Jantar",
      date: "2026-10-10",
      accountId: nubank.id,
      allocations: [
        { memberId: fam.husbandId, amountCents: 20_000 },
        { memberId: fam.wifeId, amountCents: 10_000 },
      ],
    });
    expect(transaction.allocations).toHaveLength(2);
    expect(transaction.payer?.id).toBe(fam.husbandId);
    await expect(
      createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 30_000, description: "x", date: "2026-10-10", allocations: [{ memberId: fam.husbandId, amountCents: 1 }, { memberId: fam.wifeId, amountCents: 2 }] }),
    ).rejects.toThrow(/soma do rateio/);
  });
});
