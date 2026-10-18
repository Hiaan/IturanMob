import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pipeline de IA de ponta a ponta: mensagem do WhatsApp (simulador) → ingestão → job →
 * motor local pt-BR (padrão, sem rede) → serviço de transações → ledger/pendências/auditoria.
 *
 * Somente as bordas externas são falsas: o SDK de transcrição (Whisper/OpenAI) e o provedor
 * de visão ("Anthropic"). Consentimento, resolução de provedor, redação de dados de cartão e
 * validações continuam sendo o código real.
 */

const fake = vi.hoisted(() => ({
  structured: vi.fn(),
  runTools: vi.fn(),
  transcribe: vi.fn(),
  openaiClients: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/ai/providers/anthropic", () => ({
  AnthropicProvider: class FakeAnthropicProvider {
    readonly type = "ANTHROPIC";
    readonly supportsVision = true;
    constructor(
      readonly apiKey: string,
      readonly model: string,
    ) {}
    structured(req: unknown) {
      return fake.structured(req);
    }
    runTools(req: unknown) {
      return fake.runTools(req);
    }
  },
}));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class FakeOpenAI {
    audio: unknown;
    constructor(opts: Record<string, unknown>) {
      fake.openaiClients.push(opts);
      this.audio = { transcriptions: { create: (args: unknown) => fake.transcribe(args) } };
    }
  }
  return { ...actual, default: FakeOpenAI, OpenAI: FakeOpenAI };
});

// Pontos de injeção de falha (por padrão chamam a implementação real).
vi.mock("@/server/ai/engine/clarifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ai/engine/clarifications")>();
  return { ...actual, openClarification: vi.fn(actual.openClarification) };
});
vi.mock("@/server/modules/transactions/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/modules/transactions/service")>();
  return { ...actual, createTransaction: vi.fn(actual.createTransaction) };
});

import { prisma } from "@/server/db";
import { decryptStringSafe } from "@/server/crypto";
import { resetEnvCache } from "@/server/env";
import { addDays, dateToISO, todayISO } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { handleInboundMessage } from "@/server/ai/pipeline/handle-message";
import { openClarification } from "@/server/ai/engine/clarifications";
import { applyText, saveCredential, updateTaskConfigs } from "@/server/ai/api";
import { createTransaction, restoreTransaction } from "@/server/modules/transactions/service";
import { reprocessMessage, runProcessingJob } from "@/server/whatsapp/processor";
import { createAccount } from "@/server/modules/accounts/service";
import { categoryId, createBasicAccounts, resetDatabase } from "./helpers";
import {
  TZ,
  balanceOf,
  clearTestQueues,
  createWaFamily,
  enableExternalAI,
  initTestQueues,
  messageState,
  sendMessage,
  teardownTestQueues,
  txsOf,
  type WaFamily,
} from "./ai-pipeline-support";

const actualTxService = await vi.importActual<typeof import("@/server/modules/transactions/service")>("@/server/modules/transactions/service");
const createTxMock = vi.mocked(createTransaction);
const openClarificationMock = vi.mocked(openClarification);

const today = () => todayISO(TZ);
const transientDbError = () => Object.assign(new Error("Can't reach database server at localhost:5432"), { code: "P1001" });

async function familyWithAccounts(name?: string) {
  const fam = await createWaFamily(name);
  const accounts = await createBasicAccounts(fam.ctx);
  return { fam, ...accounts };
}

async function makeDue(jobId: string) {
  await prisma.messageProcessingJob.update({ where: { id: jobId }, data: { runAfter: new Date(Date.now() - 1000) } });
}

/** Transcrição por API compatível com Whisper (externa por padrão). */
async function configureTranscription(wa: WaFamily, opts: { provider?: "OPENAI" | "OPENAI_COMPATIBLE"; baseUrl?: string } = {}) {
  const provider = opts.provider ?? "OPENAI";
  await saveCredential(wa.ctx, { provider, apiKey: "sk-teste-transcricao-0000", baseUrl: opts.baseUrl ?? null });
  await updateTaskConfigs(wa.ctx, { items: [{ task: "TRANSCRIPTION", provider, model: "", enabled: true }] });
}

const audio = () => ({ bytes: Buffer.from(`OggS-audio-falso-${randomBytes(8).toString("hex")}`), mimeType: "audio/ogg; codecs=opus" });

describe("Pipeline de IA: mensagens → lançamentos", () => {
  beforeAll(() => initTestQueues("ai-pipeline"));

  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
    fake.structured.mockReset();
    fake.runTools.mockReset();
    fake.transcribe.mockReset();
    fake.openaiClients.length = 0;
    createTxMock.mockClear();
    openClarificationMock.mockClear();
  });

  afterAll(async () => {
    await teardownTestQueues();
  });

  // ---------------------------------------------------------------- 1 e 2: texto

  it("despesa por texto: 'gastei 45,90 no mercado hoje no pix' → EXPENSE confirmada em Alimentação › Supermercado", async () => {
    const { fam } = await familyWithAccounts();
    const sent = await sendMessage(fam, { text: "gastei 45,90 no mercado hoje no pix" });

    expect(sent.run).toMatchObject({ outcome: "SUCCEEDED", messageStatus: "PROCESSED" });
    expect(sent.message).toMatchObject({ status: "PROCESSED", intent: "CREATE_TRANSACTIONS" });
    const txs = await txsOf(fam.householdId);
    expect(txs).toHaveLength(1);
    const tx = txs[0]!;
    expect(tx).toMatchObject({
      type: "EXPENSE",
      status: "CONFIRMED",
      amountCents: 4590,
      description: "Mercado",
      paymentMethod: "PIX",
      source: "WHATSAPP_TEXT",
      sourceMessageId: sent.messageId,
      sourceIndex: 0,
      createdByMemberId: fam.husbandId,
      payerMemberId: fam.husbandId,
      deletedAt: null,
    });
    expect(dateToISO(tx.date)).toBe(today());
    expect(tx.category?.name).toBe("Alimentação");
    expect(tx.subcategory?.name).toBe("Supermercado");
    // Pix sem conta informada: não há conta para debitar → nenhum lançamento no ledger e uma pendência pede a conta.
    expect(tx.accountId).toBeNull();
    expect(tx.ledgerEntries).toHaveLength(0);
    const pending = await prisma.pendingItem.findMany({ where: { householdId: fam.householdId, transactionId: tx.id } });
    expect(pending.map((p) => p.type)).toEqual(["MISSING_PAYMENT_METHOD"]);
    expect(sent.reply).toContain("Registrado");
    expect(sent.reply).toContain(formatBRL(4590));
    const audit = await prisma.auditLog.findMany({ where: { householdId: fam.householdId, entityType: "Transaction", entityId: tx.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "CREATE", actorType: "WHATSAPP", actorMemberId: fam.husbandId });
  });

  it("despesa por texto com conta ('... no pix do Itaú') gera o movimento no ledger e reduz o saldo", async () => {
    const { fam, itau, nubank } = await familyWithAccounts();
    await sendMessage(fam, { text: "gastei 45,90 no mercado hoje no pix do itaú" });
    const [tx] = await txsOf(fam.householdId);
    expect(tx).toMatchObject({ amountCents: 4590, accountId: itau.id, paymentMethod: "PIX", status: "CONFIRMED" });
    expect(tx!.ledgerEntries).toHaveLength(1);
    expect(tx!.ledgerEntries[0]).toMatchObject({ accountId: itau.id, kind: "EXPENSE", amountCents: -4590 });
    expect(dateToISO(tx!.ledgerEntries[0]!.date)).toBe(today());
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 4590);
    expect(await balanceOf(fam, nubank.id)).toBe(100_000);
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, transactionId: tx!.id, status: "OPEN" } })).toBe(0);
  });

  it("despesa por texto com uma única conta cadastrada: a conta é usada e o saldo é atualizado", async () => {
    const fam = await createWaFamily();
    const only = await createAccount(fam.ctx, { name: "Conta Única", institution: "Banco", type: "CHECKING", initialBalanceCents: 50_000, initialBalanceDate: "2026-01-01" });
    const sent = await sendMessage(fam, { text: "gastei 45,90 no mercado hoje no pix" });
    const [tx] = await txsOf(fam.householdId);
    expect(tx).toMatchObject({ amountCents: 4590, accountId: only.id, paymentMethod: "PIX", status: "CONFIRMED" });
    expect(tx!.ledgerEntries).toHaveLength(1);
    expect(await balanceOf(fam, only.id)).toBe(50_000 - 4590);
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, transactionId: tx!.id, status: "OPEN" } })).toBe(0);
    expect(sent.reply).toContain("Conta Única");
  });

  it("receita por texto: 'recebi 3500 de salário' → INCOME em Trabalho › Salário; com conta, credita o saldo", async () => {
    const { fam, itau } = await familyWithAccounts();
    const first = await sendMessage(fam, { text: "recebi 3500 de salário" });
    expect(first.reply).toContain("Receita registrada");
    const second = await sendMessage(fam, { text: "recebi 1.200 de freela no itaú" });
    expect(second.message.status).toBe("PROCESSED");

    const [salary, freela] = await txsOf(fam.householdId);
    expect(salary).toMatchObject({ type: "INCOME", status: "CONFIRMED", amountCents: 350_000, description: "Salário", accountId: null });
    expect(salary!.category).toMatchObject({ name: "Trabalho", kind: "INCOME" });
    expect(salary!.subcategory?.name).toBe("Salário");
    expect(freela).toMatchObject({ type: "INCOME", amountCents: 120_000, accountId: itau.id });
    expect(freela!.category).toMatchObject({ name: "Trabalho", kind: "INCOME" });
    expect(freela!.subcategory?.name).toBe("Serviços");
    expect(freela!.ledgerEntries.map((e) => [e.kind, e.amountCents])).toEqual([["INCOME", 120_000]]);
    expect(await balanceOf(fam, itau.id)).toBe(500_000 + 120_000);
  });

  // ---------------------------------------------------------------- 3 e 4: áudio

  it("áudio: sem consentimento nada é enviado ao provedor externo; após autorizar, o reprocessamento transcreve e lança", async () => {
    const { fam, itau } = await familyWithAccounts();
    await configureTranscription(fam);
    fake.transcribe.mockResolvedValue({ text: "paguei 120 de internet no débito do itaú" });

    const denied = await sendMessage(fam, { type: "AUDIO", media: audio() });
    expect(fake.transcribe).not.toHaveBeenCalled();
    expect(denied.message).toMatchObject({ status: "NEEDS_CLARIFICATION", intent: "CLARIFICATION" });
    expect(denied.reply).toContain("Não consegui ouvir o áudio");
    expect(denied.reply).toContain("não foi autorizado");
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    const pending = await prisma.pendingItem.findFirstOrThrow({ where: { householdId: fam.householdId, messageId: denied.messageId } });
    expect(pending).toMatchObject({ type: "CLARIFICATION", title: "Áudio não transcrito", status: "OPEN", dedupeKey: `msg:CLARIFICATION:${denied.messageId}` });
    const att0 = await prisma.attachment.findUniqueOrThrow({ where: { id: denied.message.attachmentId! } });
    expect(att0).toMatchObject({ kind: "AUDIO", transcription: null, transactionId: null });
    expect(await prisma.aIProcessingLog.count({ where: { householdId: fam.householdId, task: "TRANSCRIPTION" } })).toBe(0);

    // A família autoriza o envio de áudios e reprocessa a mesma mensagem.
    await prisma.householdSettings.update({ where: { householdId: fam.householdId }, data: { aiExternalAllowed: true, aiAudioAllowed: true } });
    await reprocessMessage(fam.ctx, denied.messageId);
    expect(await runProcessingJob(denied.jobId!, { inlineSimulator: true })).toMatchObject({ outcome: "SUCCEEDED", messageStatus: "PROCESSED" });
    expect(fake.transcribe).toHaveBeenCalledTimes(1);
    expect(fake.transcribe.mock.calls[0]![0]).toMatchObject({ model: "whisper-1", language: "pt" });

    const [tx] = await txsOf(fam.householdId);
    expect(tx).toMatchObject({
      type: "EXPENSE",
      status: "CONFIRMED",
      amountCents: 12_000,
      paymentMethod: "DEBIT_CARD",
      accountId: itau.id,
      source: "WHATSAPP_AUDIO",
      sourceMessageId: denied.messageId,
      sourceIndex: 0,
    });
    expect(tx!.category?.name).toBe("Moradia");
    expect(tx!.subcategory?.name).toBe("Internet");
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 12_000);

    const att = await prisma.attachment.findUniqueOrThrow({ where: { id: denied.message.attachmentId! } });
    expect(att.processingStatus).toBe("TRANSCRIBED");
    expect(att.transactionId).toBe(tx!.id);
    // Transcrição guardada criptografada (nunca em texto puro).
    expect(att.transcription).not.toContain("internet");
    expect(decryptStringSafe(att.transcription)).toBe("paguei 120 de internet no débito do itaú");
    const log = await prisma.aIProcessingLog.findFirstOrThrow({ where: { householdId: fam.householdId, task: "TRANSCRIPTION" } });
    expect(log.status).toBe("SUCCESS");
    expect(JSON.stringify(log)).not.toContain("internet");

    const state = await messageState(fam, denied.messageId);
    expect(state.message.status).toBe("PROCESSED");
    expect(state.replies.at(-1)).toContain("🎙️");
    expect(state.replies.at(-1)).toContain("paguei 120 de internet no débito do itaú");
  });

  it("áudio: sem transcrição configurada o bot responde no grupo o motivo curto (não fica em silêncio)", async () => {
    const { fam } = await familyWithAccounts();
    const sent = await sendMessage(fam, { type: "AUDIO", media: audio() });
    expect(fake.transcribe).not.toHaveBeenCalled();
    expect(sent.reply).toContain("🎙️ Não consegui ouvir o áudio: transcrição desligada. Pode enviar por texto?");
  });

  it("áudio: Whisper próprio da instância (TRANSCRIPTION_BASE_URL) vale mesmo com a transcrição 'Local' salva; o texto segue o fluxo normal", async () => {
    const { fam } = await familyWithAccounts();
    const saved = { p: process.env.TRANSCRIPTION_PROVIDER, u: process.env.TRANSCRIPTION_BASE_URL, m: process.env.WHISPER_MODEL };
    process.env.TRANSCRIPTION_PROVIDER = "openai_compatible";
    process.env.TRANSCRIPTION_BASE_URL = "http://whisper:8000/v1";
    process.env.WHISPER_MODEL = "base";
    resetEnvCache();
    try {
      // A família tinha salvo a tela de IA com a transcrição "Local" (antes não havia servidor).
      await updateTaskConfigs(fam.ctx, { items: [{ task: "TRANSCRIPTION", provider: "LOCAL", model: "", enabled: true }] });
      fake.transcribe.mockResolvedValue({ text: "paguei 750 pro Ícaro, empresa" });
      const sent = await sendMessage(fam, { type: "AUDIO", media: audio() });
      expect(sent.message.status).toBe("PROCESSED");
      expect(fake.transcribe).toHaveBeenCalledTimes(1);
      expect(fake.transcribe.mock.calls[0]![0]).toMatchObject({ model: "Systran/faster-whisper-base", language: "pt" });
      expect(fake.openaiClients.at(-1)).toMatchObject({ baseURL: "http://whisper:8000/v1" });
      // Mesmo fluxo do texto: natureza pela mensagem ("empresa").
      const [tx] = await txsOf(fam.householdId);
      expect(tx).toMatchObject({ amountCents: 75_000, source: "WHATSAPP_AUDIO", scope: "BUSINESS" });
      expect(sent.reply).toContain("🏢 Empresa");
      // Desligar a tarefa vale mais que o servidor.
      await updateTaskConfigs(fam.ctx, { items: [{ task: "TRANSCRIPTION", provider: "LOCAL", model: "", enabled: false }] });
      const off = await sendMessage(fam, { type: "AUDIO", media: audio() });
      expect(off.reply).toContain("Não consegui ouvir o áudio: transcrição desligada");
    } finally {
      for (const [k, v] of [["TRANSCRIPTION_PROVIDER", saved.p], ["TRANSCRIPTION_BASE_URL", saved.u], ["WHISPER_MODEL", saved.m]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnvCache();
    }
  });

  it("áudio: servidor de transcrição na rede local não depende do consentimento de envio externo", async () => {
    const { fam } = await familyWithAccounts();
    await configureTranscription(fam, { provider: "OPENAI_COMPATIBLE", baseUrl: "http://localhost:9000/v1" });
    fake.transcribe.mockResolvedValue({ text: "abasteci 200 de gasolina" });

    const sent = await sendMessage(fam, { type: "AUDIO", media: audio() });
    expect(sent.message.status).toBe("PROCESSED");
    expect(fake.transcribe).toHaveBeenCalledTimes(1);
    expect(fake.openaiClients.at(-1)).toMatchObject({ baseURL: "http://localhost:9000/v1" });
    const [tx] = await txsOf(fam.householdId);
    expect(tx).toMatchObject({ amountCents: 20_000, source: "WHATSAPP_AUDIO" });
    expect(tx!.subcategory?.name).toBe("Combustível");
  });

  it("áudio com vários gastos → 3 lançamentos com sourceIndex distintos e a mesma mensagem de origem (reprocessar não duplica)", async () => {
    const { fam } = await familyWithAccounts();
    await configureTranscription(fam);
    await prisma.householdSettings.update({ where: { householdId: fam.householdId }, data: { aiExternalAllowed: true, aiAudioAllowed: true } });
    fake.transcribe.mockResolvedValue({ text: "gastei 30 de uber e 52 na farmácia e 18 de padaria" });

    const sent = await sendMessage(fam, { type: "AUDIO", media: audio() });
    expect(sent.message.status).toBe("PROCESSED");
    expect(sent.reply).toContain("3 lançamentos registrados");

    const txs = await txsOf(fam.householdId);
    expect(txs).toHaveLength(3);
    expect(new Set(txs.map((t) => t.sourceMessageId))).toEqual(new Set([sent.messageId]));
    expect(txs.map((t) => t.sourceIndex).sort()).toEqual([0, 1, 2]);
    const byIndex = [...txs].sort((a, b) => a.sourceIndex - b.sourceIndex);
    expect(byIndex.map((t) => [t.amountCents, t.category?.name, t.subcategory?.name, t.source, t.status])).toEqual([
      [3000, "Transporte", "Aplicativos de transporte", "WHATSAPP_AUDIO", "CONFIRMED"],
      [5200, "Saúde", "Medicamentos", "WHATSAPP_AUDIO", "CONFIRMED"],
      [1800, "Alimentação", "Padaria", "WHATSAPP_AUDIO", "CONFIRMED"],
    ]);
    const att = await prisma.attachment.findUniqueOrThrow({ where: { id: sent.message.attachmentId! } });
    expect(att.transactionId).toBe(byIndex[0]!.id);

    // Reprocessar a mesma mensagem usa a transcrição salva e não duplica nada.
    const again = await handleInboundMessage(sent.messageId);
    expect(again.status).toBe("PROCESSED");
    expect(fake.transcribe).toHaveBeenCalledTimes(1);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(3);
  });

  // ---------------------------------------------------------------- 5: comprovantes

  async function receiptFamily(consentImage = true) {
    const ctx = await familyWithAccounts();
    await prisma.creditCard.update({ where: { id: ctx.card.id }, data: { last4: "1111" } });
    await enableExternalAI(ctx.fam, ["RECEIPT_EXTRACTION"], { image: consentImage });
    const yesterday = addDays(today(), -1);
    fake.structured.mockImplementation(async (req: { task: string; user: Array<{ type: string }> }) => {
      if (req.task !== "RECEIPT_EXTRACTION") throw new Error(`tarefa inesperada ${req.task}`);
      expect(req.user[0]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
      return {
        json: {
          legible: true,
          is_receipt: true,
          merchant: "Padaria Dourada",
          total: 87.5,
          date: yesterday,
          payment_method: "CREDIT_CARD",
          card_last4: "4111 1111 1111 1111",
          transaction_id: "NSU 000123 456",
          installments: null,
          items: [
            { description: "Pão francês — cartão 4111 1111 1111 1111", amount: 12.5 },
            { description: "Bolo de rolo", amount: 75 },
          ],
          confidence: 0.95,
        },
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    });
    return { ...ctx, yesterday, image: { bytes: Buffer.from(`\xff\xd8\xff-jpeg-falso-${randomBytes(8).toString("hex")}`, "binary"), mimeType: "image/jpeg" } };
  }

  const FULL_PAN = /4111[\s-]?1111[\s-]?1111[\s-]?1111/;

  it("comprovante: dados extraídos viram lançamento pendente; o número completo do cartão nunca é armazenado", async () => {
    const { fam, card, image, yesterday } = await receiptFamily();
    const sent = await sendMessage(fam, { type: "IMAGE", media: image });
    expect(fake.structured).toHaveBeenCalledTimes(1);
    expect(sent.message.status).toBe("PROCESSED");
    expect(sent.reply).toContain("Li o comprovante de *Padaria Dourada*");
    expect(sent.reply).toContain("pendente de confirmação");

    const [tx] = await txsOf(fam.householdId);
    expect(tx).toMatchObject({
      type: "EXPENSE",
      status: "PENDING",
      amountCents: 8750,
      description: "Padaria Dourada",
      paymentMethod: "CREDIT_CARD",
      creditCardId: card.id,
      source: "WHATSAPP_IMAGE",
      sourceMessageId: sent.messageId,
    });
    expect(dateToISO(tx!.date)).toBe(yesterday);
    expect(tx!.subcategory?.name).toBe("Padaria");
    // Pendente: ainda fora das faturas.
    expect(await prisma.installment.count({ where: { transactionId: tx!.id } })).toBe(0);

    const att = await prisma.attachment.findUniqueOrThrow({ where: { id: sent.message.attachmentId! } });
    expect(att).toMatchObject({ processingStatus: "EXTRACTED", transactionId: tx!.id });
    const data = att.extractedData as { card_last4: string | null; items: Array<{ description: string }>; transaction_id: string };
    expect(data.card_last4).toBe("1111");
    expect(data.items[0]!.description).toContain("[removido]");
    expect(data.transaction_id).toBe("NSU000123456");

    // Nenhum lugar do banco guarda o número completo do cartão.
    const everywhere = await Promise.all([
      prisma.attachment.findMany({ where: { householdId: fam.householdId } }),
      prisma.transaction.findMany({ where: { householdId: fam.householdId } }),
      prisma.pendingItem.findMany({ where: { householdId: fam.householdId } }),
      prisma.auditLog.findMany({ where: { householdId: fam.householdId } }),
      prisma.aIProcessingLog.findMany({ where: { householdId: fam.householdId } }),
      prisma.whatsAppMessage.findMany({ where: { householdId: fam.householdId } }),
      prisma.clarification.findMany({ where: { householdId: fam.householdId } }),
    ]);
    expect(JSON.stringify(everywhere)).not.toMatch(FULL_PAN);

    // Confirmação pelo grupo: passa a valer e entra na fatura do cartão.
    const yes = await sendMessage(fam, { text: "sim" });
    expect(yes.message.intent).toBe("CONFIRMATION");
    const confirmed = await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    const installments = await prisma.installment.findMany({ where: { transactionId: tx!.id } });
    expect(installments.map((i) => i.amountCents)).toEqual([8750]);
  });

  it("comprovante repetido (mesmo SHA-256 da imagem) não gera um segundo lançamento", async () => {
    const { fam, image } = await receiptFamily();
    const first = await sendMessage(fam, { type: "IMAGE", media: image });
    const second = await sendMessage(fam, { type: "IMAGE", media: image });

    // A ingestão reconhece o mesmo arquivo (SHA-256) e reaproveita o anexo; o motor responde sem lançar.
    expect(second.message.attachmentId).toBe(first.message.attachmentId);
    expect(second.message).toMatchObject({ status: "PROCESSED", intent: "DUPLICATE_RECEIPT", statusDetail: "comprovante repetido" });
    const att = await prisma.attachment.findUniqueOrThrow({ where: { id: first.message.attachmentId! } });
    expect(await prisma.attachment.count({ where: { householdId: fam.householdId, sha256: att.sha256 } })).toBe(1);
    expect(second.reply).toContain("já foi registrado");
    expect(fake.structured).toHaveBeenCalledTimes(1);
    const txs = await txsOf(fam.householdId);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.sourceMessageId).toBe(first.messageId);
  });

  it("comprovante sem consentimento para imagens: a imagem não é enviada e vira pendência de comprovante ilegível", async () => {
    const { fam, image } = await receiptFamily(false);
    const sent = await sendMessage(fam, { type: "IMAGE", media: image });
    expect(fake.structured).not.toHaveBeenCalled();
    expect(sent.message.status).toBe("NEEDS_CLARIFICATION");
    expect(sent.reply).toContain("não autorizada");
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, type: "UNREADABLE_RECEIPT", messageId: sent.messageId } })).toBe(1);
  });

  // ---------------------------------------------------------------- 6: categorias

  it("identifica a categoria por palavras-chave das categorias padrão", async () => {
    const { fam } = await familyWithAccounts();
    const cases: Array<[string, string, string, "EXPENSE" | "INCOME"]> = [
      ["gastei 52 na farmácia", "Saúde", "Medicamentos", "EXPENSE"],
      ["gastei 30 de uber", "Transporte", "Aplicativos de transporte", "EXPENSE"],
      ["abasteci 200 de gasolina", "Transporte", "Combustível", "EXPENSE"],
      ["18 de padaria", "Alimentação", "Padaria", "EXPENSE"],
      ["gastei 45,90 no mercado", "Alimentação", "Supermercado", "EXPENSE"],
      ["ifood 62", "Alimentação", "Delivery", "EXPENSE"],
      ["netflix 55,90", "Assinaturas", "Streaming", "EXPENSE"],
      ["paguei 1500 de aluguel no boleto", "Moradia", "Aluguel", "EXPENSE"],
      ["consulta no dentista 250", "Saúde", "Consultas", "EXPENSE"],
      ["recebi 3500 de salário", "Trabalho", "Salário", "INCOME"],
    ];
    for (const [text, cat, sub, kind] of cases) {
      const res = await applyText(fam.ctx, text);
      expect(res.created, text).toBe(1);
      const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: res.transactionIds[0]! }, include: { category: true, subcategory: true } });
      expect([tx.type, tx.category?.name, tx.category?.kind, tx.subcategory?.name], text).toEqual([kind, cat, kind, sub]);
      expect(tx.categoryId).toBe(await categoryId(fam.householdId, cat, kind));
    }
  });

  // ---------------------------------------------------------------- 7: esclarecimentos

  it("mensagem sem valor: nada é lançado, abre pergunta + pendência; a resposta completa o lançamento", async () => {
    const { fam } = await familyWithAccounts();
    const ask = await sendMessage(fam, { text: "gastei no mercado hoje" });
    expect(ask.message).toMatchObject({ status: "NEEDS_CLARIFICATION", intent: "CREATE_TRANSACTIONS" });
    expect(ask.reply).toContain("Não identifiquei o valor de *Mercado*");
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    const clar = await prisma.clarification.findFirstOrThrow({ where: { householdId: fam.householdId, status: "OPEN" } });
    expect(clar).toMatchObject({ kind: "MISSING_FIELDS", messageId: ask.messageId, memberId: fam.husbandId, chatId: fam.groupJid });
    const pending = await prisma.pendingItem.findFirstOrThrow({ where: { householdId: fam.householdId, dedupeKey: `clarify:${ask.messageId}` } });
    expect(pending).toMatchObject({ type: "CLARIFICATION", status: "OPEN" });

    const answer = await sendMessage(fam, { text: "45,90" });
    expect(answer.message.status).toBe("PROCESSED");
    const txs = await txsOf(fam.householdId);
    expect(txs).toHaveLength(1);
    // O lançamento pertence à mensagem original (não à resposta).
    expect(txs[0]).toMatchObject({ amountCents: 4590, status: "CONFIRMED", sourceMessageId: ask.messageId, sourceIndex: 0 });
    expect(txs[0]!.subcategory?.name).toBe("Supermercado");
    expect((await prisma.clarification.findUniqueOrThrow({ where: { id: clar.id } })).status).toBe("ANSWERED");
    expect((await prisma.pendingItem.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("RESOLVED");
  });

  it("conta/cartão ambíguos ('no nubank'): lançamento pendente, fora da fatura, até o 'sim'", async () => {
    const { fam, card } = await familyWithAccounts();
    const sent = await sendMessage(fam, { text: "mercado 283,90 no nubank" });
    expect(sent.reply).toContain("pendente de confirmação");
    const [tx] = await txsOf(fam.householdId);
    expect(tx).toMatchObject({ status: "PENDING", amountCents: 28_390, creditCardId: card.id });
    expect(await prisma.installment.count({ where: { transactionId: tx!.id } })).toBe(0);
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, transactionId: tx!.id, type: "CONFIRMATION", status: "OPEN" } })).toBe(1);
    const clar = await prisma.clarification.findFirstOrThrow({ where: { householdId: fam.householdId, status: "OPEN" } });
    expect(clar.kind).toBe("CONFIRM_TRANSACTION");

    await sendMessage(fam, { text: "sim" });
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id } });
    expect(after.status).toBe("CONFIRMED");
    expect((await prisma.installment.findMany({ where: { transactionId: tx!.id } })).map((i) => i.amountCents)).toEqual([28_390]);
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, transactionId: tx!.id, type: "CONFIRMATION", status: "OPEN" } })).toBe(0);
    expect((await prisma.clarification.findUniqueOrThrow({ where: { id: clar.id } })).status).toBe("ANSWERED");
    const actions = (await prisma.auditLog.findMany({ where: { entityId: tx!.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["CREATE", "CONFIRM"]);
  });

  it("correção ambígua: pergunta qual lançamento e a resposta com o número aplica só nele", async () => {
    const { fam } = await familyWithAccounts();
    await sendMessage(fam, { text: "gastei 30 na farmácia" });
    await sendMessage(fam, { text: "gastei 80 no mercado" });
    const question = await sendMessage(fam, { text: "na verdade foi 50" });
    expect(question.message.status).toBe("NEEDS_CLARIFICATION");
    expect(question.reply).toContain("Qual você quer corrigir?");
    let [pharmacy, market] = await txsOf(fam.householdId);
    expect([pharmacy!.amountCents, market!.amountCents]).toEqual([3000, 8000]);

    // Lista em ordem do mais recente: 1 = mercado, 2 = farmácia.
    await sendMessage(fam, { text: "2" });
    [pharmacy, market] = await txsOf(fam.householdId);
    expect(pharmacy).toMatchObject({ amountCents: 5000, version: 2 });
    expect(market).toMatchObject({ amountCents: 8000, version: 1 });
  });

  // ---------------------------------------------------------------- 8: duplicidade

  it("o mesmo evento do WhatsApp entregue duas vezes (mesmo externalId) gera uma única transação", async () => {
    const { fam, itau } = await familyWithAccounts();
    const first = await sendMessage(fam, { text: "gastei 30 na farmácia no débito do itaú", externalId: "WAMID-REPETIDO-1" });
    const again = await sendMessage(fam, { text: "gastei 30 na farmácia no débito do itaú", externalId: "WAMID-REPETIDO-1" });
    expect(again).toMatchObject({ duplicate: true, messageId: first.messageId, jobId: first.jobId });
    expect(again.run).toMatchObject({ outcome: "SKIPPED" });
    expect(await prisma.whatsAppMessage.count({ where: { householdId: fam.householdId, direction: "INBOUND" } })).toBe(1);

    // Mesmo que o motor rode de novo para a mensagem (reprocessamento), a posição já lançada não duplica.
    await handleInboundMessage(first.messageId);
    await reprocessMessage(fam.ctx, first.messageId);
    expect(await runProcessingJob(first.jobId!, { inlineSimulator: true })).toMatchObject({ outcome: "SUCCEEDED" });

    const txs = await txsOf(fam.householdId);
    expect(txs).toHaveLength(1);
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 3000);
  });

  it("mensagem quase idêntica minutos depois → suspeita de duplicidade (pendente + pergunta), nunca um segundo lançamento silencioso", async () => {
    const { fam, itau } = await familyWithAccounts();
    await sendMessage(fam, { text: "gastei 30 na farmácia no débito do itaú" });
    const dup = await sendMessage(fam, { text: "gastei 30 na farmácia no débito do itaú" });

    expect(dup.reply).toContain("parece repetir");
    const [original, suspect] = await txsOf(fam.householdId);
    expect(original!.status).toBe("CONFIRMED");
    expect(suspect).toMatchObject({ status: "PENDING", amountCents: 3000, sourceMessageId: dup.messageId });
    expect(suspect!.ledgerEntries).toHaveLength(0);
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 3000);
    const pending = await prisma.pendingItem.findFirstOrThrow({ where: { householdId: fam.householdId, type: "POSSIBLE_DUPLICATE" } });
    expect(pending).toMatchObject({ transactionId: suspect!.id, relatedTransactionId: original!.id, status: "OPEN" });
    expect((await prisma.clarification.findFirstOrThrow({ where: { householdId: fam.householdId, status: "OPEN" } })).kind).toBe("CONFIRM_DUPLICATE");

    // "não" → descarta a suspeita (exclusão lógica auditada como REJECT); o original fica intacto.
    const no = await sendMessage(fam, { text: "não" });
    expect(no.message.intent).toBe("REJECTION");
    const rejected = await prisma.transaction.findUniqueOrThrow({ where: { id: suspect!.id } });
    expect(rejected.deletedAt).not.toBeNull();
    expect((await prisma.pendingItem.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("DISMISSED");
    expect((await prisma.auditLog.findMany({ where: { entityId: suspect!.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action)).toEqual(["CREATE", "REJECT"]);
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 3000);

    // Um novo gasto igual, confirmado com "sim", passa a contar.
    await sendMessage(fam, { text: "gastei 30 na farmácia no débito do itaú" });
    await sendMessage(fam, { text: "sim" });
    const confirmed = (await txsOf(fam.householdId)).filter((t) => t.status === "CONFIRMED" && !t.deletedAt);
    expect(confirmed).toHaveLength(2);
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 6000);
  });

  // ---------------------------------------------------------------- 9: correção

  it("correção ('na verdade foi 50' / 'corrige o último para 35') altera o valor, audita e reposta o ledger", async () => {
    const { fam, itau } = await familyWithAccounts();
    await sendMessage(fam, { text: "gastei 45,90 no mercado hoje no pix do itaú" });
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 4590);

    const fix = await sendMessage(fam, { text: "na verdade foi 50" });
    expect(fix.message.intent).toBe("CORRECTION");
    expect(fix.reply).toContain("Corrigido");
    expect(fix.reply).toContain(`${formatBRL(4590)} → ${formatBRL(5000)}`);
    let [market] = await txsOf(fam.householdId);
    expect(market).toMatchObject({ amountCents: 5000, version: 2, status: "CONFIRMED" });
    expect(market!.ledgerEntries.map((e) => e.amountCents)).toEqual([-5000]);
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 5000);
    const update = await prisma.auditLog.findFirstOrThrow({ where: { entityId: market!.id, action: "UPDATE" } });
    expect(update).toMatchObject({ actorType: "WHATSAPP", source: "Correção via mensagem" });
    expect(update.before).toMatchObject({ amountCents: 4590 });
    expect(update.after).toMatchObject({ amountCents: 5000 });

    // Referência explícita ao último lançamento quando há mais de um.
    await sendMessage(fam, { text: "gastei 30 na farmácia no débito do itaú" });
    const last = await sendMessage(fam, { text: "corrige o último para 35" });
    expect(last.message.intent).toBe("CORRECTION");
    expect(last.reply).toContain("Corrigido");
    let pharmacy;
    [market, pharmacy] = await txsOf(fam.householdId);
    expect(pharmacy).toMatchObject({ amountCents: 3500, version: 2 });
    expect(market!.amountCents).toBe(5000);
    expect(await balanceOf(fam, itau.id)).toBe(500_000 - 5000 - 3500);
  });

  // ---------------------------------------------------------------- 10: exclusão e restauração

  it("exclusão por mensagem é lógica e restaurável (serviço ou 'desfazer'); exclusão em massa é recusada", async () => {
    const { fam, itau } = await familyWithAccounts();
    await sendMessage(fam, { text: "gastei 30 na farmácia no débito do itaú" });
    const [tx] = await txsOf(fam.householdId);
    expect(await balanceOf(fam, itau.id)).toBe(497_000);

    const bulk = await sendMessage(fam, { text: "apaga tudo" });
    expect(bulk.message.intent).toBe("DELETE");
    expect(bulk.reply).toContain("exclusões em massa não são feitas por mensagem");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id } })).deletedAt).toBeNull();
    expect(await balanceOf(fam, itau.id)).toBe(497_000);

    const del = await sendMessage(fam, { text: "apaga o último gasto" });
    expect(del.reply).toContain("Excluí *Farmácia*");
    let row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id }, include: { ledgerEntries: true } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedByMemberId).toBe(fam.husbandId);
    expect(row.ledgerEntries).toHaveLength(0);
    expect(await balanceOf(fam, itau.id)).toBe(500_000);

    await restoreTransaction(fam.ctx, tx!.id);
    row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id }, include: { ledgerEntries: true } });
    expect(row.deletedAt).toBeNull();
    expect(row.ledgerEntries.map((e) => e.amountCents)).toEqual([-3000]);
    expect(await balanceOf(fam, itau.id)).toBe(497_000);

    await sendMessage(fam, { text: "apaga o último gasto" });
    expect(await balanceOf(fam, itau.id)).toBe(500_000);
    const undo = await sendMessage(fam, { text: "desfazer" });
    expect(undo.message.intent).toBe("RESTORE");
    expect(await balanceOf(fam, itau.id)).toBe(497_000);

    const actions = (await prisma.auditLog.findMany({ where: { entityId: tx!.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["CREATE", "DELETE", "RESTORE", "DELETE", "RESTORE"]);
  });

  // ---------------------------------------------------------------- 20: recuperação após falha

  it("falha transitória depois de gravar o lançamento → nova tentativa; o retry conclui sem duplicar", async () => {
    const { fam } = await familyWithAccounts();
    openClarificationMock.mockRejectedValueOnce(transientDbError());

    const sent = await sendMessage(fam, { text: "mercado 283,90 no nubank" });
    expect(sent.run).toMatchObject({ outcome: "RETRY_SCHEDULED", attempts: 1 });
    expect(sent.message.status).toBe("QUEUED");
    const job = await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: sent.jobId! } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(job.lastError).toContain("Can't reach database server");
    // O lançamento já tinha sido gravado antes da falha.
    expect(await prisma.transaction.count({ where: { sourceMessageId: sent.messageId } })).toBe(1);

    await makeDue(sent.jobId!);
    expect(await runProcessingJob(sent.jobId!, { inlineSimulator: true })).toMatchObject({ outcome: "SUCCEEDED", messageStatus: "PROCESSED" });
    const txs = await txsOf(fam.householdId);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ sourceMessageId: sent.messageId, sourceIndex: 0, status: "PENDING", amountCents: 28_390 });
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, type: "CONFIRMATION" } })).toBe(1);
    expect(await prisma.clarification.count({ where: { householdId: fam.householdId, kind: "CONFIRM_TRANSACTION", status: "OPEN" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, entityType: "Transaction", action: "CREATE" } })).toBe(1);
    expect((await messageState(fam, sent.messageId)).message.status).toBe("PROCESSED");
  });

  it("falha em um dos lançamentos da mensagem → o reprocessamento cria só o que faltou (único por mensagem + posição)", async () => {
    const { fam } = await familyWithAccounts();
    let failed = false;
    createTxMock.mockImplementation(async (ctx, input, opts) => {
      if (!failed && opts?.sourceIndex === 1) {
        failed = true;
        throw transientDbError();
      }
      return actualTxService.createTransaction(ctx, input, opts);
    });
    try {
      const sent = await sendMessage(fam, { text: "gastei 30 de uber e 52 na farmácia e 18 de padaria" });
      expect(sent.reply).toContain("Não consegui registrar: Farmácia");
      const partial = await txsOf(fam.householdId);
      expect(partial.map((t) => t.sourceIndex)).toEqual([0, 2]);
      const kept = new Map(partial.map((t) => [t.sourceIndex, t.id]));

      await reprocessMessage(fam.ctx, sent.messageId);
      expect(await runProcessingJob(sent.jobId!, { inlineSimulator: true })).toMatchObject({ outcome: "SUCCEEDED" });
      const all = await txsOf(fam.householdId);
      expect(all).toHaveLength(3);
      expect(all.every((t) => t.sourceMessageId === sent.messageId)).toBe(true);
      expect(all.map((t) => t.sourceIndex).sort()).toEqual([0, 1, 2]);
      expect(all.find((t) => t.sourceIndex === 0)!.id).toBe(kept.get(0));
      expect(all.find((t) => t.sourceIndex === 2)!.id).toBe(kept.get(2));
      expect(all.find((t) => t.sourceIndex === 1)).toMatchObject({ amountCents: 5200, status: "CONFIRMED" });
      expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, type: "POSSIBLE_DUPLICATE" } })).toBe(0);

      // Uma terceira execução não muda nada.
      await handleInboundMessage(sent.messageId);
      expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(3);
    } finally {
      createTxMock.mockImplementation(actualTxService.createTransaction);
    }
  });

  it("createTransaction com a mesma mensagem e posição devolve o lançamento existente", async () => {
    const { fam } = await familyWithAccounts();
    const sent = await sendMessage(fam, { text: "gastei 30 de uber" });
    const [tx] = await txsOf(fam.householdId);
    const again = await createTransaction(
      fam.ctx,
      { type: "EXPENSE", amountCents: 9999, description: "Outro", date: today() },
      { source: "WHATSAPP_TEXT", sourceMessageId: sent.messageId, sourceIndex: 0 },
    );
    expect(again.created).toBe(false);
    expect(again.transaction.id).toBe(tx!.id);
    expect(again.transaction.amountCents).toBe(3000);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(1);
  });
});
