import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { getAccount, verifyLedgerIntegrity } from "@/server/modules/accounts/service";
import { listCards } from "@/server/modules/cards/service";
import { statementTotals } from "@/server/modules/cards/statements";
import { budgetOverview, cashflowProjection, dashboardSummary, expensesByCategory, monthlyIncomeExpense } from "@/server/modules/analytics/service";
import { upsertBudget } from "@/server/modules/budgets/service";
import { createTransaction, listTransactions } from "@/server/modules/transactions/service";
import { passthroughSummary, setReportExclusion } from "@/server/modules/transactions/report-exclusion";
import { applyRuleRetroactively, createRule } from "@/server/modules/categories/service";
import { createCard } from "@/server/modules/cards/service";
import { categoryId, createBasicAccounts, createFamily, resetDatabase } from "./helpers";

/**
 * "Desconsiderar nos relatórios": repasse de cliente (anúncios no cartão pagos pelo cliente via Pix).
 * Sai de receitas/despesas, categorias, orçamentos e relatórios; saldo, ledger, fatura e projeção
 * de caixa ficam exatamente iguais.
 */

const OCT = { start: "2026-10-01", end: "2026-10-31" };
const Q4 = { start: "2026-10-01", end: "2026-12-31" };

async function setup() {
  const fam = await createFamily();
  const { nubank, itau, card } = await createBasicAccounts(fam.ctx);
  const food = await categoryId(fam.householdId, "Alimentação");
  const pix = await createTransaction(fam.ctx, { type: "INCOME", amountCents: 50_000, description: "Pix recebido de CLIENTE X LTDA", date: "2026-10-02", accountId: itau.id });
  const ads = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 30_000, description: "FACEBK *ADS 1", date: "2026-10-05", creditCardId: card.id, paymentMethod: "CREDIT_CARD", categoryId: food });
  const adsParcelado = await createTransaction(fam.ctx, {
    type: "EXPENSE",
    amountCents: 60_000,
    description: "FACEBK *ADS 2",
    date: "2026-10-06",
    creditCardId: card.id,
    paymentMethod: "CREDIT_CARD",
    installmentCount: 3,
    categoryId: food,
  });
  const mercado = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 10_000, description: "Mercado", date: "2026-10-07", accountId: itau.id, categoryId: food });
  await upsertBudget(fam.ctx, { categoryId: food, month: "2026-10", limitCents: 200_000 });
  return { fam, nubank, itau, card, food, pix: pix.transaction, ads: ads.transaction, adsParcelado: adsParcelado.transaction, mercado: mercado.transaction };
}

/** Tudo o que NÃO pode mudar ao desconsiderar. */
async function untouched(s: Awaited<ReturnType<typeof setup>>) {
  const { fam, itau, nubank, card } = s;
  const [a1, a2] = await Promise.all([getAccount(fam.ctx, itau.id), getAccount(fam.ctx, nubank.id)]);
  const cards = await listCards(fam.ctx);
  const statements = await statementTotals(prisma, fam.householdId, { creditCardId: card.id });
  const projection = await cashflowProjection(fam.ctx, 120);
  const ledger = await prisma.ledgerEntry.findMany({ where: { householdId: fam.householdId }, orderBy: [{ transactionId: "asc" }, { kind: "asc" }], select: { transactionId: true, accountId: true, amountCents: true, kind: true } });
  const installments = await prisma.installment.findMany({ where: { householdId: fam.householdId }, orderBy: [{ transactionId: "asc" }, { number: "asc" }], select: { transactionId: true, statementId: true, amountCents: true, number: true } });
  return {
    balances: [a1.balanceCents, a2.balanceCents],
    outstanding: cards.map((c) => c.outstandingCents),
    statements: statements.map((t) => ({ id: t.id, total: t.totalCents, remaining: t.remainingCents })),
    projection: { end: projection.endBalanceCents, events: projection.events.map((e) => [e.date, e.amountCents]) },
    ledger,
    installments,
  };
}

describe("Desconsiderar nos relatórios", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("repasse sai de receitas/despesas, categorias, orçamento e relatórios; saldo, fatura e projeção não mudam", async () => {
    const s = await setup();
    const { fam, pix, ads, adsParcelado } = s;
    const before = await untouched(s);
    const accrualBefore = await dashboardSummary(fam.ctx, { period: OCT, regime: "ACCRUAL" });
    expect([accrualBefore.incomeCents, accrualBefore.expenseCents]).toEqual([50_000, 100_000]);

    const res = await setReportExclusion(fam.ctx, { transactionIds: [pix.id, ads.id, adsParcelado.id], excluded: true, reason: "CLIENT_PASSTHROUGH", party: "Cliente X" });
    expect(res.updated).toBe(3);
    expect(res.items.every((t) => t.excludedFromReports && t.exclusion?.reason === "CLIENT_PASSTHROUGH" && t.exclusion.party === "Cliente X")).toBe(true);

    // Nada de caixa/fatura mudou.
    expect(await untouched(s)).toEqual(before);
    expect((await verifyLedgerIntegrity(fam.householdId)).ok).toBe(true);

    // Competência e caixa (parcelas da fatura): só o mercado conta.
    const accrual = await dashboardSummary(fam.ctx, { period: OCT, regime: "ACCRUAL" });
    expect([accrual.incomeCents, accrual.expenseCents]).toEqual([0, 10_000]);
    const cash = await dashboardSummary(fam.ctx, { period: Q4, regime: "CASH" });
    expect([cash.incomeCents, cash.expenseCents]).toEqual([0, 10_000]);
    expect((await expensesByCategory(fam.ctx, { period: OCT, regime: "ACCRUAL" })).totalCents).toBe(10_000);
    const months = await monthlyIncomeExpense(fam.ctx, { startMonth: "2026-10", endMonth: "2026-12", regime: "CASH" });
    expect(months.items.map((m) => m.expenseCents)).toEqual([10_000, 0, 0]);
    const budget = await budgetOverview(fam.ctx, "2026-10", "ACCRUAL");
    expect(budget.totalSpentCents).toBe(10_000);

    // Lista: aparece com a marca; totais à parte; filtros.
    const list = await listTransactions(fam.ctx, { start: OCT.start, end: OCT.end });
    expect(list.total).toBe(4);
    expect(list.totals).toMatchObject({ incomeCents: 0, expenseCents: 10_000, excludedIncomeCents: 50_000, excludedExpenseCents: 90_000 });
    expect((await listTransactions(fam.ctx, { start: OCT.start, end: OCT.end, excluded: "hide" })).total).toBe(1);
    expect((await listTransactions(fam.ctx, { start: OCT.start, end: OCT.end, excluded: "only" })).total).toBe(3);

    // Saldo do repasse: recebeu 500, gastou 900 → falta receber 400.
    const pass = await passthroughSummary(fam.ctx);
    expect(pass.parties).toEqual([expect.objectContaining({ party: "Cliente X", receivedCents: 50_000, spentCents: 90_000, balanceCents: -40_000, count: 3 })]);

    // Auditado.
    const logs = await prisma.auditLog.findMany({ where: { householdId: fam.householdId, entityType: "Transaction", entityId: pix.id, action: "UPDATE" } });
    expect(logs.some((l) => (l.source ?? "").includes("Desconsiderado"))).toBe(true);

    // Desfazer a qualquer momento: tudo volta, e o caixa continua igual.
    const undo = await setReportExclusion(fam.ctx, { transactionIds: [pix.id, ads.id, adsParcelado.id], excluded: false });
    expect(undo.updated).toBe(3);
    const back = await dashboardSummary(fam.ctx, { period: OCT, regime: "ACCRUAL" });
    expect([back.incomeCents, back.expenseCents]).toEqual([50_000, 100_000]);
    expect(await untouched(s)).toEqual(before);
    expect((await passthroughSummary(fam.ctx)).parties).toEqual([]);
  });

  it("só receitas e despesas; transferência e pagamento de fatura são ignorados com o motivo", async () => {
    const s = await setup();
    const t = await createTransaction(s.fam.ctx, { type: "TRANSFER", amountCents: 1_000, description: "Itaú → Nubank", date: "2026-10-08", accountId: s.itau.id, destinationAccountId: s.nubank.id });
    const res = await setReportExclusion(s.fam.ctx, { transactionIds: [t.transaction.id, s.mercado.id], excluded: true });
    expect(res.updated).toBe(1);
    expect(res.skipped).toEqual([expect.objectContaining({ id: t.transaction.id, reason: expect.stringMatching(/Transferências/) })]);
    // Repetir não duplica nada.
    expect((await setReportExclusion(s.fam.ctx, { transactionIds: [s.mercado.id], excluded: true })).updated).toBe(0);
    // Perfil sem escrita não desconsidera.
    await expect(setReportExclusion({ ...s.fam.ctx, role: "VIEWER" }, { transactionIds: [s.mercado.id], excluded: false })).rejects.toThrow();
  });

  it("regra 'desconsiderar' (só no cartão Nubank): vale para os novos, mantém a categoria e pode ser aplicada aos anteriores", async () => {
    const s = await setup();
    const { fam, card, food } = s;
    const inter = await createCard(fam.ctx, { name: "Inter Crédito", issuer: "Inter", closingDay: 3, dueDay: 10, limitCents: 500_000 });
    const rule = await createRule(fam.ctx, {
      name: "Anúncios de clientes",
      pattern: "facebk",
      transactionType: "EXPENSE",
      matchCreditCardId: card.id,
      setExcludeFromReports: true,
      setExclusionParty: "Cliente X",
    });
    expect(rule).toMatchObject({ setExcludeFromReports: true, setExclusionReason: "CLIENT_PASSTHROUGH" });

    const novo = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 12_000, description: "FACEBK *ADS 3", date: "2026-10-10", creditCardId: card.id, paymentMethod: "CREDIT_CARD", categoryId: food });
    expect(novo.transaction).toMatchObject({ excludedFromReports: true, exclusion: { reason: "CLIENT_PASSTHROUGH", party: "Cliente X" }, category: { id: food } });
    // Outro cartão: a condição não casa.
    const outro = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 5_000, description: "FACEBK *ADS proprio", date: "2026-10-10", creditCardId: inter.id, paymentMethod: "CREDIT_CARD" });
    expect(outro.transaction.excludedFromReports).toBe(false);

    // Anteriores (ADS 1 e ADS 2, no Nubank).
    expect(await applyRuleRetroactively(fam.ctx, rule.id)).toEqual({ applied: 2 });
    const excluded = await prisma.transaction.findMany({ where: { householdId: fam.householdId, excludedFromReports: true }, select: { description: true } });
    expect(excluded.map((t) => t.description).sort()).toEqual(["FACEBK *ADS 1", "FACEBK *ADS 2", "FACEBK *ADS 3"]);

    // Regra de transferência e de desconsiderar ao mesmo tempo é recusada.
    await expect(createRule(fam.ctx, { name: "x", pattern: "y", setExcludeFromReports: true, setTransferAccountId: s.nubank.id })).rejects.toThrow(/transferência e desconsiderar/);
  });

  it("lançamento desconsiderado que vira transferência volta ao normal (transferência nunca é receita/despesa)", async () => {
    const s = await setup();
    await setReportExclusion(s.fam.ctx, { transactionIds: [s.mercado.id], excluded: true });
    const { convertToTransfers } = await import("@/server/modules/transactions/convert-transfer");
    await convertToTransfers(s.fam.ctx, { transactionIds: [s.mercado.id], counterpartAccountId: s.nubank.id });
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: s.mercado.id } });
    expect(t).toMatchObject({ type: "TRANSFER", excludedFromReports: false, exclusionReason: null });
  });
});
