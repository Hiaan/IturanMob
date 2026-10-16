import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createCard } from "@/server/modules/cards/service";
import { createBasicAccounts, resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues, type WaFamily } from "./ai-pipeline-support";
import * as F from "../helpers/pdf-fixtures";

/**
 * Extratos e faturas em PDF enviados no grupo do WhatsApp: viram prévia de importação, o bot
 * resume e pede confirmação; "confirmar" importa todos os PDFs pendentes sem duplicar.
 */

const c = (text: string, x: number) => ({ text, x });

const ITAU_EXTRATO_2: F.FixtureLine[][] = [
  [
    "Itaú Unibanco S.A.   extrato conta corrente",
    [c("data", 40), c("lançamentos", 110), c("valor (R$)", 380), c("saldo (R$)", 480)],
    [c("05/10/2026", 40), c("TAR PACOTE ITAU", 110), c("-39,90", 380)],
    [c("12/10/2026", 40), c("PIX ENVIADO JOAO", 110), c("-50,00", 380)],
  ],
];

async function sendPdf(fam: WaFamily, pdf: Buffer, fileName = "extrato.pdf", caption?: string) {
  return sendMessage(fam, { type: "DOCUMENT", text: caption, media: { bytes: pdf, mimeType: "application/pdf", fileName } });
}

const imported = (householdId: string) => prisma.transaction.findMany({ where: { householdId, source: "IMPORT", deletedAt: null } });

describe("WhatsApp: extrato/fatura em PDF", () => {
  beforeAll(() => initTestQueues("wa-pdf-import"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("PDF do extrato → resumo com destino identificado → 'confirmar' importa", async () => {
    const fam = await createWaFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const sent = await sendPdf(fam, await F.makePdf(F.ITAU_EXTRATO), "itau-outubro.pdf");
    expect(sent.reply).toContain("Li o extrato do *Itaú* (01/10/2026 a 15/10/2026)");
    expect(sent.reply).toContain("Destino: conta *Itaú* (identificado pelo banco do PDF)");
    expect(sent.reply).toContain("3 lançamento(s) novo(s): entradas R$ 6.500,00 · saídas R$ 285,80");
    expect(sent.reply).toContain("1 pagamento(s) de fatura de cartão");
    expect(sent.reply).toContain("Responda *confirmar*");
    expect(sent.reply).toMatch(/\/importacao\?batch=/);
    expect(sent.message.status).toBe("NEEDS_CLARIFICATION");
    // Nada gravado antes da confirmação.
    expect(await imported(fam.householdId)).toHaveLength(0);

    const ok = await sendMessage(fam, { text: "confirmar" });
    expect(ok.reply).toContain("✅ Importação concluída: 4 lançamento(s) novo(s).");
    const txs = await imported(fam.householdId);
    expect(txs).toHaveLength(4);
    expect(txs.every((t) => t.accountId === itau.id || t.type === "CARD_PAYMENT")).toBe(true);
    expect(await prisma.clarification.count({ where: { householdId: fam.householdId, status: "OPEN" } })).toBe(0);
  });

  it("vários PDFs (extrato + fatura + extrato sobreposto) numa confirmação só, sem duplicar", async () => {
    const fam = await createWaFamily();
    await createBasicAccounts(fam.ctx);
    await sendPdf(fam, await F.makePdf(F.ITAU_EXTRATO), "itau-1.pdf");
    const fatura = await sendPdf(fam, await F.makePdf(F.NUBANK_FATURA), "nubank-fatura.pdf");
    expect(fatura.reply).toContain("Li a fatura do *Nubank*");
    expect(fatura.reply).toContain("Destino: cartão *Nubank Crédito*");
    expect(fatura.reply).toContain("3 lançamento(s) novo(s): compras R$ 81,75");
    // Parcela 2/10 sem a compra original no app: fica desmarcada (as parcelas viriam da compra registrada).
    expect(fatura.reply).toContain("1 lançamento(s) não marcado(s) para importar");
    expect(fatura.reply).toContain("Há *2 arquivos* aguardando");
    const third = await sendPdf(fam, await F.makePdf(ITAU_EXTRATO_2), "itau-2.pdf");
    expect(third.reply).toContain("Há *3 arquivos* aguardando");
    expect(third.reply).toContain("também aparecem em");

    const ok = await sendMessage(fam, { text: "sim" });
    expect(ok.reply).toContain("✅ Importação concluída (3 de 3 arquivos)");
    expect(ok.reply).toContain("1 repetido(s) entre os arquivos (entraram uma vez só)");
    const txs = await imported(fam.householdId);
    // Itaú: 4; fatura: 3 compras; segundo extrato: só o Pix novo (tarifa repetida).
    expect(txs).toHaveLength(8);
    expect(txs.filter((t) => t.amountCents === 3990)).toHaveLength(1);
  });

  it("'cancelar' não importa; destino ambíguo manda para o site; legenda escolhe o cartão", async () => {
    const fam = await createWaFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    // Segundo cartão do Nubank: o banco do PDF não basta para escolher.
    const second = await createCard(fam.ctx, { name: "Nubank Ultravioleta", issuer: "Nubank", closingDay: 3, dueDay: 10, limitCents: 500_000, paymentAccountId: nubank.id });

    const ambiguous = await sendPdf(fam, await F.makePdf(F.NUBANK_FATURA), "fatura.pdf");
    expect(ambiguous.reply).toContain("Não consegui identificar com segurança a conta ou o cartão");
    expect(ambiguous.reply).toMatch(/confirme pelo site: .*\/importacao\?batch=/);
    expect(await prisma.clarification.count({ where: { householdId: fam.householdId, status: "OPEN" } })).toBe(0);

    const captioned = await sendPdf(fam, await F.makePdf(F.NUBANK_FATURA), "fatura-uv.pdf", "fatura do cartão ultravioleta");
    expect(captioned.reply).toContain("Destino: cartão *Nubank Ultravioleta*");
    const cancel = await sendMessage(fam, { text: "cancelar" });
    expect(cancel.reply).toContain("não importei nada");
    expect(await imported(fam.householdId)).toHaveLength(0);
    const batch = await prisma.importBatch.findFirstOrThrow({ where: { householdId: fam.householdId, creditCardId: second.id } });
    expect(batch.status).toBe("PREVIEW");

    // Mesmo depois de cancelar a pergunta, "confirmar importação" ainda importa o que está pronto.
    const late = await sendMessage(fam, { text: "confirmar importação" });
    expect(late.reply).toContain("✅ Importação concluída");
    expect((await imported(fam.householdId)).every((t) => t.creditCardId === second.id)).toBe(true);
  });

  it("pergunta de categoria aberta no meio: 'confirmar' importa os PDFs e não vira categoria", async () => {
    const fam = await createWaFamily();
    await createBasicAccounts(fam.ctx);
    await sendPdf(fam, await F.makePdf(F.ITAU_EXTRATO), "itau.pdf");
    const feijoada = await sendMessage(fam, { text: "37 feijoada" });
    expect(feijoada.reply).toContain("Qual a categoria");
    const categoriesBefore = await prisma.category.count({ where: { householdId: fam.householdId } });
    const ok = await sendMessage(fam, { text: "confirmar" });
    expect(ok.reply).toContain("✅ Importação concluída: 4 lançamento(s) novo(s).");
    expect(await prisma.category.count({ where: { householdId: fam.householdId } })).toBe(categoriesBefore);
    const tx = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, amountCents: 3700 } });
    expect(tx.categoryId).toBeNull();
  });

  it("PDF com senha pede o arquivo sem senha; digitalizado sem IA explica; comprovante em PDF segue como comprovante", async () => {
    const fam = await createWaFamily();
    await createBasicAccounts(fam.ctx);
    const locked = await sendPdf(fam, await F.makePdf(F.ITAU_EXTRATO, { password: "1234" }));
    expect(locked.reply).toContain("🔒 Este PDF está protegido por senha. Envie o arquivo sem senha");
    const scanned = await sendPdf(fam, await F.makeScannedPdf(), "foto.pdf");
    expect(scanned.reply).toContain("não tem texto");
    expect(scanned.reply).toContain("leitura por IA não está disponível");
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, type: "PROCESSING_FAILED", messageId: scanned.messageId } })).toBe(1);
    const receipt = await sendPdf(fam, await F.makePdf(F.PIX_COMPROVANTE), "comprovante.pdf");
    expect(receipt.reply).toContain("parece um comprovante");
    expect(await prisma.importBatch.count({ where: { householdId: fam.householdId } })).toBe(0);
  });

  it("reprocessar a mesma mensagem não cria outra prévia", async () => {
    const fam = await createWaFamily();
    await createBasicAccounts(fam.ctx);
    const pdf = await F.makePdf(F.ITAU_EXTRATO);
    const first = await sendPdf(fam, pdf, "itau.pdf");
    const { reprocessMessage, runProcessingJob } = await import("@/server/whatsapp/processor");
    await reprocessMessage(fam.ctx, first.messageId);
    expect(await runProcessingJob(first.jobId!, { inlineSimulator: true })).toMatchObject({ outcome: "SUCCEEDED" });
    expect(await prisma.importBatch.count({ where: { householdId: fam.householdId } })).toBe(1);
  });
});
