import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Corrigir e cancelar o ÚLTIMO lançamento falando natural (texto ou áudio), mostrar o que o áudio
 * ouviu e aprender com a correção ("revirante" → "refrigerante"). Saldo, ledger e fatura conferidos
 * antes e depois. Só o SDK de transcrição é falso.
 */

const fake = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class FakeOpenAI {
    audio: unknown;
    constructor() {
      this.audio = { transcriptions: { create: (args: unknown) => fake.transcribe(args) } };
    }
  }
  return { ...actual, default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const { prisma } = await import("@/server/db");
const { resetEnvCache } = await import("@/server/env");
const { createAccount, getAccount } = await import("@/server/modules/accounts/service");
const { createCard, listCards } = await import("@/server/modules/cards/service");
const { resetDatabase } = await import("./helpers");
const { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues, txsOf } = await import("./ai-pipeline-support");
type Fam = Awaited<ReturnType<typeof createWaFamily>>;

const KEYS = ["TRANSCRIPTION_PROVIDER", "TRANSCRIPTION_BASE_URL", "WHISPER_MODEL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir = "";
function opus(seconds = 3): Buffer {
  const file = path.join(dir, `a-${seconds}.ogg`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ac", "1", "-c:a", "libopus", "-b:a", "24k", file]);
  return readFileSync(file);
}
const audio = () => ({ type: "AUDIO" as const, media: { bytes: opus(), mimeType: "audio/ogg; codecs=opus" } });

async function family() {
  const fam = await createWaFamily("Família Correções");
  const itau = await createAccount(fam.ctx, { name: "Itaú", institution: "Itaú", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
  const card = await createCard(fam.ctx, { name: "Nubank", issuer: "Nubank", closingDay: 3, dueDay: 10, limitCents: 500_000, paymentAccountId: itau.id });
  return { fam, itau, card };
}

/** Saldo da conta, ledger, faturas e lançamentos ativos — o que cancelar/voltar não pode bagunçar. */
async function money(fam: Fam, accountId: string) {
  const [account, cards, ledger, installments, active] = await Promise.all([
    getAccount(fam.ctx, accountId),
    listCards(fam.ctx),
    prisma.ledgerEntry.findMany({ where: { householdId: fam.householdId }, orderBy: [{ accountId: "asc" }, { amountCents: "asc" }], select: { accountId: true, amountCents: true } }),
    prisma.installment.findMany({ where: { transaction: { householdId: fam.householdId, deletedAt: null } }, orderBy: { amountCents: "asc" }, select: { amountCents: true, statementId: true } }),
    prisma.transaction.count({ where: { householdId: fam.householdId, deletedAt: null } }),
  ]);
  return { balance: account.balanceCents, outstanding: cards[0]!.outstandingCents, ledger, installments, active };
}

describe("WhatsApp: corrigir e cancelar o último lançamento", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "fa-last-"));
    initTestQueues("wa-last-transaction");
  });
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
    fake.transcribe.mockReset();
    Object.assign(process.env, { TRANSCRIPTION_PROVIDER: "openai_compatible", TRANSCRIPTION_BASE_URL: "http://whisper:8000/v1", WHISPER_MODEL: "base" });
    resetEnvCache();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEnvCache();
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await teardownTestQueues();
  });

  it("áudio: mostra o que ouviu; 'é refrigerante' corrige, aprende o par e o próximo áudio já sai certo", async () => {
    const { fam } = await family();
    fake.transcribe.mockResolvedValueOnce({ text: "comprei revirante 8 reais no nubank" });
    const first = await sendMessage(fam, audio());
    expect(first.reply).toContain("🎙️ Ouvi: “comprei revirante 8 reais no nubank”");
    expect(first.reply).toContain('Algo errado? Responda "é …" com o nome certo');
    const [tx] = await txsOf(fam.householdId);
    expect(tx).toMatchObject({ description: "Revirante", amountCents: 800, source: "WHATSAPP_AUDIO" });

    const fix = await sendMessage(fam, { text: "é refrigerante" });
    expect(fix.message.intent).toBe("CORRECTION");
    expect(fix.reply).toContain("✏️ Corrigido: Revirante → *Refrigerante*");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id } })).description).toBe("Refrigerante");
    const pair = await prisma.transcriptFix.findFirstOrThrow({ where: { householdId: fam.householdId } });
    expect(pair).toMatchObject({ wrong: "revirante", right: "Refrigerante" });

    // Próximo áudio: o Whisper erra de novo, a correção aprendida acerta; a palavra vai para o prompt.
    fake.transcribe.mockResolvedValueOnce({ text: "comprei revirante 5 reais no nubank" });
    const next = await sendMessage(fam, audio());
    expect(next.reply).toContain("🎙️ Ouvi: “comprei refrigerante 5 reais no nubank”");
    expect((fake.transcribe.mock.calls[1]![0] as { prompt: string }).prompt).toContain("Refrigerante");
    const second = (await txsOf(fam.householdId)).find((t) => t.amountCents === 500)!;
    expect(second.description).toBe("Refrigerante");

    // Corrigir de novo com "não é X, é Y" (palavra diferente) também aprende.
    await sendMessage(fam, { text: "não é refrigerante, é refrigerante zero" });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } })).description).toBe("Refrigerante zero");
  });

  it("'cancela' apaga o último (saldo, ledger e fatura voltam ao que eram); 'volta' restaura; 'desfaz' cancela ou volta", async () => {
    const { fam, itau } = await family();
    const before = await money(fam, itau.id);
    await sendMessage(fam, { text: "gastei 8 de refrigerante no cartão nubank" });
    await sendMessage(fam, { text: "gastei 20 de pão no débito do itaú" });
    const after = await money(fam, itau.id);
    expect(after.active).toBe(before.active + 2);

    const cancel = await sendMessage(fam, { text: "cancela" });
    expect(cancel.message.intent).toBe("DELETE");
    expect(cancel.reply).toMatch(/🗑️ Apaguei: \*Pão\* R\$\s20,00 \(Itaú\)/);
    expect(cancel.reply).toContain("Se foi engano, responda *volta*.");
    const afterCancel = await money(fam, itau.id);
    expect(afterCancel.balance).toBe(before.balance);
    expect(afterCancel.active).toBe(before.active + 1);

    const back = await sendMessage(fam, { text: "volta" });
    expect(back.reply).toContain("↩️ Voltei: *Pão*");
    expect(await money(fam, itau.id)).toEqual(after);

    // "desfaz" sem exclusão recente = cancelar o último; logo depois, "desfaz" volta.
    await sendMessage(fam, { text: "desfaz" });
    expect((await money(fam, itau.id)).balance).toBe(before.balance);
    const redo = await sendMessage(fam, { text: "desfaz" });
    expect(redo.message.intent).toBe("RESTORE");
    expect(await money(fam, itau.id)).toEqual(after);

    // Apagar o do cartão também devolve a fatura ao que era.
    await sendMessage(fam, { text: "apaga isso" }); // pão
    await sendMessage(fam, { text: "esquece" }); // refrigerante (o último que sobrou na janela)
    expect(await money(fam, itau.id)).toEqual(before);
  });

  it("valor, forma de pagamento e categoria logo depois do lançamento; 'paguei 15 no uber' continua sendo novo", async () => {
    const { fam, itau } = await family();
    await sendMessage(fam, { text: "gastei 12 de refrigerante no débito do itaú" });
    const [tx] = await txsOf(fam.householdId);

    const amount = await sendMessage(fam, { text: "foram 15" });
    expect(amount.message.intent).toBe("CORRECTION");
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(100_000 - 1_500);

    const pay = await sendMessage(fam, { text: "foi no crédito" });
    expect(pay.reply).toContain("crédito (Nubank)");
    const moved = await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id } });
    expect(moved).toMatchObject({ paymentMethod: "CREDIT_CARD", accountId: null, amountCents: 1_500 });
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(100_000);
    expect((await listCards(fam.ctx))[0]!.outstandingCents).toBe(1_500);

    const cat = await sendMessage(fam, { text: "muda pra lazer" });
    expect(cat.reply).toContain("categoria → Lazer");

    // Verbo de gasto = lançamento novo, não correção.
    await sendMessage(fam, { text: "paguei 15 no uber no débito do itaú" });
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, deletedAt: null } })).toBe(2);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx!.id } })).amountCents).toBe(1_500);
  });

  it("fora da janela de 15 min pergunta qual (os 3 últimos); 'foram 15' fora da janela não mexe em nada; citação acha o lançamento antigo", async () => {
    const { fam, itau } = await family();
    const a = await sendMessage(fam, { text: "gastei 30 de farmácia no débito do itaú" });
    await sendMessage(fam, { text: "gastei 40 de mercado no débito do itaú" });
    await prisma.transaction.updateMany({ where: { householdId: fam.householdId, amountCents: 3_000 }, data: { createdAt: new Date(Date.now() - 25 * 60_000) } });
    await prisma.transaction.updateMany({ where: { householdId: fam.householdId, amountCents: 4_000 }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });

    const nothing = await sendMessage(fam, { text: "foram 15" });
    expect(nothing.message.intent).not.toBe("CORRECTION");
    expect((await prisma.transaction.findMany({ where: { householdId: fam.householdId, amountCents: 1_500 } })).length).toBeLessThanOrEqual(1);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, amountCents: { in: [3_000, 4_000] }, deletedAt: null } })).toBe(2);
    // (o "foram 15" pode virar um lançamento novo pendente; nunca altera os antigos)
    await prisma.transaction.deleteMany({ where: { householdId: fam.householdId, amountCents: 1_500 } });

    const ask = await sendMessage(fam, { text: "cancela" });
    expect(ask.reply).toContain("Qual você quer apagar?");
    expect(ask.reply).toMatch(/1\. Mercado — R\$\s40,00/);
    const pick = await sendMessage(fam, { text: "2" });
    expect(pick.reply).toContain("Apaguei: *Farmácia*");
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(100_000 - 4_000);

    // Citando a confirmação do bot de um lançamento antigo: vale para ele.
    await sendMessage(fam, { text: "volta" });
    const confirmation = await prisma.whatsAppMessage.findFirstOrThrow({ where: { householdId: fam.householdId, direction: "OUTBOUND", quotedExternalId: a.externalId } });
    const quoted = await sendMessage(fam, { text: "era remédio", quotedExternalId: confirmation.externalId });
    expect(quoted.reply).toContain("✏️ Corrigido: Farmácia → *Remédio*");
  });

  it("com a pergunta da categoria aberta, 'cancela' apaga (não vira categoria 'Cancela') e 'não é X, é Y' corrige", async () => {
    const fam = await createWaFamily("Família Pergunta Aberta");
    await createAccount(fam.ctx, { name: "Conta Corrente", institution: "Banco", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
    const q = await sendMessage(fam, { text: "37,00 xilofone" });
    expect(q.reply).toContain("Qual a categoria");
    const fix = await sendMessage(fam, { text: "não é xilofone, é violão" });
    expect(fix.reply).toContain("✏️ Corrigido: Xilofone → *Violão*");
    const cancel = await sendMessage(fam, { text: "cancela" });
    expect(cancel.reply).toContain("Apaguei: *Violão*");
    expect(await prisma.category.count({ where: { householdId: fam.householdId, name: { in: ["Cancela", "Não é xilofone"] } } })).toBe(0);
    expect(await prisma.clarification.count({ where: { householdId: fam.householdId, status: "OPEN" } })).toBe(0);
  });
});
