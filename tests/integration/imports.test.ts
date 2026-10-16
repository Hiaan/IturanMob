import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";
import { NextRequest } from "next/server";
import { createSession } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";
import { createTransaction, getTransaction } from "@/server/modules/transactions/service";
import { getAccount } from "@/server/modules/accounts/service";
import { listStatements } from "@/server/modules/cards/service";
import { dashboardSummary } from "@/server/modules/analytics/service";
import {
  commitImport,
  createImportPreview,
  createImportPreviewFromBuffer,
  getImportPreview,
  getReconciliation,
  listImports,
  previewMapping,
  undoImport,
  updateImportRows,
} from "@/server/modules/imports/service";

interface OfxLine {
  fitId: string;
  date: string; // AAAAMMDD
  amount: string;
  name: string;
  type?: string;
}

function bankOfx(lines: OfxLine[]): string {
  const trns = lines
    .map((l) => `<STMTTRN>\n<TRNTYPE>${l.type ?? (l.amount.startsWith("-") ? "DEBIT" : "CREDIT")}\n<DTPOSTED>${l.date}120000[-3:BRT]\n<TRNAMT>${l.amount}\n<FITID>${l.fitId}\n<MEMO>${l.name}\n</STMTTRN>`)
    .join("\n");
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252

<OFX>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>0260<BRANCHID>0001<ACCTID>12345678-9<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261010
${trns}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1000.00<DTASOF>20261010</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;
}

function cardOfx(lines: OfxLine[]): string {
  const trns = lines
    .map((l) => `<STMTTRN><TRNTYPE>${l.type ?? "DEBIT"}</TRNTYPE><DTPOSTED>${l.date}</DTPOSTED><TRNAMT>${l.amount}</TRNAMT><FITID>${l.fitId}</FITID><MEMO>${l.name}</MEMO></STMTTRN>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID><CCSTMTRS><CURDEF>BRL</CURDEF>
<CCACCTFROM><ACCTID>4321</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20261001</DTSTART><DTEND>20261031</DTEND>
${trns}
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const BANK_LINES: OfxLine[] = [
  { fitId: "F001", date: "20261005", amount: "-245.90", name: "COMPRA CARTAO MERCADO BOM PRECO" },
  { fitId: "F002", date: "20261006", amount: "1500.00", name: "PIX RECEBIDO CLIENTE ACME" },
  { fitId: "F003", date: "20261007", amount: "-115.00", name: "FARMACIA SAO JOAO" },
  { fitId: "F004", date: "20261008", amount: "-12.50", name: "TARIFA PACOTE SERVICOS" },
  { fitId: "F005", date: "20261009", amount: "-300.00", name: "PAGAMENTO FATURA NUBANK" },
  { fitId: "F006", date: "20261010", amount: "0.00", name: "AJUSTE" },
];

describe("importação e conciliação", () => {
  afterAll(async () => {
    // Arquivos de importação gravados pelos testes (área exclusiva deste módulo no armazenamento de teste).
    await rm(path.join(path.resolve(env().STORAGE_DIR), "imports"), { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it("OFX bancário: correspondência com lançamento do WhatsApp, divergência, novos, commit e undo restauram saldos", async () => {
    const fam = await createFamily();
    const { nubank, card } = await createBasicAccounts(fam.ctx);
    // Registrado pelo WhatsApp, sem conta (pendente de forma de pagamento).
    const { transaction: whatsapp } = await createTransaction(
      fam.ctx,
      { type: "EXPENSE", amountCents: 24_590, description: "Mercado", date: "2026-10-04" },
      { source: "WHATSAPP_TEXT", checkDuplicates: false },
    );
    // Registrado no app com valor diferente do extrato.
    const { transaction: farmacia } = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 10_000, description: "Farmácia São João", date: "2026-10-07", accountId: nubank.id });
    const balanceBefore = (await getAccount(fam.ctx, nubank.id)).balanceCents;
    expect(balanceBefore).toBe(90_000);

    const ofx = bankOfx(BANK_LINES);
    const preview = await createImportPreview(fam.ctx, { fileName: "extrato-outubro.ofx", contentBase64: b64(ofx), accountId: nubank.id });
    expect(preview.batch.format).toBe("OFX");
    expect(preview.batch.status).toBe("PREVIEW");
    expect(preview.batch.statement).toMatchObject({ kind: "BANK", bankId: "0260", accountIdMasked: "•••78-9" });
    const byFit = new Map(preview.rows.map((r) => [r.externalId, r]));
    expect(byFit.get("F001")).toMatchObject({ status: "MATCHED", amountCents: -24_590 });
    expect(byFit.get("F001")!.matchedTransaction?.id).toBe(whatsapp.id);
    expect(byFit.get("F002")).toMatchObject({ status: "NEW", amountCents: 150_000, kind: "INCOME", selected: true });
    expect(byFit.get("F003")).toMatchObject({ status: "DIVERGENT", amountCents: -11_500 });
    expect(byFit.get("F003")!.matchedTransaction?.id).toBe(farmacia.id);
    expect(byFit.get("F004")).toMatchObject({ status: "NEW", kind: "EXPENSE" });
    expect(byFit.get("F005")).toMatchObject({ status: "NEW", kind: "CARD_PAYMENT" });
    expect(byFit.get("F006")).toMatchObject({ status: "SKIPPED", selected: false });
    expect(preview.counts).toMatchObject({ total: 6, NEW: 3, MATCHED: 1, DIVERGENT: 1, SKIPPED: 1, selectedNew: 3 });

    // Categoria escolhida pelo usuário na prévia.
    const tarifas = await prisma.category.findFirstOrThrow({ where: { householdId: fam.householdId, kind: "EXPENSE", name: "Moradia" } });
    await updateImportRows(fam.ctx, preview.batch.id, [{ rowId: byFit.get("F004")!.id, categoryId: tarifas.id }]);
    await expect(updateImportRows(fam.ctx, preview.batch.id, [{ rowId: byFit.get("F002")!.id, categoryId: tarifas.id }])).rejects.toThrow(/categoria de receita/);
    await expect(updateImportRows(fam.ctx, preview.batch.id, [{ rowId: byFit.get("F006")!.id, selected: true }])).rejects.toThrow(/não pode ser selecionada/);

    const committed = await commitImport(fam.ctx, preview.batch.id);
    expect(committed.result).toMatchObject({ created: 3, matched: 1, divergent: 1, errors: 0 });
    expect(committed.batch.status).toBe("IMPORTED");
    expect(committed.batch.importedRows).toBe(3);

    // Saldo: + receita − tarifa − pagamento de fatura − mercado (agora conciliado com a conta).
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(90_000 + 150_000 - 1_250 - 30_000 - 24_590);
    const linked = await getTransaction(fam.ctx, whatsapp.id);
    expect(linked.account?.id).toBe(nubank.id);
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, transactionId: whatsapp.id, type: "MISSING_PAYMENT_METHOD", status: "OPEN" } })).toBe(0);

    const imported = await prisma.transaction.findMany({ where: { importBatchId: preview.batch.id }, orderBy: { date: "asc" } });
    expect(imported.map((t) => [t.type, t.amountCents, t.source])).toEqual([
      ["INCOME", 150_000, "IMPORT"],
      ["EXPENSE", 1_250, "IMPORT"],
      ["CARD_PAYMENT", 30_000, "IMPORT"],
    ]);
    expect(imported[1]!.categoryId).toBe(tarifas.id);
    expect(imported[2]!.creditCardId).toBe(card.id);
    expect(imported[0]!.paymentMethod).toBe("PIX");

    // Pagamento de fatura não é despesa.
    const summary = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" }, regime: "ACCRUAL" });
    expect(summary.expenseCents).toBe(24_590 + 10_000 + 1_250);
    expect(summary.incomeCents).toBe(150_000);

    const pending = await prisma.pendingItem.findFirstOrThrow({ where: { householdId: fam.householdId, type: "IMPORT_DIVERGENCE" } });
    expect(pending).toMatchObject({ relatedTransactionId: farmacia.id, importRowId: byFit.get("F003")!.id, status: "OPEN" });
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, action: "IMPORT", entityId: preview.batch.id } })).toBe(1);

    // Idempotente: um segundo commit não recria nada.
    const again = await commitImport(fam.ctx, preview.batch.id);
    expect(again.result.alreadyImported).toBe(true);
    expect(await prisma.transaction.count({ where: { importBatchId: preview.batch.id } })).toBe(3);

    // Conciliação.
    const rec = await getReconciliation(fam.ctx, preview.batch.id);
    expect(rec.matched.map((r) => r.externalId)).toEqual(["F001"]);
    expect(rec.notInApp.map((r) => r.externalId).sort()).toEqual(["F002", "F004", "F005"]);
    expect(rec.divergent[0]).toMatchObject({ externalId: "F003", differenceCents: 1_500 });
    expect(rec.missingInStatement).toEqual([]);
    expect(rec.period).toEqual({ start: "2026-10-05", end: "2026-10-10" });

    // Reimportar o mesmo OFX: tudo duplicado, com aviso do arquivo repetido.
    const dup = await createImportPreview(fam.ctx, { fileName: "extrato-outubro.ofx", contentBase64: b64(ofx), accountId: nubank.id });
    expect(dup.batch.warnings[0]).toMatch(/já foi importado nesta conta/);
    expect(dup.rows.filter((r) => r.status !== "SKIPPED").every((r) => r.status === "DUPLICATE")).toBe(true);
    expect(dup.counts.DUPLICATE).toBe(5);
    expect(dup.counts.selectedNew).toBe(0);

    // Desfazer: exclusão lógica das transações criadas e saldos restaurados.
    const undone = await undoImport(fam.ctx, preview.batch.id);
    expect(undone.result).toMatchObject({ alreadyUndone: false, removed: 3 });
    expect(undone.batch.status).toBe("UNDONE");
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(balanceBefore);
    expect((await getTransaction(fam.ctx, whatsapp.id)).account).toBeNull();
    expect(await prisma.transaction.count({ where: { importBatchId: preview.batch.id, deletedAt: null } })).toBe(0);
    expect((await prisma.pendingItem.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("DISMISSED");
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, action: "UNDO_IMPORT", entityId: preview.batch.id } })).toBe(1);
    const deleteAudits = await prisma.auditLog.count({ where: { householdId: fam.householdId, action: "DELETE", entityType: "Transaction", source: "Importação desfeita" } });
    expect(deleteAudits).toBe(3);
    expect((await undoImport(fam.ctx, preview.batch.id)).result.alreadyUndone).toBe(true);
    await expect(commitImport(fam.ctx, preview.batch.id)).rejects.toThrow(/desfeita/);

    // Após desfazer, o mesmo arquivo volta a ser importável (não é mais duplicado).
    const fresh = await createImportPreview(fam.ctx, { fileName: "extrato-outubro.ofx", contentBase64: b64(ofx), accountId: nubank.id });
    expect(fresh.counts.DUPLICATE).toBe(0);
    expect(fresh.counts.NEW).toBe(3);

    const history = await listImports(fam.ctx);
    expect(history.map((h) => h.status)).toEqual(["PREVIEW", "PREVIEW", "UNDONE"]);
  });

  it("OFX de cartão com compras positivas: compras viram despesas no cartão e pagamentos são ignorados", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const ofx = cardOfx([
      { fitId: "C1", date: "20261005", amount: "89.90", name: "RESTAURANTE SABOR" },
      { fitId: "C2", date: "20261006", amount: "150.00", name: "LOJA DE ROUPAS PARC 01/03" },
      { fitId: "C3", date: "20261007", amount: "-500.00", name: "PAGAMENTO RECEBIDO", type: "CREDIT" },
      { fitId: "C4", date: "20261008", amount: "45.00", name: "ELETRONICOS XYZ PARC 02/05" },
      { fitId: "C5", date: "20261009", amount: "30.00", name: "UBER TRIP" },
    ]);
    await expect(createImportPreview(fam.ctx, { fileName: "fatura.ofx", contentBase64: b64(ofx), accountId: (await prisma.account.findFirstOrThrow({ where: { householdId: fam.householdId } })).id })).rejects.toThrow(
      /cartão de crédito/,
    );
    const preview = await createImportPreview(fam.ctx, { fileName: "fatura.ofx", contentBase64: b64(ofx), creditCardId: card.id });
    expect(preview.cardPurchasesPositive).toBe(true);
    const byFit = new Map(preview.rows.map((r) => [r.externalId, r]));
    expect(byFit.get("C1")).toMatchObject({ status: "NEW", amountCents: -8_990, kind: "EXPENSE" });
    expect(byFit.get("C3")).toMatchObject({ status: "SKIPPED", selected: false });
    expect(byFit.get("C3")!.message).toMatch(/Pagamento ou crédito/);
    expect(byFit.get("C2")).toMatchObject({ status: "NEW", selected: true, installment: { number: 1, total: 3 } });
    expect(byFit.get("C4")).toMatchObject({ status: "NEW", selected: false, installment: { number: 2, total: 5 } });
    expect(preview.batch.warnings.join(" ")).toMatch(/pagamento\/crédito/);

    // Deseleciona uma linha nova.
    await updateImportRows(fam.ctx, preview.batch.id, [{ rowId: byFit.get("C5")!.id, selected: false }]);
    const res = await commitImport(fam.ctx, preview.batch.id);
    expect(res.result.created).toBe(2);
    const txs = await prisma.transaction.findMany({ where: { importBatchId: preview.batch.id }, orderBy: { date: "asc" } });
    expect(txs.map((t) => [t.type, t.amountCents, t.creditCardId, t.paymentMethod, t.installmentCount])).toEqual([
      ["EXPENSE", 8_990, card.id, "CREDIT_CARD", 1],
      ["EXPENSE", 45_000, card.id, "CREDIT_CARD", 3],
    ]);
    const statements = await listStatements(fam.ctx, card.id);
    expect(statements.reduce((s, st) => s + st.totalCents, 0)).toBe(8_990 + 45_000);

    // Fatura seguinte: a parcela 2/3 corresponde à compra já registrada.
    const next = await createImportPreview(fam.ctx, {
      fileName: "fatura-novembro.ofx",
      contentBase64: b64(cardOfx([{ fitId: "N1", date: "20261106", amount: "150.00", name: "LOJA DE ROUPAS PARC 02/03" }])),
      creditCardId: card.id,
    });
    expect(next.rows[0]).toMatchObject({ status: "MATCHED" });
    expect(next.rows[0]!.matchedTransaction?.id).toBe(txs[1]!.id);
  });

  it("CSV com mapeamento ajustado pelo usuário e inversão de sinais", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const csv = "Quando;O que;Quanto;Classe\n05/10/2026;Padaria Pão Quente;12,50;Alimentação\n06/10/2026;Venda de bicicleta;-800,00;Outras receitas";
    const preview = await createImportPreviewFromBuffer(fam.ctx, { fileName: "planilha.csv", content: Buffer.from(csv, "utf8"), accountId: itau.id });
    expect(preview.batch.format).toBe("CSV");
    // Cabeçalho desconhecido: colunas detectadas pelo conteúdo (data, descrição e valor).
    expect(preview.mapping).toMatchObject({ date: 0, description: 1, amount: 2, category: null });
    expect(preview.rows.map((r) => r.amountCents)).toEqual([1_250, -80_000]);

    // Arquivo sem colunas reconhecíveis: prévia criada com aviso para ajustar o mapeamento.
    const unknown = await createImportPreviewFromBuffer(fam.ctx, { fileName: "estranho.csv", content: Buffer.from("A;B\nx;y\nz;w", "utf8"), accountId: itau.id });
    expect(unknown.batch.warnings.join(" ")).toMatch(/Ajuste o mapeamento/);
    expect(unknown.counts.ERROR).toBe(unknown.counts.total);

    const remapped = await previewMapping(fam.ctx, preview.batch.id, {
      mapping: { date: 0, description: 1, amount: 2, category: 3, debit: null, credit: null, externalId: null, dateFormat: "dmy" },
      invertSigns: true,
    });
    expect(remapped.rows.map((r) => [r.status, r.amountCents, r.description])).toEqual([
      ["NEW", -1_250, "Padaria Pão Quente"],
      ["NEW", 80_000, "Venda de bicicleta"],
    ]);
    const alimentacao = await prisma.category.findFirstOrThrow({ where: { householdId: fam.householdId, name: "Alimentação", kind: "EXPENSE" } });
    expect(remapped.rows[0]!.categoryId).toBe(alimentacao.id);
    expect(remapped.invertSigns).toBe(true);
    expect(remapped.headers).toEqual(["Quando", "O que", "Quanto", "Classe"]);

    await expect(previewMapping(fam.ctx, preview.batch.id, { mapping: { date: 9, description: 1, amount: 2, debit: null, credit: null, category: null, externalId: null, dateFormat: "auto" } })).rejects.toThrow(
      /não existe/,
    );
    const res = await commitImport(fam.ctx, preview.batch.id);
    expect(res.result.created).toBe(2);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(500_000 - 1_250 + 80_000);
  });

  it("valida limites, permissões e isolamento", async () => {
    const fam = await createFamily();
    const other = await createFamily("Outra família");
    const { nubank } = await createBasicAccounts(fam.ctx);
    const viewer = { ...fam.ctx, role: "VIEWER" as const };
    await expect(createImportPreview(viewer, { fileName: "x.csv", contentBase64: b64("Data;Valor\n01/10/2026;1,00"), accountId: nubank.id })).rejects.toThrow(/permissão/);
    await expect(createImportPreviewFromBuffer(fam.ctx, { fileName: "grande.csv", content: Buffer.alloc(15 * 1024 * 1024 + 1, 65), accountId: nubank.id })).rejects.toThrow(/15 MB/);
    await expect(createImportPreview(other.ctx, { fileName: "x.csv", contentBase64: b64("Data;Valor\n01/10/2026;1,00"), accountId: nubank.id })).rejects.toThrow(/Conta inválida/);
    const many = ["Data;Descrição;Valor", ...Array.from({ length: 5_001 }, (_, i) => `01/10/2026;Linha ${i};-1,00`)].join("\n");
    await expect(createImportPreview(fam.ctx, { fileName: "muitas.csv", contentBase64: b64(many), accountId: nubank.id })).rejects.toThrow(/5\.000 linhas/);

    const ok = await createImportPreview(fam.ctx, { fileName: "ok.csv", contentBase64: b64("Data;Descrição;Valor\n01/10/2026;Café;-5,00"), accountId: nubank.id });
    await expect(getImportPreview(other.ctx, ok.batch.id)).rejects.toThrow(/não encontrad/);
    await expect(commitImport(other.ctx, ok.batch.id)).rejects.toThrow(/não encontrad/);
    expect(await listImports(other.ctx)).toEqual([]);
    // Arquivo original armazenado criptografado (anexo do tipo IMPORT_FILE).
    const attachment = await prisma.attachment.findFirstOrThrow({ where: { householdId: fam.householdId, kind: "IMPORT_FILE" } });
    expect(attachment.storageKey).toMatch(/^imports\//);
  });
  it("rotas da API: upload multipart e JSON, linhas, commit, conciliação e desfazer", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });
    const headers = { cookie: `fa_session=${token}`, origin: "http://localhost:3000" };
    const routes = {
      list: await import("@/app/api/v1/imports/route"),
      item: await import("@/app/api/v1/imports/[id]/route"),
      rows: await import("@/app/api/v1/imports/[id]/rows/route"),
      commit: await import("@/app/api/v1/imports/[id]/commit/route"),
      undo: await import("@/app/api/v1/imports/[id]/undo/route"),
      rec: await import("@/app/api/v1/imports/[id]/reconciliation/route"),
    };
    const ctxOf = (id?: string) => ({ params: Promise.resolve<Record<string, string>>(id ? { id } : {}) });

    const form = new FormData();
    form.append("file", new Blob([bankOfx(BANK_LINES.slice(0, 2))], { type: "application/x-ofx" }), "extrato.ofx");
    form.append("accountId", nubank.id);
    const created = await routes.list.POST(new NextRequest("http://localhost:3000/api/v1/imports", { method: "POST", body: form, headers }), ctxOf());
    expect(created.status).toBe(201);
    const preview = (await created.json()).data as { batch: { id: string }; rows: Array<{ id: string; status: string }> };
    expect(preview.rows.map((r) => r.status)).toEqual(["NEW", "NEW"]);

    const patched = await routes.rows.PATCH(
      new NextRequest(`http://localhost:3000/api/v1/imports/${preview.batch.id}/rows`, {
        method: "PATCH",
        body: JSON.stringify({ rows: [{ rowId: preview.rows[1]!.id, selected: false }] }),
        headers: { ...headers, "content-type": "application/json" },
      }),
      ctxOf(preview.batch.id),
    );
    expect(patched.status).toBe(200);

    const committed = await routes.commit.POST(new NextRequest(`http://localhost:3000/api/v1/imports/${preview.batch.id}/commit`, { method: "POST", headers }), ctxOf(preview.batch.id));
    expect(committed.status).toBe(201);
    expect((await committed.json()).data.result.created).toBe(1);
    const rec = await routes.rec.GET(new NextRequest(`http://localhost:3000/api/v1/imports/${preview.batch.id}/reconciliation`, { headers }), ctxOf(preview.batch.id));
    expect((await rec.json()).data.notInApp).toHaveLength(2);
    const undone = await routes.undo.POST(new NextRequest(`http://localhost:3000/api/v1/imports/${preview.batch.id}/undo`, { method: "POST", headers }), ctxOf(preview.batch.id));
    expect((await undone.json()).data.batch.status).toBe("UNDONE");

    // JSON com base64.
    const json = await routes.list.POST(
      new NextRequest("http://localhost:3000/api/v1/imports", {
        method: "POST",
        body: JSON.stringify({ fileName: "a.csv", contentBase64: b64("Data;Descrição;Valor\n01/10/2026;Café;-5,00"), accountId: nubank.id }),
        headers: { ...headers, "content-type": "application/json" },
      }),
      ctxOf(),
    );
    expect(json.status).toBe(201);
    const invalid = await routes.list.POST(
      new NextRequest("http://localhost:3000/api/v1/imports", { method: "POST", body: JSON.stringify({ fileName: "a.csv" }), headers: { ...headers, "content-type": "application/json" } }),
      ctxOf(),
    );
    expect(invalid.status).toBe(422);
    const listed = await routes.list.GET(new NextRequest("http://localhost:3000/api/v1/imports", { headers }), ctxOf());
    expect((await listed.json()).data).toHaveLength(2);
    const unauth = await routes.item.GET(new NextRequest(`http://localhost:3000/api/v1/imports/${preview.batch.id}`), ctxOf(preview.batch.id));
    expect(unauth.status).toBe(401);
  });
});
