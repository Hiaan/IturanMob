import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import type { ServiceContext } from "@/server/auth/context";
import { createAccount } from "@/server/modules/accounts/service";
import { createCard } from "@/server/modules/cards/service";
import { createTransaction } from "@/server/modules/transactions/service";
import { upsertBudget } from "@/server/modules/budgets/service";
import { getImportPreview } from "@/server/modules/imports/service";
import {
  applyMigrationSuggestions,
  backToReady,
  createMigrationDestination,
  discardMigration,
  getMigration,
  listMigrationTemplates,
  requestMigrationCommit,
  requestMigrationPreview,
  startMigration,
  undoMigration,
  updateMigrationCorrespondences,
  updateMigrationOptions,
  updateMigrationSheets,
} from "@/server/modules/migration/service";
import type { Correspondence, MigrationDTO } from "@/server/modules/migration/types";
import { categoryMatrix, messySheet, monthlySheets, simpleList } from "../fixtures/migration/build";
import { categoryId, createFamily, resetDatabase, subcategory } from "./helpers";

/** Estado financeiro comparável antes/depois (saldos, ledger, faturas, contas a pagar, orçamentos). */
async function snapshot(householdId: string) {
  const accounts = await prisma.account.findMany({ where: { householdId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, initialBalanceCents: true, initialBalanceDate: true } });
  const balances: Record<string, number> = {};
  for (const a of accounts) {
    const s = await prisma.ledgerEntry.aggregate({ where: { accountId: a.id }, _sum: { amountCents: true } });
    balances[a.name] = a.initialBalanceCents + (s._sum.amountCents ?? 0);
  }
  const ledger = await prisma.ledgerEntry.aggregate({ where: { householdId }, _sum: { amountCents: true }, _count: { _all: true } });
  const installments = await prisma.installment.groupBy({ by: ["statementId"], where: { householdId }, _sum: { amountCents: true } });
  const statements = await prisma.creditCardStatement.findMany({ where: { householdId }, select: { id: true, referenceMonth: true, creditCard: { select: { name: true } } } });
  const statementTotals: Record<string, number> = {};
  for (const i of installments) {
    const st = statements.find((s) => s.id === i.statementId)!;
    statementTotals[`${st.creditCard.name}|${st.referenceMonth}`] = i._sum.amountCents ?? 0;
  }
  return {
    accounts: accounts.map((a) => ({ name: a.name, initial: a.initialBalanceCents, date: a.initialBalanceDate.toISOString().slice(0, 10) })),
    balances,
    ledger: { sum: ledger._sum.amountCents ?? 0, count: ledger._count._all },
    statementTotals,
    transactions: await prisma.transaction.count({ where: { householdId, deletedAt: null } }),
    bills: await prisma.scheduledPayment.count({ where: { householdId } }),
    budgets: await prisma.budget.findMany({ where: { householdId }, orderBy: [{ month: "asc" }, { categoryId: "asc" }], select: { categoryId: true, month: true, limitCents: true } }),
    categories: await prisma.category.count({ where: { householdId, archivedAt: null } }),
    subcategories: await prisma.subcategory.count({ where: { householdId, archivedAt: null } }),
    cards: await prisma.creditCard.count({ where: { householdId, archivedAt: null } }),
  };
}

function item(m: MigrationDTO, field: Correspondence["field"], label: string): Correspondence {
  const c = m.correspondences.find((x) => x.field === field && x.label === label);
  if (!c) throw new Error(`correspondência ${field}:${label} não encontrada (${m.correspondences.filter((x) => x.field === field).map((x) => x.label).join(", ")})`);
  return c;
}

describe("migração de planilha", () => {
  let ctx: ServiceContext;
  let householdId: string;
  let husbandId: string;
  let wifeId: string;

  beforeEach(async () => {
    await resetDatabase();
    const fam = await createFamily();
    ctx = fam.ctx;
    householdId = fam.householdId;
    husbandId = fam.husbandId;
    wifeId = fam.wifeId;
  });

  it("planilha bagunçada: lê as abas, sugere o De → Para, importa por destino e desfaz tudo", async () => {
    const itau = await createAccount(ctx, { name: "Itaú Corrente", institution: "Itaú", type: "CHECKING", initialBalanceCents: 300_000, initialBalanceDate: "2025-06-01" });
    const poupanca = await createAccount(ctx, { name: "Poupança Itaú", institution: "Itaú", type: "SAVINGS", initialBalanceCents: 100_000, initialBalanceDate: "2025-06-01" });
    const nubank = await createCard(ctx, { name: "Nubank", issuer: "Nubank", closingDay: 25, dueDay: 5, paymentAccountId: itau.id });
    // Já registrado pelo WhatsApp: a linha da planilha concilia, não duplica.
    await createTransaction(ctx, { type: "EXPENSE", amountCents: 15_000, description: "Mercado", date: "2025-01-05", accountId: itau.id, paymentMethod: "DEBIT_CARD" }, { source: "WHATSAPP_TEXT" });
    const before = await snapshot(householdId);

    let m = await startMigration(ctx, { fileName: "planilha-baguncada.xlsx", content: await messySheet() });
    expect(m.status).toBe("READY");
    expect(m.format).toBe("XLSX");

    // Abas: capa e gráfico ignorados (com o motivo), lista selecionada, aba oculta fora.
    const byName = Object.fromEntries(m.sheets.map((s) => [s.name, s]));
    expect(byName["Lançamentos 2025"]!.kind).toBe("LIST");
    expect(byName["Lançamentos 2025"]!.selected).toBe(true);
    expect(byName["Lançamentos 2025"]!.ignoredRows).toBe(3); // Total Janeiro, Subtotal, Saldo final
    expect(byName["Capa"]!.selected).toBe(false);
    expect(byName["Gráfico"]!.kind).toBe("SUMMARY");
    expect(byName["Gráfico"]!.reason).toMatch(/ignorada/);
    expect(byName["Listas"]!.hidden).toBe(true);
    expect(byName["Listas"]!.selected).toBe(false);

    // Sugestões: igual, parecido, sinônimo; contas/cartões e pessoas.
    expect(item(m, "category", "Combustivel").suggestion).toMatchObject({ label: "Transporte › Combustível", source: "EXACT" });
    expect(item(m, "category", "Luz").suggestion).toMatchObject({ label: "Moradia › Energia" });
    expect(item(m, "category", "Restaurante").suggestion).toMatchObject({ label: "Alimentação › Restaurantes", source: "SIMILAR" });
    expect(item(m, "category", "Salario").suggestion).toMatchObject({ label: "Trabalho › Salário" });
    expect(item(m, "category", "Diversos").suggestion).toMatchObject({ label: "Outras › Despesas não classificadas", source: "SYNONYM" });
    expect(item(m, "category", "Pets").suggestion).toBeNull();
    const supermercado = item(m, "category", "Supermercado");
    expect(supermercado.count).toBe(2);
    expect(supermercado.outCents).toBe(55_000);
    expect(item(m, "account", "itau").suggestion).toMatchObject({ targetType: "ACCOUNT", targetId: itau.id });
    expect(item(m, "account", "Poupança").suggestion).toMatchObject({ targetType: "ACCOUNT", targetId: poupanca.id });
    expect(item(m, "account", "Nubank Crédito").suggestion).toMatchObject({ targetType: "CARD", targetId: nubank.id });
    expect(item(m, "account", "Dinheiro").suggestion).toBeNull();
    expect(item(m, "person", "João").suggestion).toMatchObject({ targetId: husbandId });
    expect(item(m, "nature", "PJ").suggestion).toMatchObject({ targetId: "BUSINESS" });
    expect(m.ready.canPreview).toBe(false); // contas "Dinheiro" e "Inter PJ" sem decisão

    // Aplica as sugestões, cria a carteira na hora, cria "Pets", ignora a conta PJ.
    m = await applyMigrationSuggestions(ctx, m.id, {});
    m = await createMigrationDestination(ctx, m.id, { field: "account", key: item(m, "account", "Dinheiro").key, kind: "ACCOUNT", name: "Carteira", accountType: "WALLET" });
    m = await updateMigrationCorrespondences(ctx, m.id, {
      items: [
        { field: "category", key: item(m, "category", "Pets").key, decision: { action: "CREATE", name: "Pets", parentId: null, kind: "EXPENSE" } },
        { field: "account", key: item(m, "account", "Inter PJ").key, decision: { action: "IGNORE" } },
      ],
    });
    expect(m.ready).toEqual({ canPreview: true, problems: [] });
    const carteira = m.targets.accounts.find((a) => a.name === "Carteira")!;
    m = await updateMigrationOptions(ctx, m.id, { initialBalances: [{ accountId: carteira.id, mode: "INITIAL", cents: 50_000 }] });

    // Prévia: um lote por destino, transferência vista pelas duas contas entra uma vez.
    m = await requestMigrationPreview(ctx, m.id);
    expect(m.status).toBe("PREVIEW");
    const s = m.summary!;
    const dest = Object.fromEntries(s.destinations.map((d) => [d.name, d]));
    expect(Object.keys(dest).sort()).toEqual(["Carteira", "Itaú Corrente", "Nubank", "Poupança Itaú", "Sem conta ou cartão"]);
    expect(dest["Itaú Corrente"]).toMatchObject({ selectedRows: 5, matchedRows: 1, transfers: 1 });
    expect(dest["Poupança Itaú"]).toMatchObject({ selectedRows: 0, duplicateRows: 1 });
    expect(dest["Nubank"]).toMatchObject({ selectedRows: 4, skippedRows: 2, installmentPurchases: 2 });
    expect(dest["Carteira"]).toMatchObject({ selectedRows: 3 });
    expect(dest["Sem conta ou cartão"]).toMatchObject({ selectedRows: 1 });
    expect(dest["Itaú Corrente"]!.balance).toMatchObject({ isNew: false, rowsBeforeInitial: 4, suggestedInitialCents: 200_000, suggestedFrom: "BALANCE_COLUMN" });
    expect(dest["Carteira"]!.balance).toMatchObject({ isNew: true, needsInitialBalance: false });
    expect(s.bills.map((b) => [b.description, b.dueDate, b.amountCents]).sort()).toEqual([
      ["Conta de água", "2025-03-20", 9_540],
      ["IPTU parcela única", "2099-02-10", 120_000],
    ]);
    expect(s.createdCategories).toEqual(["Pets"]);
    expect(s.createdAccounts).toEqual(["Carteira"]);
    expect(s.period).toEqual({ start: "2025-01-03", end: "2025-06-15" });

    const cardBatch = await getImportPreview(ctx, dest["Nubank"]!.batchId);
    const fridge = cardBatch.rows.find((r) => r.description?.startsWith("Geladeira Brastemp (parcelas 3 a 10"))!;
    expect(fridge.installmentPlan).toEqual({ count: 8, amountCents: 200_000, firstNumber: 3, ofTotal: 10 });
    expect(fridge.location).toEqual({ sheet: "Lançamentos 2025", row: 17 });
    expect(cardBatch.rows.filter((r) => r.status === "SKIPPED").map((r) => r.message)).toEqual([expect.stringMatching(/Parcela 4\/10 já incluída/), expect.stringMatching(/Parcela 5\/10 já incluída/)]);

    // Importa.
    m = await requestMigrationCommit(ctx, m.id);
    expect(m.status).toBe("IMPORTED");
    expect(m.result).toMatchObject({ created: 13, matched: 1, errors: 0, bills: 2, templateSaved: true });

    const after = await snapshot(householdId);
    // Conta existente: o histórico anterior ao saldo inicial não muda o saldo de hoje (só a linha de junho).
    expect(after.balances["Itaú Corrente"]).toBe(before.balances["Itaú Corrente"]! - 40_000);
    expect(after.accounts.find((a) => a.name === "Itaú Corrente")).toEqual({ name: "Itaú Corrente", initial: 300_000 - 495_773, date: "2025-01-03" });
    expect(after.balances["Poupança Itaú"]).toBe(before.balances["Poupança Itaú"]);
    expect(after.balances["Carteira"]).toBe(50_000 - 8_990 - 12_000 - 6_000);
    // Faturas: posto + restaurante (paga pela linha da planilha), notebook 10×500, geladeira 8×250.
    expect(after.statementTotals["Nubank|2025-02"]).toBe(35_250);
    expect(after.statementTotals["Nubank|2025-03"]).toBe(50_000);
    expect(after.statementTotals["Nubank|2025-04"]).toBe(75_000);
    expect(after.statementTotals["Nubank|2025-11"]).toBe(75_000);
    expect(after.statementTotals["Nubank|2025-12"]).toBe(50_000);
    expect(await prisma.installment.count({ where: { householdId } })).toBe(20);
    expect(after.transactions).toBe(before.transactions + 13);
    expect(after.bills).toBe(before.bills + 2);
    // Valores de cartão não são caixa: a compra parcelada não mexe em conta nenhuma.
    const notebook = await prisma.transaction.findFirstOrThrow({ where: { householdId, description: "Notebook Dell" } });
    expect(notebook).toMatchObject({ creditCardId: nubank.id, accountId: null, installmentCount: 10, amountCents: 500_000, payerMemberId: husbandId });
    const acme = await prisma.transaction.findFirstOrThrow({ where: { householdId, description: "Serviço cliente Acme" } });
    expect(acme).toMatchObject({ type: "INCOME", accountId: null, scope: "BUSINESS", categoryId: await categoryId(householdId, "Trabalho", "INCOME") });
    const payment = await prisma.transaction.findFirstOrThrow({ where: { householdId, description: "Pagamento fatura Nubank" } });
    expect(payment).toMatchObject({ type: "CARD_PAYMENT", creditCardId: nubank.id, accountId: itau.id });
    const bill = await prisma.scheduledPayment.findFirstOrThrow({ where: { householdId, description: "IPTU parcela única" } });
    expect(bill).toMatchObject({ status: "PENDING", accountId: itau.id, amountCents: 120_000 });
    expect((await listMigrationTemplates(ctx)).length).toBe(1);

    // Desfaz tudo: volta exatamente ao estado anterior.
    m = await undoMigration(ctx, m.id);
    expect(m.status).toBe("UNDONE");
    const undone = await snapshot(householdId);
    expect(undone).toEqual(before);
  });

  it("abas mensais: mês pelo nome da aba, sinal pela categoria, formato lembrado na próxima planilha", async () => {
    let m = await startMigration(ctx, { fileName: "gastos 2025.xlsx", content: await monthlySheets() });
    expect(m.sheets.map((s) => [s.name, s.kind, s.month, s.selected])).toEqual([
      ["Janeiro 2025", "MONTH", "2025-01", true],
      ["Fevereiro 2025", "MONTH", "2025-02", true],
      ["Março", "MONTH", "2025-03", true],
      ["Resumo", "SUMMARY", null, false],
    ]);
    expect(m.sheets[0]!.unsignedAs).toBe("BY_CATEGORY");
    expect(m.sheets[0]!.ignoredRows).toBe(1);
    expect(item(m, "category", "Mercado").suggestion).toMatchObject({ label: "Alimentação › Supermercado", source: "SYNONYM" });
    m = await applyMigrationSuggestions(ctx, m.id, {});
    m = await updateMigrationCorrespondences(ctx, m.id, { items: [{ field: "category", key: item(m, "category", "Pets").key, decision: { action: "CREATE", name: "Pet", parentId: await categoryId(householdId, "Outras"), kind: "EXPENSE" } }] });
    m = await requestMigrationPreview(ctx, m.id);
    const none = m.summary!.destinations.find((d) => d.kind === "NONE")!;
    expect(none.selectedRows).toBe(10);
    expect(none.inCents).toBe(500_000); // Salário (categoria de receita) entra como entrada
    const rows = (await getImportPreview(ctx, none.batchId)).rows;
    expect(rows.find((r) => r.description === "Pet shop")!.date).toBe("2025-03-28");
    expect(rows.find((r) => r.description === "Salário")!.amountCents).toBe(500_000);
    expect(rows.find((r) => r.description === "Gasolina")!.amountCents).toBe(-20_000);
    m = await requestMigrationCommit(ctx, m.id);
    expect(m.result!.created).toBe(10);
    expect(await prisma.subcategory.count({ where: { householdId, name: "Pet" } })).toBe(1);

    // Mesmo formato de novo: abas, colunas e correspondências já vêm preenchidas.
    const again = await startMigration(ctx, { fileName: "gastos 2025 (2).xlsx", content: await monthlySheets() });
    expect(again.template?.name).toBe("gastos 2025");
    expect(again.sheets.filter((s) => s.fromTemplate).length).toBe(3);
    expect(again.correspondences.filter((c) => c.field === "category").every((c) => c.decision && c.fromTemplate)).toBe(true);
    expect(again.pending.category).toBe(0);
    // A segunda vez são duplicados (mesma planilha): a prévia mostra e nada entra em dobro.
    const preview = await requestMigrationPreview(ctx, again.id);
    expect(preview.summary!.destinations[0]!.duplicateRows).toBe(10);
    expect(preview.summary!.totals.selected).toBe(0);
    await discardMigration(ctx, again.id);
  });

  it("matriz categorias × meses: como orçamento (restaura o anterior ao desfazer) ou como totais mensais", async () => {
    const mercado = await subcategory(householdId, "Supermercado");
    await upsertBudget(ctx, { categoryId: mercado.categoryId, month: "2025-01", limitCents: 70_000 });
    const before = await snapshot(householdId);
    let m = await startMigration(ctx, { fileName: "orcamento.xlsx", content: await categoryMatrix() });
    const sheet = m.sheets[0]!;
    expect(sheet.kind).toBe("MATRIX");
    expect(sheet.matrix!.months.map((x) => x.month)).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(m.ready.problems).toContain('Aba "Orçamento 2025": escolha usar como lançamentos consolidados ou como orçamento.');
    m = await updateMigrationSheets(ctx, m.id, { sheets: [{ index: 0, matrixMode: "BUDGET" }] });
    expect(item(m, "category", "Salário").kindHint).toBe("INCOME");
    m = await applyMigrationSuggestions(ctx, m.id, {});
    m = await requestMigrationPreview(ctx, m.id);
    expect(m.error).toBeNull();
    expect(m.summary!.budgets.filter((b) => b.month === "2025-01").map((b) => [b.categoryLabel, b.limitCents, b.previousCents])).toEqual([
      ["Alimentação", 80_000, 70_000],
      ["Lazer", 20_000, null],
      ["Moradia", 15_000, null],
    ]);
    m = await requestMigrationCommit(ctx, m.id);
    expect(m.result!.budgets).toBe(8);
    expect(await prisma.budget.findFirst({ where: { householdId, categoryId: mercado.categoryId, month: "2025-01" } })).toMatchObject({ limitCents: 80_000 });
    m = await undoMigration(ctx, m.id);
    expect(await snapshot(householdId)).toEqual(before);

    // Como totais mensais: um lançamento por categoria e mês, sem pendência de forma de pagamento.
    let t = await startMigration(ctx, { fileName: "orcamento.xlsx", content: await categoryMatrix() });
    t = await updateMigrationSheets(ctx, t.id, { sheets: [{ index: 0, matrixMode: "TRANSACTIONS" }] });
    t = await applyMigrationSuggestions(ctx, t.id, {});
    t = await requestMigrationPreview(ctx, t.id);
    expect(t.summary!.matrixTransactions).toBe(11);
    t = await requestMigrationCommit(ctx, t.id);
    expect(t.result!.created).toBe(11);
    const tx = await prisma.transaction.findFirstOrThrow({ where: { householdId, description: { startsWith: "Mercado — total de" }, date: new Date("2025-02-01T00:00:00Z") } });
    expect(tx).toMatchObject({ amountCents: 85_000, accountId: null, creditCardId: null });
    expect(tx.notes).toMatch(/Importado de planilha \(total do mês\)/);
    expect(await prisma.pendingItem.count({ where: { householdId, type: "MISSING_PAYMENT_METHOD", status: "OPEN" } })).toBe(0);
    const salary = await prisma.transaction.findFirstOrThrow({ where: { householdId, description: { startsWith: "Salário — total de" }, date: new Date("2025-01-01T00:00:00Z") } });
    expect(salary.type).toBe("INCOME");
  });

  it("voltar da prévia mantém as decisões; descartar remove o que foi criado e não foi usado", async () => {
    let m = await startMigration(ctx, { fileName: "lista.xlsx", content: await simpleList() });
    m = await applyMigrationSuggestions(ctx, m.id, {});
    const transporte = item(m, "category", "Transporte");
    expect(transporte.decision).toMatchObject({ label: "Transporte" });
    m = await updateMigrationCorrespondences(ctx, m.id, { items: [{ field: "category", key: item(m, "category", "Assinaturas").key, decision: { action: "CREATE", name: "Streaming da casa", parentId: null, kind: "EXPENSE" } }] });
    m = await requestMigrationPreview(ctx, m.id);
    expect(m.summary!.createdCategories).toEqual(["Streaming da casa"]);
    m = await backToReady(ctx, m.id);
    expect(m.status).toBe("READY");
    expect(item(m, "category", "Assinaturas").decision).toMatchObject({ action: "MAP", label: "Streaming da casa" });
    expect(await prisma.importBatch.count({ where: { migrationId: m.id } })).toBe(0);
    m = await discardMigration(ctx, m.id);
    expect(m.status).toBe("DISCARDED");
    expect(await prisma.category.count({ where: { householdId, name: "Streaming da casa" } })).toBe(0);
  });

  it("valida as decisões e o que falta antes da prévia", async () => {
    let m = await startMigration(ctx, { fileName: "planilha-baguncada.xlsx", content: await messySheet() });
    await expect(requestMigrationPreview(ctx, m.id)).rejects.toThrow(/contas\/cartões/);
    await expect(
      updateMigrationCorrespondences(ctx, m.id, { items: [{ field: "card", key: item(m, "account", "itau").key, decision: { action: "IGNORE" } }] }),
    ).rejects.toThrow(/não encontrado/);
    await expect(
      updateMigrationCorrespondences(ctx, m.id, { items: [{ field: "account", key: item(m, "account", "itau").key, decision: { action: "MAP", targetType: "MEMBER", targetId: wifeId } }] }),
    ).rejects.toThrow(/incompatível/);
    await expect(updateMigrationSheets(ctx, m.id, { sheets: [{ index: 2, selected: true }] })).rejects.toThrow(/Escolha o tipo/);
    m = await updateMigrationSheets(ctx, m.id, { sheets: [{ index: 1, columns: { person: null } }] });
    expect(m.correspondences.some((c) => c.field === "person")).toBe(false);
    await expect(startMigration(ctx, { fileName: "notas.docx", content: Buffer.from("x") })).rejects.toThrow(/\.xlsx, \.xls, \.ods ou \.csv/);
    // Etapa interrompida (servidor reiniciado): sem progresso há 10 min, volta para poder repetir.
    await prisma.$executeRaw`UPDATE "SpreadsheetMigration" SET status = 'PREVIEWING', "updatedAt" = now() - interval '11 minutes' WHERE id = ${m.id}`;
    const recovered = await getMigration(ctx, m.id);
    expect(recovered.status).toBe("READY");
    expect(recovered.error).toMatch(/interrompida/);
        const broken = await startMigration(ctx, { fileName: "quebrada.xlsx", content: Buffer.from("PK\u0003\u0004 corrompido") });
    expect(broken.status).toBe("FAILED");
    expect(broken.error).toMatch(/corrompido|não é uma planilha/);
  });
});
