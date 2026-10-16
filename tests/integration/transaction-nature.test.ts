import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { getAccount, verifyLedgerIntegrity } from "@/server/modules/accounts/service";
import { listCards } from "@/server/modules/cards/service";
import { statementTotals } from "@/server/modules/cards/statements";
import { budgetOverview, cashflowProjection, dashboardSummary, expensesByCategory } from "@/server/modules/analytics/service";
import { upsertBudget } from "@/server/modules/budgets/service";
import { updateSettings } from "@/server/modules/households/service";
import { createTransaction, listTransactions } from "@/server/modules/transactions/service";
import { setTransactionNature } from "@/server/modules/transactions/nature";
import { applyRuleRetroactively, createRule } from "@/server/modules/categories/service";
import { commitImport, createImportPreviewFromBuffer, setImportRowsNature } from "@/server/modules/imports/service";
import { categoryId, createBasicAccounts, createFamily, resetDatabase } from "./helpers";

/**
 * Natureza do lançamento: Pessoal (padrão), Empresa ou Repasse. Muda só relatórios e análises;
 * saldo, ledger, parcelas, fatura e projeção de caixa ficam idênticos.
 */

const OCT = { start: "2026-10-01", end: "2026-10-31" };

async function setup() {
  const fam = await createFamily();
  const { nubank, itau, card } = await createBasicAccounts(fam.ctx);
  const food = await categoryId(fam.householdId, "Alimentação");
  const mercado = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 10_000, description: "Mercado", date: "2026-10-03", accountId: itau.id, categoryId: food });
  const daniel = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 75_000, description: "Pix enviado DANIEL DA SILVA PEREIRA VERAS", date: "2026-10-04", accountId: itau.id });
  const cliente = await createTransaction(fam.ctx, { type: "INCOME", amountCents: 200_000, description: "Pix recebido AGENCIA CLIENTE Y", date: "2026-10-05", accountId: itau.id });
  const trafego = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 30_000, description: "FACEBK *TRAFEGO PROPRIO", date: "2026-10-06", creditCardId: card.id, paymentMethod: "CREDIT_CARD", installmentCount: 2, categoryId: food });
  await upsertBudget(fam.ctx, { categoryId: food, month: "2026-10", limitCents: 200_000 });
  return { fam, nubank, itau, card, food, mercado: mercado.transaction, daniel: daniel.transaction, cliente: cliente.transaction, trafego: trafego.transaction };
}

async function cashState(s: Awaited<ReturnType<typeof setup>>) {
  const [a, b] = await Promise.all([getAccount(s.fam.ctx, s.itau.id), getAccount(s.fam.ctx, s.nubank.id)]);
  return {
    balances: [a.balanceCents, b.balanceCents],
    outstanding: (await listCards(s.fam.ctx)).map((c) => c.outstandingCents),
    statements: (await statementTotals(prisma, s.fam.householdId, { creditCardId: s.card.id })).map((t) => [t.id, t.totalCents, t.remainingCents]),
    projection: (await cashflowProjection(s.fam.ctx, 120)).endBalanceCents,
    ledger: await prisma.ledgerEntry.findMany({ where: { householdId: s.fam.householdId }, orderBy: [{ transactionId: "asc" }, { kind: "asc" }], select: { transactionId: true, amountCents: true } }),
    installments: await prisma.installment.findMany({ where: { householdId: s.fam.householdId }, orderBy: [{ transactionId: "asc" }, { number: "asc" }], select: { transactionId: true, amountCents: true, statementId: true } }),
  };
}

describe("Natureza do lançamento (Pessoal / Empresa / Repasse)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("Empresa sai do recorte Pessoal (padrão), entra no recorte Empresa e no resultado da empresa; caixa e fatura não mudam", async () => {
    const s = await setup();
    const before = await cashState(s);
    const res = await setTransactionNature(s.fam.ctx, { transactionIds: [s.daniel.id, s.cliente.id, s.trafego.id], nature: "BUSINESS" });
    expect(res.updated).toBe(3);
    expect(res.items.every((t) => t.nature === "BUSINESS" && t.scope === "BUSINESS")).toBe(true);
    expect(await cashState(s)).toEqual(before);
    expect((await verifyLedgerIntegrity(s.fam.householdId)).ok).toBe(true);

    const personal = await dashboardSummary(s.fam.ctx, { period: OCT, regime: "ACCRUAL" });
    expect(personal).toMatchObject({ scope: "PERSONAL", incomeCents: 0, expenseCents: 10_000, business: { incomeCents: 200_000, expenseCents: 105_000, resultCents: 95_000 } });
    const business = await dashboardSummary(s.fam.ctx, { period: OCT, regime: "ACCRUAL", filters: { scope: "BUSINESS" } });
    expect([business.incomeCents, business.expenseCents]).toEqual([200_000, 105_000]);
    const all = await dashboardSummary(s.fam.ctx, { period: OCT, regime: "ACCRUAL", filters: { scope: "ALL" } });
    expect([all.incomeCents, all.expenseCents]).toEqual([200_000, 115_000]);
    // Caixa (parcelas): a 1ª parcela do tráfego (fatura de novembro) é da empresa.
    const cashBusiness = await dashboardSummary(s.fam.ctx, { period: { start: "2026-10-01", end: "2026-12-31" }, regime: "CASH", filters: { scope: "BUSINESS" } });
    expect(cashBusiness.expenseCents).toBe(75_000 + 30_000);
    // Orçamento (padrão Pessoal) só com o mercado.
    expect((await budgetOverview(s.fam.ctx, "2026-10", "ACCRUAL")).totalSpentCents).toBe(10_000);
    expect((await expensesByCategory(s.fam.ctx, { period: OCT, regime: "ACCRUAL" })).totalCents).toBe(10_000);

    // Relatório e orçamento com o recorte escolhido.
    const { generateReport } = await import("@/server/modules/reports/service");
    const rep = await generateReport(s.fam.ctx, { type: "MONTHLY", month: "2026-10", natureScope: "BUSINESS", regime: "ACCRUAL" });
    expect(rep.data).toMatchObject({ natureScope: "BUSINESS", totals: { incomeCents: 200_000, expenseCents: 105_000 } });
    const repDefault = await generateReport(s.fam.ctx, { type: "MONTHLY", month: "2026-10", regime: "ACCRUAL" });
    expect(repDefault.data).toMatchObject({ natureScope: "PERSONAL", totals: { expenseCents: 10_000 }, business: { resultCents: 95_000 } });
    expect((await budgetOverview(s.fam.ctx, "2026-10", "ACCRUAL", "ALL")).totalSpentCents).toBe(10_000 + 30_000);

    // Padrão da família "Tudo": o painel volta a somar tudo.
    await updateSettings(s.fam.ctx, { defaultReportScope: "ALL" });
    const allDefault = await dashboardSummary(s.fam.ctx, { period: OCT, regime: "ACCRUAL" });
    expect([allDefault.scope, allDefault.expenseCents]).toEqual(["ALL", 115_000]);

    // Lista: filtro por natureza.
    expect((await listTransactions(s.fam.ctx, { start: OCT.start, end: OCT.end, scope: "BUSINESS" })).total).toBe(3);
    expect((await listTransactions(s.fam.ctx, { start: OCT.start, end: OCT.end, scope: "PERSONAL" })).total).toBe(1);

    // Repasse a partir de Empresa e volta a Pessoal; tudo auditado, caixa igual.
    await setTransactionNature(s.fam.ctx, { transactionIds: [s.cliente.id], nature: "PASSTHROUGH", party: "Cliente Y" });
    const c = await prisma.transaction.findUniqueOrThrow({ where: { id: s.cliente.id } });
    expect(c).toMatchObject({ excludedFromReports: true, exclusionReason: "CLIENT_PASSTHROUGH", exclusionParty: "Cliente Y" });
    await setTransactionNature(s.fam.ctx, { transactionIds: [s.cliente.id], nature: "PERSONAL" });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: s.cliente.id } })).toMatchObject({ excludedFromReports: false, scope: "PERSONAL" });
    expect(await prisma.auditLog.count({ where: { entityId: s.cliente.id, action: "UPDATE" } })).toBe(3);
    expect(await cashState(s)).toEqual(before);
  });

  it("regras: definir Empresa (com aplicar aos anteriores) e perguntar a natureza acima de um valor no cartão", async () => {
    const s = await setup();
    const team = await createRule(s.fam.ctx, { name: "Equipe", pattern: "daniel da silva", transactionType: "EXPENSE", setScope: "BUSINESS" });
    expect(await applyRuleRetroactively(s.fam.ctx, team.id)).toEqual({ applied: 1 });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: s.daniel.id } })).scope).toBe("BUSINESS");
    const novo = await createTransaction(s.fam.ctx, { type: "EXPENSE", amountCents: 50_000, description: "Pix enviado DANIEL DA SILVA", date: "2026-10-10", accountId: s.itau.id });
    expect(novo.transaction).toMatchObject({ scope: "BUSINESS", nature: "BUSINESS" });

    await createRule(s.fam.ctx, { name: "Anúncios", pattern: "facebk", transactionType: "EXPENSE", matchCreditCardId: s.card.id, minAmountCents: 15_000, askNature: true });
    const grande = await createTransaction(s.fam.ctx, { type: "EXPENSE", amountCents: 21_147, description: "FACEBK *ADS", date: "2026-10-11", creditCardId: s.card.id, paymentMethod: "CREDIT_CARD" });
    const pequeno = await createTransaction(s.fam.ctx, { type: "EXPENSE", amountCents: 3_000, description: "FACEBK *ADS", date: "2026-10-11", creditCardId: s.card.id, paymentMethod: "CREDIT_CARD" });
    expect(grande.transaction).toMatchObject({ natureReview: true, nature: "PERSONAL" });
    expect(pequeno.transaction.natureReview).toBe(false);
    expect(await prisma.pendingItem.count({ where: { householdId: s.fam.householdId, type: "NATURE_REVIEW", status: "OPEN" } })).toBe(1);
    expect((await listTransactions(s.fam.ctx, { natureReview: true })).total).toBe(1);
    // Escolher a natureza resolve a pendência.
    await setTransactionNature(s.fam.ctx, { transactionIds: [grande.transaction.id], nature: "PASSTHROUGH" });
    expect(await prisma.pendingItem.count({ where: { householdId: s.fam.householdId, type: "NATURE_REVIEW", status: "OPEN" } })).toBe(0);

    // Natureza informada vale sobre as regras.
    const explicito = await createTransaction(s.fam.ctx, { type: "EXPENSE", amountCents: 40_000, description: "Pix enviado DANIEL DA SILVA", date: "2026-10-12", accountId: s.itau.id, nature: "PERSONAL" });
    expect(explicito.transaction.scope).toBe("PERSONAL");
    // Regra com duas naturezas é recusada.
    await expect(createRule(s.fam.ctx, { name: "x", pattern: "y", setScope: "BUSINESS", askNature: true })).rejects.toThrow(/uma só natureza/);
  });

  it("importação: prévia mostra a natureza sugerida e as que pedem escolha; escolha com 'aplicar às parecidas' vale ao importar", async () => {
    const s = await setup();
    await createRule(s.fam.ctx, { name: "Equipe", pattern: "icaro", setScope: "BUSINESS" });
    await createRule(s.fam.ctx, { name: "Anúncios", pattern: "facebk", askNature: true });
    const csv = Buffer.from(
      ["Data;Descrição;Valor", "12/10/2026;PIX ENVIADO ICARO SOUZA;-750,00", "13/10/2026;FACEBK *AAA;-211,47", "14/10/2026;FACEBK *BBB;-210,80", "15/10/2026;PADARIA;-12,00"].join("\n"),
    );
    const preview = await createImportPreviewFromBuffer(s.fam.ctx, { fileName: "itau.csv", accountId: s.itau.id, content: csv });
    const byDesc = (d: string) => preview.rows.find((r) => r.description?.startsWith(d))!;
    expect(byDesc("PIX ENVIADO ICARO").nature).toEqual({ value: "BUSINESS", source: "RULE", ask: false });
    expect(byDesc("FACEBK *AAA").nature).toMatchObject({ ask: true, value: "PERSONAL" });
    expect(byDesc("PADARIA").nature).toEqual({ value: "PERSONAL", source: "DEFAULT", ask: false });
    expect(preview.batch.warnings.join(" ")).toMatch(/2 lançamento\(s\) pedem a natureza/);

    const updated = await setImportRowsNature(s.fam.ctx, preview.batch.id, { rowIds: [byDesc("FACEBK *AAA").id], nature: "PASSTHROUGH", applyToSimilar: true });
    expect(updated.updatedRows).toBe(2);
    expect(updated.rows.filter((r) => r.description?.startsWith("FACEBK")).every((r) => r.nature?.value === "PASSTHROUGH" && r.nature.source === "MANUAL" && !r.nature.ask)).toBe(true);
    await commitImport(s.fam.ctx, preview.batch.id);
    const imported = await prisma.transaction.findMany({ where: { householdId: s.fam.householdId, source: "IMPORT" }, select: { description: true, scope: true, excludedFromReports: true, natureReview: true } });
    const get = (d: string) => imported.find((t) => t.description.startsWith(d))!;
    expect(get("PIX ENVIADO ICARO")).toMatchObject({ scope: "BUSINESS", excludedFromReports: false });
    expect(get("FACEBK *AAA")).toMatchObject({ excludedFromReports: true, natureReview: false });
    expect(get("FACEBK *BBB")).toMatchObject({ excludedFromReports: true, natureReview: false });
    expect(get("PADARIA")).toMatchObject({ scope: "PERSONAL", excludedFromReports: false });
  });
});
