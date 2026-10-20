import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";
import { prisma } from "@/server/db";
import { getAccount, verifyLedgerIntegrity } from "@/server/modules/accounts/service";
import { statementTotals } from "@/server/modules/cards/statements";
import { dashboardSummary } from "@/server/modules/analytics/service";
import { createTransaction } from "@/server/modules/transactions/service";
import { applyRuleRetroactively } from "@/server/modules/categories/service";
import { commitImport, createImportPreview, resolveReviewRule, reviewImportRows, undoImport, updateImportRows } from "@/server/modules/imports/service";
import { createBasicAccounts, createFamily, resetDatabase, type TestFamily } from "./helpers";

/**
 * Confirmar fatura: antes da importação final, cada compra nova fica como "Importar" (padrão) ou
 * "Não importar". O que não é importado fica fora da fatura no app, das parcelas futuras e dos
 * relatórios; saldo e ledger não mudam (compra no cartão não é caixa); desfazer volta tudo.
 */

interface Line {
  fitId: string;
  date: string;
  amount: string;
  name: string;
  type?: string;
}

function cardOfx(lines: Line[]): string {
  const trns = lines
    .map((l) => `<STMTTRN><TRNTYPE>${l.type ?? "DEBIT"}</TRNTYPE><DTPOSTED>${l.date}</DTPOSTED><TRNAMT>${l.amount}</TRNAMT><FITID>${l.fitId}</FITID><MEMO>${l.name}</MEMO></STMTTRN>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID><CCSTMTRS><CURDEF>BRL</CURDEF>
<CCACCTFROM><ACCTID>4321</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261231</DTEND>
${trns}
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const OCT = { start: "2026-10-01", end: "2026-10-31" };
const Q4 = { start: "2026-10-01", end: "2026-12-31" };

/** Saldo das contas, ledger, faturas (por mês) e parcelas: antes × depois. */
async function snapshot(fam: TestFamily, cardId: string) {
  const accounts = await prisma.account.findMany({ where: { householdId: fam.householdId }, orderBy: { name: "asc" }, select: { id: true } });
  const balances = await Promise.all(accounts.map(async (a) => (await getAccount(fam.ctx, a.id)).balanceCents));
  const ledger = await prisma.ledgerEntry.aggregate({ where: { householdId: fam.householdId, transaction: { deletedAt: null } }, _sum: { amountCents: true }, _count: { _all: true } });
  const statements = (await statementTotals(prisma, fam.householdId, { creditCardId: cardId })).filter((t) => t.totalCents !== 0).map((t) => [t.referenceMonth, t.totalCents]);
  const installments = await prisma.installment.count({ where: { householdId: fam.householdId, transaction: { deletedAt: null } } });
  return { balances, ledger: { count: ledger._count._all, sum: ledger._sum.amountCents ?? 0 }, statements, installments };
}

describe("Confirmar fatura (importar / não importar)", () => {
  afterAll(async () => {
    await rm(path.join(path.resolve(env().STORAGE_DIR), "imports"), { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it("2 compras 'Não importar' (uma parcelada): total, saldo, parcelas futuras e relatórios; desfazer volta tudo", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const initial = await snapshot(fam, card.id);
    expect(initial.statements).toEqual([]);

    const ofx = cardOfx([
      { fitId: "C1", date: "20261005", amount: "89.90", name: "RESTAURANTE SABOR" },
      { fitId: "C2", date: "20261006", amount: "600.00", name: "LOJA DO AMIGO" },
      { fitId: "C3", date: "20261007", amount: "300.00", name: "ELETRONICOS XYZ PARC 01/03" },
      { fitId: "C4", date: "20261008", amount: "45.00", name: "FARMACIA" },
      { fitId: "C5", date: "20261009", amount: "-500.00", name: "PAGAMENTO RECEBIDO", type: "CREDIT" },
      { fitId: "C6", date: "20261010", amount: "12.34", name: "IOF COMPRA INTERNACIONAL" },
    ]);
    const preview = await createImportPreview(fam.ctx, { fileName: "fatura-outubro.ofx", contentBase64: b64(ofx), creditCardId: card.id });
    const row = new Map(preview.rows.map((r) => [r.externalId, r]));
    // Padrão: todas as compras novas como "Importar"; pagamento da fatura não é compra.
    expect(preview.review).toMatchObject({ scope: "CARD", purchases: 5, fileTotalCents: 104_724, appTotalCents: 104_724, differenceCents: 0, notImportedCount: 0, warning: null, suggestions: [] });
    expect(preview.review.ignoredCredits).toEqual({ count: 1, cents: 50_000 });
    expect(row.get("C1")!.review).toEqual({ decision: "IMPORT", source: "DEFAULT", skipRuleId: null });
    expect(row.get("C5")!.review).toBeNull();
    // Parcelada: a escolha vale para a compra inteira; filtros (parcelada, internacional, estabelecimento).
    expect(row.get("C3")).toMatchObject({ wholePurchase: { installments: 3, totalCents: 90_000 }, flags: { installment: true, international: false } });
    expect(row.get("C6")!.flags).toEqual({ installment: false, international: true });
    expect(row.get("C2")!.merchantLabel).toBe("LOJA DO");

    await expect(reviewImportRows(fam.ctx, preview.batch.id, { rows: [{ rowId: row.get("C5")!.id, decision: "SKIP" }] })).rejects.toThrow(/compras novas/);

    const reviewed = await reviewImportRows(fam.ctx, preview.batch.id, {
      rows: [
        { rowId: row.get("C2")!.id, decision: "SKIP" },
        { rowId: row.get("C3")!.id, decision: "SKIP" },
      ],
    });
    // Total sempre visível: o "não importar" vira diferença, com o aviso de que a fatura vai ficar menor.
    expect(reviewed.review).toMatchObject({ fileTotalCents: 104_724, appTotalCents: 14_724, differenceCents: 90_000, notImportedCount: 2 });
    expect(reviewed.review.decisions).toEqual({ IMPORT: { count: 3, cents: 14_724 }, SKIP: { count: 2, cents: 90_000 } });
    expect(reviewed.review.warning).toMatch(/fatura no app vai ficar R\$\s900,00 menor que a do banco/);
    const r2 = new Map(reviewed.rows.map((r) => [r.externalId, r]));
    expect(r2.get("C2")).toMatchObject({ selected: false, review: { decision: "SKIP", source: "MANUAL" } });
    // Voltar para "Importar" e de novo "Não importar" (a escolha é reversível na prévia).
    await reviewImportRows(fam.ctx, preview.batch.id, { rows: [{ rowId: row.get("C2")!.id, decision: "IMPORT" }] });
    await reviewImportRows(fam.ctx, preview.batch.id, { rows: [{ rowId: row.get("C2")!.id, decision: "SKIP" }] });

    expect(await snapshot(fam, card.id)).toEqual(initial);
    const committed = await commitImport(fam.ctx, preview.batch.id);
    expect(committed.result).toMatchObject({ created: 3, errors: 0 });

    // Fatura: só as 3 compras importadas; a parcelada não gerou nenhuma parcela (nem as futuras).
    const after = await snapshot(fam, card.id);
    expect(after.balances).toEqual(initial.balances);
    expect(after.ledger).toEqual(initial.ledger);
    expect(after.statements.reduce((s, [, total]) => s + (total as number), 0)).toBe(14_724);
    expect(after.installments).toBe(3);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, description: { in: ["LOJA DO AMIGO", "ELETRONICOS XYZ PARC 01/03"] } } })).toBe(0);
    expect((await verifyLedgerIntegrity(fam.householdId)).ok).toBe(true);
    // Relatórios: só o que foi importado (nos 3 meses, nada da parcelada).
    expect((await dashboardSummary(fam.ctx, { period: OCT, regime: "ACCRUAL" })).expenseCents).toBe(14_724);
    expect((await dashboardSummary(fam.ctx, { period: Q4, regime: "CASH" })).expenseCents).toBe(14_724);

    // Fatura seguinte: a parcela 2/3 da compra não importada não casa com nada (fica desmarcada).
    const next = await createImportPreview(fam.ctx, {
      fileName: "fatura-novembro.ofx",
      contentBase64: b64(cardOfx([{ fitId: "N1", date: "20261107", amount: "300.00", name: "ELETRONICOS XYZ PARC 02/03" }])),
      creditCardId: card.id,
    });
    expect(next.rows[0]).toMatchObject({ status: "NEW", selected: false, review: { decision: "SKIP", source: "DEFAULT" } });

    // Desfazer: tudo volta ao estado inicial.
    await undoImport(fam.ctx, preview.batch.id);
    expect(await snapshot(fam, card.id)).toEqual(initial);
    expect((await dashboardSummary(fam.ctx, { period: Q4, regime: "ACCRUAL" })).expenseCents).toBe(0);
  });

  it("'Não importar' 2 vezes oferece 'Sempre não importar compras de X neste cartão?'; a próxima fatura já vem desmarcada", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const first = await createImportPreview(fam.ctx, {
      fileName: "set.ofx",
      contentBase64: b64(
        cardOfx([
          { fitId: "A1", date: "20261005", amount: "45.00", name: "APP STREAMING FILHO" },
          { fitId: "A2", date: "20261006", amount: "80.00", name: "FARMACIA" },
        ]),
      ),
      creditCardId: card.id,
    });
    const a1 = first.rows.find((r) => r.externalId === "A1")!;
    // Desmarcar pelo seletor também é "Não importar".
    const unchecked = await updateImportRows(fam.ctx, first.batch.id, [{ rowId: a1.id, selected: false }]);
    expect(unchecked.rows.find((r) => r.id === a1.id)!.review).toMatchObject({ decision: "SKIP", source: "MANUAL" });
    // Uma marcação só ainda não sugere regra.
    expect(unchecked.review.suggestions).toEqual([]);
    await commitImport(fam.ctx, first.batch.id);

    const second = await createImportPreview(fam.ctx, {
      fileName: "out.ofx",
      contentBase64: b64(
        cardOfx([
          { fitId: "B1", date: "20261105", amount: "45.00", name: "APP STREAMING FILHO" },
          { fitId: "B2", date: "20261106", amount: "60.00", name: "PADARIA" },
        ]),
      ),
      creditCardId: card.id,
    });
    const b1 = second.rows.find((r) => r.externalId === "B1")!;
    expect(b1.review).toMatchObject({ decision: "IMPORT" });
    const marked = await reviewImportRows(fam.ctx, second.batch.id, { rows: [{ rowId: b1.id, decision: "SKIP" }] });
    expect(marked.review.suggestions).toHaveLength(1);
    const s = marked.review.suggestions[0]!;
    expect(s).toMatchObject({ matchType: "CONTAINS", timesMarked: 2, alsoApplies: 0 });
    expect(s.label).toBe('Sempre não importar compras de "APP STREAMING FILHO" neste cartão?');

    // "Agora não": não sugere de novo nesta importação.
    const dismissed = await resolveReviewRule(fam.ctx, second.batch.id, { key: s.key, accept: false });
    expect(dismissed.review.suggestions).toEqual([]);
    expect(dismissed.rule).toBeNull();
    await commitImport(fam.ctx, second.batch.id);

    // Na terceira fatura, aceita: cria a regra e desmarca as compras parecidas do arquivo.
    const third = await createImportPreview(fam.ctx, {
      fileName: "nov.ofx",
      contentBase64: b64(
        cardOfx([
          { fitId: "C1", date: "20261205", amount: "45.00", name: "APP STREAMING FILHO" },
          { fitId: "C2", date: "20261206", amount: "19.90", name: "APP STREAMING FILHO EXTRA" },
        ]),
      ),
      creditCardId: card.id,
    });
    const reviewed = await reviewImportRows(fam.ctx, third.batch.id, { rows: [{ rowId: third.rows.find((r) => r.externalId === "C1")!.id, decision: "SKIP" }] });
    expect(reviewed.review.suggestions[0]).toMatchObject({ timesMarked: 3, alsoApplies: 1 });
    const ok = await resolveReviewRule(fam.ctx, third.batch.id, { key: reviewed.review.suggestions[0]!.key, accept: true });
    expect(ok.appliedRows).toBe(1);
    expect(ok.rows.find((r) => r.externalId === "C2")).toMatchObject({ selected: false, review: { decision: "SKIP", source: "RULE", skipRuleId: ok.rule!.id } });
    expect(ok.review.suggestions).toEqual([]);
    const rule = await prisma.financialRule.findUniqueOrThrow({ where: { id: ok.rule!.id } });
    expect(rule).toMatchObject({ skipOnImport: true, minAmountCents: null, matchCreditCardId: card.id, setExcludeFromReports: false, setCategoryId: null, setScope: null });
    await commitImport(fam.ctx, third.batch.id);
    expect((await prisma.financialRule.findUniqueOrThrow({ where: { id: rule.id } })).timesApplied).toBe(1);

    const fourth = await createImportPreview(fam.ctx, {
      fileName: "dez.ofx",
      contentBase64: b64(cardOfx([{ fitId: "D1", date: "20261215", amount: "45.00", name: "APP STREAMING FILHO" }])),
      creditCardId: card.id,
    });
    expect(fourth.rows[0]).toMatchObject({ selected: false, review: { decision: "SKIP", source: "RULE", skipRuleId: rule.id } });
    expect(fourth.rows[0]!.message).toMatch(/não importar/);
    expect(fourth.batch.warnings.join(" ")).toMatch(/regra "não importar"/);
    // Marcar de novo vale sobre a regra só nesta compra.
    const back = await updateImportRows(fam.ctx, fourth.batch.id, [{ rowId: fourth.rows[0]!.id, selected: true }]);
    expect(back.rows[0]!.review).toEqual({ decision: "IMPORT", source: "DEFAULT", skipRuleId: null });

    // A regra "não importar" não mexe em lançamentos fora da importação nem nos já registrados.
    const manual = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 4_500, description: "APP STREAMING FILHO", date: "2026-12-16", creditCardId: card.id, paymentMethod: "CREDIT_CARD" });
    expect(manual.transaction.status).toBe("CONFIRMED");
    await expect(applyRuleRetroactively(fam.ctx, rule.id)).rejects.toThrow(/próximas importações/);
  });

  it("conta bancária: conferência opcional das saídas com o mesmo total e aviso de saldo", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const csv = "Data;Descrição;Valor\n05/10/2026;Mercado;-120,00\n06/10/2026;Pix recebido;500,00\n07/10/2026;Transferência para amigo;-200,00";
    const { createImportPreviewFromBuffer } = await import("@/server/modules/imports/service");
    const preview = await createImportPreviewFromBuffer(fam.ctx, { fileName: "extrato.csv", content: Buffer.from(csv, "utf8"), accountId: itau.id });
    expect(preview.review).toMatchObject({ scope: "ACCOUNT", purchases: 2, fileTotalCents: 32_000, differenceCents: 0 });
    const before = (await getAccount(fam.ctx, itau.id)).balanceCents;
    const skip = preview.rows.find((r) => r.description === "Transferência para amigo")!;
    const reviewed = await reviewImportRows(fam.ctx, preview.batch.id, { rows: [{ rowId: skip.id, decision: "SKIP" }] });
    expect(reviewed.review).toMatchObject({ appTotalCents: 12_000, differenceCents: 20_000, notImportedCount: 1 });
    expect(reviewed.review.warning).toMatch(/saldo não vai bater/);
    await commitImport(fam.ctx, preview.batch.id);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(before - 12_000 + 50_000);
    await undoImport(fam.ctx, preview.batch.id);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(before);
  });
});
