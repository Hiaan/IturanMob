import { spawn } from "node:child_process";
import OpenAI, { APIConnectionTimeoutError, toFile } from "openai";
import { prisma } from "../../db";
import { env } from "../../env";
import { logger } from "../../logger";
import { decryptStringSafe } from "../../crypto";
import { credentialsFor, logAI } from "../providers/registry";

/**
 * Transcrição de áudio (API compatível com Whisper: OpenAI ou servidor próprio).
 * Servidores locais/privados (ex.: whisper em Docker na mesma rede) não exigem
 * consentimento de envio externo; provedores externos exigem aiAudioAllowed.
 */
export interface TranscriptionResult {
  ok: boolean;
  text?: string;
  provider?: string;
  model?: string;
  /** Motivo completo (pendência/registro). */
  reason?: string;
  /** Motivo curto para a resposta no grupo ("transcrição desligada"). */
  userReason?: string;
  /** Resposta completa para o grupo, quando não segue o padrão "Não consegui ouvir o áudio: …". */
  reply?: string;
  /** Duração do áudio em segundos (estimada pelo MP3 convertido). */
  seconds?: number;
}

function isPrivateHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      !host.includes(".")
    );
  } catch {
    return false;
  }
}

/** Converte qualquer áudio para MP3 mono 16 kHz (formato aceito por todos os servidores Whisper). */
export function convertToMp3(input: Buffer, timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(env().FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Tempo esgotado na conversão de áudio"));
    }, timeoutMs);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg falhou (${code}): ${stderr.slice(0, 200)}`));
    });
    proc.stdin.on("error", () => undefined);
    proc.stdin.end(input);
  });
}

type ClientSetup = { client: OpenAI; model: string; provider: string; external: boolean; baseURL: string | null };
type ClientOff = { reason: string; short: string };

const off = (reason: string, short: string): ClientOff => ({ reason, short });

/** Servidor de transcrição da própria instância (ex.: Whisper no Docker: http://whisper:8000/v1). */
function instanceServer(): { baseURL: string; apiKey: string } | null {
  const e = env();
  if (e.TRANSCRIPTION_PROVIDER !== "openai_compatible" || !e.TRANSCRIPTION_BASE_URL) return null;
  return { baseURL: e.TRANSCRIPTION_BASE_URL, apiKey: e.TRANSCRIPTION_API_KEY || "not-needed" };
}

/**
 * Modelo para servidor compatível: o informado; "whisper-1" (nome da OpenAI) vira o modelo do
 * Whisper próprio (`Systran/faster-whisper-<WHISPER_MODEL>`, padrão "small").
 */
export function compatibleModel(configured?: string | null): string {
  const e = env();
  const pick = configured && configured !== "whisper-1" ? configured : e.TRANSCRIPTION_MODEL && e.TRANSCRIPTION_MODEL !== "whisper-1" ? e.TRANSCRIPTION_MODEL : null;
  return pick ?? `Systran/faster-whisper-${e.WHISPER_MODEL}`;
}

async function transcriptionClient(householdId: string): Promise<ClientSetup | ClientOff> {
  const e = env();
  const config = await prisma.aITaskConfig.findUnique({ where: { householdId_task: { householdId, task: "TRANSCRIPTION" } } });
  if (config && !config.enabled) return off("Transcrição de áudio desativada nas configurações de IA.", "transcrição desligada");
  const provider =
    config?.provider ?? (e.TRANSCRIPTION_PROVIDER === "openai" ? "OPENAI" : e.TRANSCRIPTION_PROVIDER === "openai_compatible" ? "OPENAI_COMPATIBLE" : "LOCAL");

  if (provider === "OPENAI") {
    const creds = await credentialsFor(householdId, "OPENAI");
    const apiKey = creds.apiKey ?? (e.TRANSCRIPTION_PROVIDER === "openai" ? e.TRANSCRIPTION_API_KEY : undefined) ?? null;
    if (!apiKey) return off("Chave da OpenAI para transcrição não configurada.", "transcrição sem chave configurada");
    const model = config?.model && !config.model.includes("/") ? config.model : "whisper-1";
    return {
      client: new OpenAI({ apiKey, baseURL: creds.baseUrl ?? undefined, timeout: e.TRANSCRIPTION_TIMEOUT_MS, maxRetries: 1 }),
      model,
      provider: "OPENAI",
      external: !isPrivateHost(creds.baseUrl) || !creds.baseUrl,
      baseURL: creds.baseUrl ?? null,
    };
  }

  if (provider === "OPENAI_COMPATIBLE") {
    // Credencial salva na família (endereço próprio) > servidor da instância > endereço compatível geral.
    const stored = await prisma.aIProviderCredential.findUnique({ where: { householdId_provider: { householdId, provider: "OPENAI_COMPATIBLE" } } });
    const storedKey = stored ? decryptStringSafe(stored.encryptedApiKey) : null;
    const server = instanceServer();
    const baseURL = stored?.baseUrl ?? server?.baseURL ?? e.OPENAI_COMPATIBLE_BASE_URL ?? null;
    if (!baseURL) return off("Servidor de transcrição não configurado (TRANSCRIPTION_BASE_URL).", "servidor de transcrição não configurado");
    const apiKey = storedKey || (stored?.baseUrl ? null : server?.apiKey) || e.TRANSCRIPTION_API_KEY || e.OPENAI_COMPATIBLE_API_KEY || "not-needed";
    return {
      // Servidor próprio: sem nova tentativa automática (não refaz uma transcrição longa na CPU).
      client: new OpenAI({ apiKey, baseURL, timeout: e.TRANSCRIPTION_TIMEOUT_MS, maxRetries: isPrivateHost(baseURL) ? 0 : 1 }),
      model: compatibleModel(config?.model),
      provider: "OPENAI_COMPATIBLE",
      external: !isPrivateHost(baseURL),
      baseURL,
    };
  }

  // "Local": o servidor de transcrição da própria instância, quando existir.
  const server = instanceServer();
  if (!server) return off("Transcrição de áudio não configurada (TRANSCRIPTION_PROVIDER=none e nenhum provedor nas configurações de IA).", "transcrição desligada");
  return {
    client: new OpenAI({ apiKey: server.apiKey, baseURL: server.baseURL, timeout: e.TRANSCRIPTION_TIMEOUT_MS, maxRetries: isPrivateHost(server.baseURL) ? 0 : 1 }),
    model: compatibleModel(null),
    provider: "OPENAI_COMPATIBLE",
    external: !isPrivateHost(server.baseURL),
    baseURL: server.baseURL,
  };
}

/** Se a instância/família tem transcrição ativa (para mensagens e telas). */
export async function transcriptionStatus(householdId: string): Promise<{ enabled: boolean; reason: string | null; provider: string | null; model: string | null; external: boolean }> {
  const setup = await transcriptionClient(householdId);
  if ("reason" in setup) return { enabled: false, reason: setup.reason, provider: null, model: null, external: false };
  return { enabled: true, reason: null, provider: setup.provider, model: setup.model, external: setup.external };
}

// -----------------------------------------------------------------------------
// Fila (uma transcrição por vez por processo) e limites
// -----------------------------------------------------------------------------

let active = 0;
const waiting: Array<() => void> = [];

/** Executa com uma vaga da fila; ao terminar, passa a vaga direto para o próximo da fila. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < env().TRANSCRIPTION_CONCURRENCY) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

/** Duração pelo tamanho: o MP3 convertido é CBR de 48 kbit/s (6.000 bytes por segundo). */
const MP3_BYTES_PER_SECOND = 6_000;
/** Sem conversão: estimativa por baixo (voz do WhatsApp fica entre 16 e 32 kbit/s). */
const RAW_BYTES_PER_SECOND = 4_000;

const minutes = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m} min${s ? ` ${s} s` : ""}` : `${s} s`;
};

function tooLong(seconds: number, max: number): TranscriptionResult {
  return {
    ok: false,
    seconds,
    reason: `Áudio de ${minutes(seconds)}; o limite de transcrição é ${minutes(max)} (TRANSCRIPTION_MAX_SECONDS).`,
    userReason: `o áudio é longo demais (${minutes(seconds)}; até ${minutes(max)})`,
    reply: `🎙️ Esse áudio tem ${minutes(seconds)} — passa do limite de ${minutes(max)} para transcrever. Pode mandar em partes menores ou por texto?`,
  };
}

/** speaches: modelo ainda não baixado → baixa (POST /v1/models/{id}) e tenta de novo uma vez. */
async function downloadSpeachesModel(baseURL: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models/${model.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", signal: AbortSignal.timeout(15 * 60_000) });
    return res.status === 200 || res.status === 201;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "transcrição: não foi possível baixar o modelo no servidor");
    return false;
  }
}

export async function transcribeAudio(householdId: string, audio: Buffer, mimeType: string, messageId?: string | null): Promise<TranscriptionResult> {
  const setup = await transcriptionClient(householdId);
  if ("reason" in setup) return { ok: false, reason: setup.reason, userReason: setup.short };
  if (setup.external) {
    const settings = await prisma.householdSettings.findUnique({ where: { householdId } });
    if (!settings?.aiExternalAllowed || !settings.aiAudioAllowed) {
      return {
        ok: false,
        reason: "Envio de áudios para transcrição externa não autorizado pela família (Configurações → Privacidade).",
        userReason: "o envio do áudio para transcrição externa não foi autorizado (Configurações → Privacidade)",
      };
    }
  }
  const e = env();
  let payload = audio;
  let name = "audio.ogg";
  let type = mimeType.split(";")[0] ?? "audio/ogg";
  let seconds: number;
  try {
    payload = await convertToMp3(audio);
    name = "audio.mp3";
    type = "audio/mpeg";
    seconds = payload.length / MP3_BYTES_PER_SECOND;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "transcrição: conversão falhou, enviando original");
    seconds = audio.length / RAW_BYTES_PER_SECOND;
  }
  seconds = Math.round(seconds);
  if (e.TRANSCRIPTION_MAX_SECONDS > 0 && seconds > e.TRANSCRIPTION_MAX_SECONDS) return tooLong(seconds, e.TRANSCRIPTION_MAX_SECONDS);

  // Uma transcrição por vez: o tempo na fila não conta para o tempo limite.
  return withSlot(async () => {
    const started = Date.now();
    const request = async () =>
      setup.client.audio.transcriptions.create({
        file: await toFile(payload, name, { type }),
        model: setup.model,
        language: "pt",
        prompt: "Mensagem de controle financeiro familiar em português do Brasil: valores em reais e centavos, cartão de crédito, débito, Pix, parcelas, mercado, farmácia.",
      });
    try {
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404 && setup.baseURL && /not installed locally/i.test((err as Error).message) && (await downloadSpeachesModel(setup.baseURL, setup.model))) res = await request();
        else throw err;
      }
      const text = (res.text ?? "").trim();
      await logAI({ householdId, task: "TRANSCRIPTION", provider: setup.provider as "OPENAI", model: setup.model, status: "SUCCESS", latencyMs: Date.now() - started, messageId, output: { chars: text.length, seconds } });
      if (!text) return { ok: false, seconds, reason: "Não foi possível entender o áudio.", userReason: "não deu para entender o que foi dito" };
      return { ok: true, text, provider: setup.provider, model: setup.model, seconds };
    } catch (err) {
      const status = (err as { status?: number }).status;
      const code = (err as { code?: string | null }).code ?? (err as { error?: { code?: string } }).error?.code;
      if (status === 413 && code === "audio_too_long") return tooLong(seconds, e.TRANSCRIPTION_MAX_SECONDS || seconds);
      const timedOut = err instanceof APIConnectionTimeoutError;
      const reason = timedOut ? `Tempo limite de ${Math.round(e.TRANSCRIPTION_TIMEOUT_MS / 1000)} s esgotado (TRANSCRIPTION_TIMEOUT_MS).` : (err as Error).message.slice(0, 200);
      await logAI({ householdId, task: "TRANSCRIPTION", provider: setup.provider as "OPENAI", model: setup.model, status: "ERROR", latencyMs: Date.now() - started, messageId, error: reason });
      return {
        ok: false,
        seconds,
        reason: `Falha na transcrição: ${reason}`,
        userReason: timedOut
          ? "a transcrição demorou demais"
          : status === 503
            ? "o servidor de transcrição está sem o modelo agora"
            : status === 404 && code === "model_not_found"
              ? "o servidor de transcrição não tem esse modelo (confira WHISPER_MODEL)"
              : "o serviço de transcrição não respondeu agora",
      };
    }
  });
}
