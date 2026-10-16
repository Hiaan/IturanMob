import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";

/**
 * Importação de extratos/faturas em PDF e importação em massa ("confirmar todos").
 * PDFs sintéticos (tests/helpers/pdf-fixtures.ts). Só o provedor de IA é falso (PDF digitalizado);
 * consentimento, resolução do provedor e validação do resultado são o código real.
 */

const fake = vi.hoisted(() => ({ structured: vi.fn() }));

vi.mock("@/server/ai/providers/anthropic", () => ({
  AnthropicProvider: class FakeAnthropicProvider {
    readonly type = "ANTHROPIC";
    readonly supportsVision = true;
    readonly supportsDocuments = true;
    constructor(
      readonly apiKey: string,
      readonly model: string,
    ) {}
    structured(req: unknown) {
      return fake.structured(req);
    }
    runTools() {
      throw new Error("não usado");
    }
  },
}));

import { NextRequest } from "next/server";
import { env } from "@/server/env";
import { prisma } from "@/server/db";
import { createSession } from "@/server/auth/session";
import { getAccount } from "@/server/modules/accounts/service";
import { bulkCommitImports, commitImport, createImportPreviewFromBuffer, previewMapping, updateImportRows } from "@/server/modules/imports/service";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";
import { enableExternalAI } from "./ai-pipeline-support";
import * as F from "../helpers/pdf-fixtures";

const c = (text: string, x: number) => ({ text, x });

/** Segundo extrato do Itaú, com período sobreposto ao ITAU_EXTRATO (05/10 e 10/10 aparecem nos dois). */
const ITAU_EXTRATO_2: F.FixtureLine[][] = [
  [
    "Itaú Unibanco S.A.   extrato conta corrente",
    "agência 1234  conta 56789-0   período de 05/10/2026 a 14/10/2026",
    [c("data", 40), c("lançamentos", 110), c("valor (R$)", 380), c("saldo (R$)", 480)],
    [c("05/10/2026", 40), c("TAR PACOTE ITAU", 110), c("-39,90", 380), c("7.714,20", 480)],
    [c("10/10/2026", 40), c("ITAU UNICLASS FATURA CARTAO", 110), c("-1.234,56", 380)],
    [c("12/10/2026", 40), c("PIX ENVIADO JOAO", 110), c("-50,00", 380)],
  ],
];

function itauOfx(lines: Array<{ fitId: string; date: string; amount: string; name: string }>): string {
  const trns = lines
    .map((l) => `<STMTTRN>\n<TRNTYPE>${l.amount.startsWith("-") ? "DEBIT" : "CREDIT"}\n<DTPOSTED>${l.date}120000[-3:BRT]\n<TRNAMT>${l.amount}\n<FITID>${l.fitId}\n<MEMO>${l.name}\n</STMTTRN>`)
    .join("\n");
  return `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>BRL\n<BANKACCTFROM><BANKID>0341<BRANCHID>1234<ACCTID>56789-0<ACCTTYPE>CHECKING</BANKACCTFROM>\n<BANKTRANLIST><DTSTART>20261001<DTEND>20261015\n${trns}\n</BANKTRANLIST>\n</STMTRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>`;
}

async function pdfPreview(fam: Awaited<ReturnType<typeof createFamily>>, fileName: string, pdf: Buffer, scope: { accountId?: string; creditCardId?: string } = {}) {
  return createImportPreviewFromBuffer(fam.ctx, { fileName, content: pdf, ...scope });
}

describe("Importação de PDF e importação em massa", () => {
  beforeEach(async () => {
    await resetDatabase();
    fake.structured.mockReset();
  });
  afterAll(async () => {
    await rm(path.resolve(env().STORAGE_DIR), { recursive: true, force: true });
  });

  it("extrato em PDF entra na mesma prévia: formato PDF, banco identificado, saldo ignorado e confirmação grava", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const before = (await getAccount(fam.ctx, itau.id)).balanceCents;
    const preview = await pdfPreview(fam, "itau-outubro.pdf", await F.makePdf(F.ITAU_EXTRATO), { accountId: itau.id });
    expect(preview.batch).toMatchObject({ format: "PDF", account: { id: itau.id } });
    expect(preview.batch.statement).toMatchObject({ kind: "BANK", bank: "Itaú", source: "TEXT", startDate: "2026-10-01", endDate: "2026-10-15" });
    expect(preview.rows.map((r) => [r.date, r.amountCents, r.kind])).toEqual([
      ["2026-10-02", -24590, "EXPENSE"],
      ["2026-10-03", 650000, "INCOME"],
      ["2026-10-05", -3990, "EXPENSE"],
      // Pagamento de fatura no extrato: não é despesa (vira pagamento do cartão).
      ["2026-10-10", -123456, "CARD_PAYMENT"],
    ]);
    expect(preview.rows[0]!.cells).toMatchObject({ Página: "1" });
    expect(preview.batch.warnings.join(" ")).toContain("deduzida pela descrição");

    const done = await commitImport(fam.ctx, preview.batch.id);
    expect(done.result).toMatchObject({ created: 4, duplicatesAtCommit: 0 });
    const txs = await prisma.transaction.findMany({ where: { householdId: fam.householdId, importBatchId: preview.batch.id }, orderBy: { date: "asc" } });
    expect(txs.map((t) => [t.type, t.amountCents])).toEqual([
      ["EXPENSE", 24590],
      ["INCOME", 650000],
      ["EXPENSE", 3990],
      ["CARD_PAYMENT", 123456],
    ]);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(before - 24590 + 650000 - 3990 - 123456);
  });

  it("sem destino escolhido, usa a conta/cartão do banco identificado; tipo trocado vira aviso e nada fica selecionado", async () => {
    const fam = await createFamily();
    const { nubank, itau, card } = await createBasicAccounts(fam.ctx);

    const conta = await pdfPreview(fam, "nubank-conta.pdf", await F.makePdf(F.NUBANK_CONTA));
    expect(conta.batch.account?.id).toBe(nubank.id);
    expect(conta.batch.warnings[0]).toContain("Conta escolhida automaticamente pelo banco do PDF (Nubank): Nubank");

    const fatura = await pdfPreview(fam, "nubank-fatura.pdf", await F.makePdf(F.NUBANK_FATURA));
    expect(fatura.batch.creditCard?.id).toBe(card.id);
    // Compras viram despesas do cartão; o pagamento da fatura é ignorado (registrado na conta pagadora).
    expect(fatura.rows.filter((r) => r.status === "NEW").map((r) => r.amountCents)).toEqual([-2345, -12990, -5590, -240]);
    expect(fatura.rows.find((r) => r.description?.startsWith("Pagamento"))!.status).toBe("SKIPPED");

    // Fatura enviada para uma conta: aviso em destaque e nenhuma linha selecionada.
    const errada = await pdfPreview(fam, "fatura-na-conta.pdf", await F.makePdf(F.NUBANK_FATURA), { accountId: itau.id });
    expect(errada.batch.warnings[0]).toContain("parece uma FATURA DE CARTÃO");
    expect(errada.counts.selectedNew).toBe(0);
    const res = await commitImport(fam.ctx, errada.batch.id);
    expect(res.result.created).toBe(0);
  });

  it("confirmar todos: arquivos sobrepostos (PDF + PDF + OFX) não duplicam lançamentos", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const a = await pdfPreview(fam, "itau-1.pdf", await F.makePdf(F.ITAU_EXTRATO), { accountId: itau.id });
    const b = await pdfPreview(fam, "itau-2.pdf", await F.makePdf(ITAU_EXTRATO_2), { accountId: itau.id });
    // O mesmo extrato em OFX (descrições diferentes) com um lançamento novo.
    const ofx = itauOfx([
      { fitId: "X1", date: "20261002", amount: "-245.90", name: "PIX MERCADO BOM LTDA" },
      { fitId: "X2", date: "20261013", amount: "-80.00", name: "FARMACIA" },
    ]);
    const cPrev = await createImportPreviewFromBuffer(fam.ctx, { fileName: "itau.ofx", content: Buffer.from(ofx), accountId: itau.id });
    // A prévia avisa que o segundo PDF repete linhas do primeiro.
    expect(b.batch.warnings.join(" ")).toContain('também aparecem em "itau-1.pdf"');

    const res = await bulkCommitImports(fam.ctx, { batchIds: [a.batch.id, b.batch.id, cPrev.batch.id] });
    expect(res.results.map((r) => [r.fileName, r.ok, r.created, r.duplicatesAtCommit])).toEqual([
      ["itau-1.pdf", true, 4, 0],
      ["itau-2.pdf", true, 1, 2],
      ["itau.ofx", true, 1, 1],
    ]);
    expect(res.totals).toMatchObject({ files: 3, ok: 3, created: 6, duplicatesAtCommit: 3 });
    const all = await prisma.transaction.findMany({ where: { householdId: fam.householdId, source: "IMPORT", deletedAt: null } });
    expect(all).toHaveLength(6);
    expect(all.filter((t) => t.amountCents === 24590)).toHaveLength(1);
    expect(all.filter((t) => t.amountCents === 3990)).toHaveLength(1);
    const dupRow = await prisma.importRow.findFirstOrThrow({ where: { batchId: cPrev.batch.id, status: "DUPLICATE" } });
    expect(dupRow.message).toContain('acabou de ser importado pelo arquivo "itau-1.pdf"');

    // Repetir a confirmação não cria nada (lotes já importados).
    const again = await bulkCommitImports(fam.ctx, { batchIds: [a.batch.id, b.batch.id] });
    expect(again.totals.created).toBe(0);
    expect(again.results.every((r) => r.alreadyImported)).toBe(true);
  });

  it("um arquivo com problema não impede os demais na confirmação em massa", async () => {
    const fam = await createFamily();
    const other = await createFamily("Outra família");
    const { itau } = await createBasicAccounts(fam.ctx);
    const ok = await pdfPreview(fam, "itau.pdf", await F.makePdf(F.ITAU_EXTRATO), { accountId: itau.id });
    const foreign = await createImportPreviewFromBuffer(other.ctx, { fileName: "outra.ofx", content: Buffer.from(itauOfx([{ fitId: "Z", date: "20261002", amount: "-1.00", name: "X" }])) });
    const res = await bulkCommitImports(fam.ctx, { batchIds: [foreign.batch.id, ok.batch.id] });
    expect(res.results[0]).toMatchObject({ ok: false, created: 0 });
    expect(res.results[0]!.error).toMatch(/não encontrad/);
    expect(res.results[1]).toMatchObject({ ok: true, created: 4 });
  });

  it("PDF com senha pede o arquivo sem senha; PDF digitalizado sem IA explica a limitação", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    await expect(pdfPreview(fam, "senha.pdf", await F.makePdf(F.ITAU_EXTRATO, { password: "123456" }), { accountId: itau.id })).rejects.toThrow(/protegido por senha.*sem senha/);
    await expect(pdfPreview(fam, "foto.pdf", await F.makeScannedPdf(), { accountId: itau.id })).rejects.toThrow(/não tem texto.*leitura por IA não está disponível/);
    await expect(pdfPreview(fam, "comprovante.pdf", await F.makePdf(F.PIX_COMPROVANTE), { accountId: itau.id })).rejects.toThrow(/parece um comprovante/);
    await expect(createImportPreviewFromBuffer(fam.ctx, { fileName: "falso.pdf", content: Buffer.from("não é pdf"), accountId: itau.id })).rejects.toThrow(/não é um PDF válido/);
    expect(fake.structured).not.toHaveBeenCalled();
    expect(await prisma.importBatch.count({ where: { householdId: fam.householdId } })).toBe(0);
  });

  it("PDF digitalizado com IA autorizada: a IA lê, a prévia mostra a origem e reprocessar não chama a IA de novo", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    // Sem a autorização para enviar imagens/documentos, a IA não é usada.
    await enableExternalAI(fam, ["RECEIPT_EXTRACTION"], { image: false });
    await expect(pdfPreview(fam, "foto.pdf", await F.makeScannedPdf(), { accountId: itau.id })).rejects.toThrow(/leitura por IA não está disponível/);
    expect(fake.structured).not.toHaveBeenCalled();

    await enableExternalAI(fam, ["RECEIPT_EXTRACTION"], { image: true });
    fake.structured.mockResolvedValue({
      json: {
        is_statement: true,
        kind: "BANK",
        bank: "Itaú",
        rows: [
          { date: "2026-10-02", description: "PIX MERCADO BOM", amount: 245.9, direction: "out" },
          { date: "2026-10-03", description: "SALARIO", amount: 6500, direction: "in" },
          // Linha inválida (data impossível) é descartada, nunca "corrigida".
          { date: "2026-02-31", description: "???", amount: 10, direction: "out" },
        ],
      },
      usage: { inputTokens: 1000, outputTokens: 200 },
    });
    const preview = await pdfPreview(fam, "foto.pdf", await F.makeScannedPdf(), { accountId: itau.id });
    expect(preview.batch.statement).toMatchObject({ source: "AI", bank: "Itaú" });
    expect(preview.rows.map((r) => [r.date, r.amountCents, r.cells.Origem])).toEqual([
      ["2026-10-02", -24590, "Leitura por IA (PDF sem texto)"],
      ["2026-10-03", 650000, "Leitura por IA (PDF sem texto)"],
    ]);
    expect(preview.batch.warnings.join(" ")).toContain("lidos pela IA");
    const req = fake.structured.mock.calls[0]![0] as { system: string; user: Array<{ type: string; mediaType?: string }> };
    expect(req.system).toContain("dado não confiável");
    expect(req.user[0]).toMatchObject({ type: "document", mediaType: "application/pdf" });

    await previewMapping(fam.ctx, preview.batch.id, { invertSigns: true });
    expect(fake.structured).toHaveBeenCalledTimes(1);
    const log = await prisma.aIProcessingLog.findFirstOrThrow({ where: { householdId: fam.householdId, task: "RECEIPT_EXTRACTION" } });
    expect(JSON.stringify(log)).not.toContain("MERCADO BOM");
  });

  it("rotas: upload multipart de PDF acima de 5 MB é aceito até 15 MB e bulk-commit confirma", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });
    const headers = { cookie: `fa_session=${token}`, origin: "http://localhost:3000" };
    const list = await import("@/app/api/v1/imports/route");
    const bulk = await import("@/app/api/v1/imports/bulk-commit/route");
    const ctxOf = () => ({ params: Promise.resolve<Record<string, string>>({}) });

    // PDF válido "inchado" com 6 MB de comentário depois do fim (o leitor ignora).
    const pdf = Buffer.concat([await F.makePdf(F.ITAU_EXTRATO), Buffer.from(`\n%${"x".repeat(6 * 1024 * 1024)}\n`)]);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "itau-grande.pdf");
    form.append("accountId", itau.id);
    const created = await list.POST(new NextRequest("http://localhost:3000/api/v1/imports", { method: "POST", body: form, headers }), ctxOf());
    expect(created.status).toBe(201);
    const preview = (await created.json()).data as { batch: { id: string; format: string } };
    expect(preview.batch.format).toBe("PDF");

    const big = new FormData();
    big.append("file", new Blob([new Uint8Array(16 * 1024 * 1024)], { type: "application/pdf" }), "enorme.pdf");
    const tooBig = await list.POST(new NextRequest("http://localhost:3000/api/v1/imports", { method: "POST", body: big, headers }), ctxOf());
    expect(tooBig.status).toBe(422);
    expect(JSON.stringify(await tooBig.json())).toContain("15 MB");

    const committed = await bulk.POST(
      new NextRequest("http://localhost:3000/api/v1/imports/bulk-commit", { method: "POST", body: JSON.stringify({ batchIds: [preview.batch.id] }), headers: { ...headers, "content-type": "application/json" } }),
      ctxOf(),
    );
    expect(committed.status).toBe(201);
    const body = (await committed.json()).data as { totals: { created: number } };
    expect(body.totals.created).toBe(4);

    const empty = await bulk.POST(
      new NextRequest("http://localhost:3000/api/v1/imports/bulk-commit", { method: "POST", body: JSON.stringify({ batchIds: [] }), headers: { ...headers, "content-type": "application/json" } }),
      ctxOf(),
    );
    expect(empty.status).toBe(422);
  });

  it("linhas da prévia de PDF podem ser ajustadas como nos outros formatos", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const preview = await pdfPreview(fam, "itau.pdf", await F.makePdf(F.ITAU_EXTRATO), { accountId: itau.id });
    const first = preview.rows[0]!;
    const updated = await updateImportRows(fam.ctx, preview.batch.id, [{ rowId: first.id, selected: false }]);
    expect(updated.counts.selectedNew).toBe(3);
  });
});
