import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";
import { prisma } from "@/server/db";
import { createAccount, getAccount } from "@/server/modules/accounts/service";
import { createTransaction } from "@/server/modules/transactions/service";
import { convertToTransfers } from "@/server/modules/transactions/convert-transfer";
import { applyRuleRetroactively, listRules } from "@/server/modules/categories/service";
import { bulkCommitImports, commitImport, createImportPreviewFromBuffer, setImportRowsTransfer, undoImport, updateImportRows } from "@/server/modules/imports/service";
import { dashboardSummary } from "@/server/modules/analytics/service";
import { createFamily, resetDatabase, type TestFamily } from "./helpers";

/**
 * Aplicação/resgate de investimento e transferências entre contas próprias: na importação, na
 * correção do que já foi importado e nas regras aprendidas. Nunca viram receita/despesa e nunca
 * são contadas duas vezes.
 */

const csv = (lines: string[]) => Buffer.from(["Data;Descrição;Valor", ...lines].join("\n"), "utf8");

async function family() {
  const fam = await createFamily();
  const itau = await createAccount(fam.ctx, { name: "Itaú", institution: "Itaú", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
  return { fam, itau };
}

async function cdbOf(fam: TestFamily, name = "CDB Itaú") {
  return createAccount(fam.ctx, { name, institution: "Itaú", type: "INVESTMENT", initialBalanceCents: 500_000, initialBalanceDate: "2026-01-01" });
}

const balance = async (fam: TestFamily, id: string) => (await getAccount(fam.ctx, id)).balanceCents;

describe("Investimentos e contas próprias são transferências", () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await rm(path.resolve(env().STORAGE_DIR), { recursive: true, force: true });
  });

  it("importação: resgate e aplicação viram transferência com a conta de investimento; rendimento e IOF não", async () => {
    const { fam, itau } = await family();
    const cdb = await cdbOf(fam);
    const preview = await createImportPreviewFromBuffer(fam.ctx, {
      fileName: "itau.csv",
      accountId: itau.id,
      content: csv(["02/10/2026;RESGATE CDB;1500,00", "03/10/2026;APLICACAO CDB;-300,00", "04/10/2026;RENDIMENTO POUPANCA;12,30", "05/10/2026;IOF RESGATE CDB;-1,20", "06/10/2026;MERCADO BOM;-50,00"]),
    });
    const byDesc = Object.fromEntries(preview.rows.map((r) => [r.description, r]));
    expect(byDesc["RESGATE CDB"]).toMatchObject({ kind: "TRANSFER", selected: true, transfer: { accountId: cdb.id, accountName: "CDB Itaú", direction: "IN", reason: "INVESTMENT" } });
    expect(byDesc["APLICACAO CDB"]).toMatchObject({ kind: "TRANSFER", transfer: { accountId: cdb.id, direction: "OUT" } });
    expect(byDesc["RESGATE CDB"]!.message).toContain("não conta como receita nem despesa");
    expect(byDesc["RENDIMENTO POUPANCA"]).toMatchObject({ kind: "INCOME", transfer: null });
    expect(byDesc["IOF RESGATE CDB"]).toMatchObject({ kind: "EXPENSE", transfer: null });
    // Transferência não recebe categoria.
    await expect(updateImportRows(fam.ctx, preview.batch.id, [{ rowId: byDesc["RESGATE CDB"]!.id, categoryId: (await prisma.category.findFirstOrThrow({ where: { householdId: fam.householdId, kind: "INCOME" } })).id }])).rejects.toThrow(/não recebe categoria/);

    const before = { itau: await balance(fam, itau.id), cdb: await balance(fam, cdb.id) };
    const res = await commitImport(fam.ctx, preview.batch.id);
    expect(res.result.created).toBe(5);
    const transfers = await prisma.transaction.findMany({ where: { householdId: fam.householdId, type: "TRANSFER" }, orderBy: { date: "asc" } });
    expect(transfers.map((t) => [t.amountCents, t.accountId, t.destinationAccountId, t.categoryId])).toEqual([
      [150000, cdb.id, itau.id, null],
      [30000, itau.id, cdb.id, null],
    ]);
    expect(await balance(fam, itau.id)).toBe(before.itau + 150000 - 30000 + 1230 - 120 - 5000);
    expect(await balance(fam, cdb.id)).toBe(before.cdb - 150000 + 30000);
    // Receitas do mês: só o rendimento (o resgate não é receita).
    const summary = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" }, regime: "ACCRUAL" });
    expect(summary.incomeCents).toBe(1230);
    expect(summary.expenseCents).toBe(120 + 5000);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, type: "INCOME" } })).toBe(1);

    // Desfazer remove as transferências e restaura os saldos.
    await undoImport(fam.ctx, preview.batch.id);
    expect(await balance(fam, itau.id)).toBe(before.itau);
    expect(await balance(fam, cdb.id)).toBe(before.cdb);
  });

  it("sem conta de investimento: linha desmarcada com aviso; marcar como transferência (parecidas + lembrar) cria a regra para a próxima", async () => {
    const { fam, itau } = await family();
    const preview = await createImportPreviewFromBuffer(fam.ctx, {
      fileName: "itau.csv",
      accountId: itau.id,
      content: csv(["02/10/2026;RESGATE CDB 000123;1500,00", "09/10/2026;RESGATE CDB 000456;700,00", "06/10/2026;MERCADO BOM;-50,00"]),
    });
    const resgate = preview.rows.find((r) => r.description === "RESGATE CDB 000123")!;
    expect(resgate).toMatchObject({ kind: "TRANSFER", selected: false, transfer: { accountId: null } });
    expect(resgate.message).toContain("escolha a conta do outro lado");
    expect(preview.batch.warnings.join(" ")).toContain("não tem conta de investimento cadastrada");

    const cdb = await cdbOf(fam, "Investimentos");
    const updated = await setImportRowsTransfer(fam.ctx, preview.batch.id, { rowIds: [resgate.id], transferAccountId: cdb.id, applyToSimilar: true, remember: true });
    expect(updated.updatedRows).toBe(2);
    expect(updated.ruleCreated).toBe(true);
    expect(updated.rows.filter((r) => r.transfer?.accountId === cdb.id && r.selected)).toHaveLength(2);
    await commitImport(fam.ctx, preview.batch.id);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, type: "TRANSFER", accountId: cdb.id, destinationAccountId: itau.id } })).toBe(2);

    // A regra aprendida aparece nas regras e vale para a próxima importação (mesmo sem a palavra "conta").
    const rules = await listRules(fam.ctx);
    expect(rules.find((r) => r.pattern === "resgate cdb")).toMatchObject({ setTransferAccountId: cdb.id, setCategoryId: null, transferAccount: { name: "Investimentos" } });
    const next = await createImportPreviewFromBuffer(fam.ctx, { fileName: "itau-nov.csv", accountId: itau.id, content: csv(["02/11/2026;RESGATE CDB 000999;400,00"]) });
    expect(next.rows[0]).toMatchObject({ kind: "TRANSFER", selected: true, transfer: { accountId: cdb.id, reason: "RULE" } });

    // Desfazer na prévia: volta a ser receita.
    const back = await setImportRowsTransfer(fam.ctx, next.batch.id, { rowIds: [next.rows[0]!.id], transferAccountId: null });
    expect(back.rows[0]).toMatchObject({ kind: "INCOME", transfer: null });
  });

  it("resgate já registrado como receita (ex.: pelo WhatsApp) é convertido na confirmação, sem duplicar; desfazer volta a receita", async () => {
    const { fam, itau } = await family();
    const cdb = await cdbOf(fam);
    const income = await createTransaction(fam.ctx, { type: "INCOME", amountCents: 150000, description: "Resgate CDB", date: "2026-10-02", accountId: itau.id });
    const preview = await createImportPreviewFromBuffer(fam.ctx, { fileName: "itau.csv", accountId: itau.id, content: csv(["02/10/2026;RESGATE CDB;1500,00"]) });
    expect(preview.rows[0]).toMatchObject({ status: "MATCHED", kind: "TRANSFER" });
    expect(preview.rows[0]!.message).toContain("Está como receita: ao confirmar, vira transferência vinda de CDB Itaú");
    const before = await balance(fam, cdb.id);
    await commitImport(fam.ctx, preview.batch.id);
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: income.transaction.id } });
    expect(tx).toMatchObject({ type: "TRANSFER", accountId: cdb.id, destinationAccountId: itau.id, categoryId: null, deletedAt: null });
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, deletedAt: null } })).toBe(1);
    expect(await balance(fam, cdb.id)).toBe(before - 150000);

    await undoImport(fam.ctx, preview.batch.id);
    const reverted = await prisma.transaction.findUniqueOrThrow({ where: { id: income.transaction.id } });
    expect(reverted).toMatchObject({ type: "INCOME", accountId: itau.id, destinationAccountId: null });
    expect(await balance(fam, cdb.id)).toBe(before);
  });

  it("extrato da conta e do CDB confirmados juntos: a mesma aplicação entra uma vez só", async () => {
    const { fam, itau } = await family();
    const cdb = await cdbOf(fam);
    const a = await createImportPreviewFromBuffer(fam.ctx, { fileName: "itau.csv", accountId: itau.id, content: csv(["03/10/2026;APLICACAO CDB;-300,00"]) });
    const b = await createImportPreviewFromBuffer(fam.ctx, { fileName: "cdb.csv", accountId: cdb.id, content: csv(["03/10/2026;APLICACAO;300,00", "31/10/2026;RENDIMENTO;4,10"]) });
    expect(b.rows[0]).toMatchObject({ kind: "TRANSFER", transfer: { accountId: itau.id, direction: "IN" } });
    const res = await bulkCommitImports(fam.ctx, { batchIds: [a.batch.id, b.batch.id] });
    expect(res.totals).toMatchObject({ created: 2, duplicatesAtCommit: 1 });
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, type: "TRANSFER" } })).toBe(1);
  });

  it("converter lançamentos já importados: plano (dry-run), união do outro lado e itens ignorados", async () => {
    const { fam, itau } = await family();
    const cdb = await cdbOf(fam);
    const card = await prisma.creditCard.create({ data: { householdId: fam.householdId, name: "Cartão", closingDay: 3, dueDay: 10, limitCents: 100_000 } });
    // Importado errado: resgate como receita na conta corrente e a saída correspondente como despesa no CDB.
    const resgate = await createTransaction(fam.ctx, { type: "INCOME", amountCents: 150000, description: "RESGATE CDB", date: "2026-10-02", accountId: itau.id });
    const saidaCdb = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 150000, description: "RESGATE", date: "2026-10-02", accountId: cdb.id });
    const aplicacao = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 30000, description: "APLICACAO CDB", date: "2026-10-03", accountId: itau.id });
    const compra = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 9000, description: "Loja", date: "2026-10-03", creditCardId: card.id });
    const totalBefore = (await balance(fam, itau.id)) + (await balance(fam, cdb.id));

    const plan = await convertToTransfers(fam.ctx, { transactionIds: [resgate.transaction.id, aplicacao.transaction.id, compra.transaction.id], counterpartAccountId: cdb.id, dryRun: true });
    expect(plan.totals).toEqual({ convert: 2, merge: 1, skip: 1 });
    expect(plan.items.find((i) => i.transactionId === resgate.transaction.id)).toMatchObject({ action: "CONVERT", fromAccountId: cdb.id, toAccountId: itau.id, mirrorTransactionId: saidaCdb.transaction.id });
    expect(plan.items.find((i) => i.transactionId === compra.transaction.id)).toMatchObject({ action: "SKIP" });
    // O dry-run não altera nada.
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: resgate.transaction.id } })).type).toBe("INCOME");

    const done = await convertToTransfers(fam.ctx, { transactionIds: [resgate.transaction.id, aplicacao.transaction.id, compra.transaction.id], counterpartAccountId: cdb.id });
    expect(done).toMatchObject({ converted: 2, merged: 1 });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: saidaCdb.transaction.id } })).deletedAt).not.toBeNull();
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, type: "TRANSFER", deletedAt: null } })).toBe(2);
    // Tudo era movimentação interna: o patrimônio volta à soma dos saldos iniciais (antes, a aplicação
    // aparecia como despesa e o outro lado do resgate como uma segunda saída).
    expect(totalBefore).toBe(100_000 + 500_000 - 30_000);
    expect((await balance(fam, itau.id)) + (await balance(fam, cdb.id))).toBe(100_000 + 500_000);
    expect(await balance(fam, itau.id)).toBe(100_000 + 150_000 - 30_000);
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, entityId: resgate.transaction.id, source: { contains: "transferência" } } })).toBeGreaterThan(0);

    // Converter de novo não faz nada (já é transferência).
    const again = await convertToTransfers(fam.ctx, { transactionIds: [resgate.transaction.id], counterpartAccountId: cdb.id });
    expect(again).toMatchObject({ converted: 0, merged: 0, totals: { skip: 1 } });
  });

  it("regra de transferência aplicada a lançamentos anteriores converte receitas/despesas antigas", async () => {
    const { fam, itau } = await family();
    const cdb = await cdbOf(fam);
    await createTransaction(fam.ctx, { type: "INCOME", amountCents: 100000, description: "RESGATE CDB 123", date: "2026-09-02", accountId: itau.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 4000, description: "Padaria", date: "2026-09-03", accountId: itau.id });
    const { createRule } = await import("@/server/modules/categories/service");
    const rule = await createRule(fam.ctx, { name: "CDB", matchField: "DESCRIPTION", matchType: "CONTAINS", pattern: "resgate cdb", setTransferAccountId: cdb.id });
    const res = await applyRuleRetroactively(fam.ctx, rule.id);
    expect(res.applied).toBe(1);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, type: "TRANSFER" } })).toBe(1);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, type: "EXPENSE" } })).toBe(1);
  });
});
