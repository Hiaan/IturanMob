import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Transcrição em servidor pequeno: uma por vez (fila), áudio longo demais recusado antes de enviar,
 * tempo limite, recusa 413 do servidor e download do modelo no speaches. Só o SDK é falso.
 */

const fake = vi.hoisted(() => ({ transcribe: vi.fn(), clients: [] as Array<Record<string, unknown>> }));

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  class FakeOpenAI {
    audio: unknown;
    constructor(opts: Record<string, unknown>) {
      fake.clients.push(opts);
      this.audio = { transcriptions: { create: (args: unknown) => fake.transcribe(args) } };
    }
  }
  return { ...actual, default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const { APIConnectionTimeoutError } = await import("openai");
const { resetEnvCache } = await import("@/server/env");
const { transcribeAudio } = await import("@/server/ai/transcription");
const { resetDatabase } = await import("./helpers");
const { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues } = await import("./ai-pipeline-support");

const KEYS = ["TRANSCRIPTION_PROVIDER", "TRANSCRIPTION_BASE_URL", "WHISPER_MODEL", "TRANSCRIPTION_MAX_SECONDS", "TRANSCRIPTION_TIMEOUT_MS", "TRANSCRIPTION_CONCURRENCY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir = "";

/** Áudio de verdade (Opus, como o WhatsApp), gerado pelo ffmpeg. */
function opus(seconds: number): Buffer {
  const file = path.join(dir, `a-${seconds}.ogg`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ac", "1", "-c:a", "libopus", "-b:a", "24k", file]);
  return readFileSync(file);
}

describe("Transcrição: fila, duração máxima e tempo limite", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "fa-audio-"));
    initTestQueues("transcription-limits");
  });
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
    fake.transcribe.mockReset();
    fake.clients.length = 0;
    Object.assign(process.env, { TRANSCRIPTION_PROVIDER: "openai_compatible", TRANSCRIPTION_BASE_URL: "http://whisper:8000/v1", WHISPER_MODEL: "base" });
    resetEnvCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("uma transcrição por vez; tempo limite de 120 s no servidor próprio, sem nova tentativa automática", async () => {
    const fam = await createWaFamily("Família Fila");
    let running = 0;
    let max = 0;
    fake.transcribe.mockImplementation(async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 120));
      running--;
      return { text: "gastei 10 de pão" };
    });
    const audio = opus(3);
    const results = await Promise.all([1, 2, 3].map(() => transcribeAudio(fam.householdId, audio, "audio/ogg")));
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(max).toBe(1);
    expect(results[0]!.seconds).toBeGreaterThanOrEqual(2);
    expect(results[0]!.seconds).toBeLessThanOrEqual(4);
    expect(fake.clients.at(-1)).toMatchObject({ baseURL: "http://whisper:8000/v1", timeout: 120_000, maxRetries: 0 });
    expect(fake.transcribe.mock.calls[0]![0]).toMatchObject({ model: "Systran/faster-whisper-base", language: "pt" });

    // Com TRANSCRIPTION_CONCURRENCY=2, duas ao mesmo tempo.
    process.env.TRANSCRIPTION_CONCURRENCY = "2";
    resetEnvCache();
    max = 0;
    await Promise.all([1, 2, 3, 4].map(() => transcribeAudio(fam.householdId, audio, "audio/ogg")));
    expect(max).toBe(2);
  });

  it("áudio acima do limite não é enviado; o bot pede para mandar em partes", async () => {
    process.env.TRANSCRIPTION_MAX_SECONDS = "5";
    resetEnvCache();
    const fam = await createWaFamily("Família Longa");
    const sent = await sendMessage(fam, { type: "AUDIO", media: { bytes: opus(12), mimeType: "audio/ogg; codecs=opus" } });
    expect(fake.transcribe).not.toHaveBeenCalled();
    expect(sent.reply).toMatch(/🎙️ Esse áudio tem 1[12] s — passa do limite de 5 s para transcrever\. Pode mandar em partes menores ou por texto\?/);
    expect(sent.message.status).toBe("NEEDS_CLARIFICATION");
    // Curto passa normalmente.
    fake.transcribe.mockResolvedValue({ text: "gastei 20 de pão" });
    const ok = await sendMessage(fam, { type: "AUDIO", media: { bytes: opus(3), mimeType: "audio/ogg; codecs=opus" } });
    expect(ok.reply).toContain("gastei 20 de pão");
  });

  it("prompt com o vocabulário da família (só no servidor próprio) e correção do texto antes do interpretador", async () => {
    const fam = await createWaFamily("Família Vocabulário");
    const { createAccount } = await import("@/server/modules/accounts/service");
    const { createCard } = await import("@/server/modules/cards/service");
    const { createTransaction } = await import("@/server/modules/transactions/service");
    const itau = await createAccount(fam.ctx, { name: "Itaú", institution: "Itaú", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
    await createCard(fam.ctx, { name: "Nubank", issuer: "Nubank", closingDay: 3, dueDay: 10, limitCents: 500_000, paymentAccountId: itau.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 50_000, description: "Pix Ícaro", date: "2026-10-01", accountId: itau.id });

    fake.transcribe.mockResolvedValueOnce({ text: "Paguei 750 reais proí caro em presa." }).mockResolvedValueOnce({ text: "Almoço 45 reais no cartão no banque, pessoal!" });
    const a = await sendMessage(fam, { type: "AUDIO", media: { bytes: opus(3), mimeType: "audio/ogg; codecs=opus" } });
    const prompt = (fake.transcribe.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("Ícaro");
    expect(prompt).toContain("Nubank");
    expect(prompt).toContain("Natureza: empresa, pessoal, PJ, PF.");
    expect(a.reply).toContain("pro Ícaro empresa");
    const { prisma } = await import("@/server/db");
    const icaro = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, amountCents: 75_000 } });
    expect(icaro.scope).toBe("BUSINESS");
    expect(icaro.description).toContain("Ícaro");

    await sendMessage(fam, { type: "AUDIO", media: { bytes: opus(3), mimeType: "audio/ogg; codecs=opus" } });
    const lunch = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, amountCents: 4_500 }, include: { creditCard: true } });
    expect(lunch).toMatchObject({ scope: "PERSONAL", paymentMethod: "CREDIT_CARD" });
    expect(lunch.creditCard?.name).toBe("Nubank");

    // Provedor externo: só o texto genérico (nomes e contas não saem do servidor).
    const { transcriptionPrompt, familyVocabulary } = await import("@/server/ai/transcription/vocabulary");
    const vocab = await familyVocabulary(fam.householdId);
    expect(vocab.names).toContain("Ícaro");
    expect(transcriptionPrompt(vocab, true)).not.toMatch(/Ícaro|Nubank|Itaú/);
    expect(transcriptionPrompt(vocab, false).length).toBeLessThan(800);
  });

  it("tempo esgotado, 413 do servidor e modelo ausente viram respostas claras", async () => {
    const fam = await createWaFamily("Família Erros");
    const audio = opus(3);
    fake.transcribe.mockRejectedValueOnce(new APIConnectionTimeoutError());
    expect(await transcribeAudio(fam.householdId, audio, "audio/ogg")).toMatchObject({ ok: false, userReason: "a transcrição demorou demais", reason: expect.stringContaining("120 s") });

    fake.transcribe.mockRejectedValueOnce(Object.assign(new Error("413 Áudio de 6.7 min; o limite é 5.5 min."), { status: 413, code: "audio_too_long" }));
    expect((await transcribeAudio(fam.householdId, audio, "audio/ogg")).reply).toContain("passa do limite");

    fake.transcribe.mockRejectedValueOnce(Object.assign(new Error("404 Este servidor só tem o modelo Systran/faster-whisper-base"), { status: 404, code: "model_not_found" }));
    expect(await transcribeAudio(fam.householdId, audio, "audio/ogg")).toMatchObject({ ok: false, userReason: expect.stringContaining("WHISPER_MODEL") });

    // speaches: modelo não baixado → POST /v1/models/{id} e uma nova tentativa.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Model downloaded", { status: 200 }));
    fake.transcribe
      .mockRejectedValueOnce(Object.assign(new Error("404 Model 'Systran/faster-whisper-base' is not installed locally. You can download the model using `POST /v1/models`"), { status: 404 }))
      .mockResolvedValueOnce({ text: "paguei 30 de táxi" });
    expect(await transcribeAudio(fam.householdId, audio, "audio/ogg")).toMatchObject({ ok: true, text: "paguei 30 de táxi" });
    expect(fetchSpy).toHaveBeenCalledWith("http://whisper:8000/v1/models/Systran/faster-whisper-base", expect.objectContaining({ method: "POST" }));
  });
});
