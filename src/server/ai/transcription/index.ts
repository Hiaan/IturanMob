import { spawn } from "node:child_process";
import OpenAI, { toFile } from "openai";
import { prisma } from "../../db";
import { env } from "../../env";
import { logger } from "../../logger";
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
  reason?: string;
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

async function transcriptionClient(householdId: string): Promise<{ client: OpenAI; model: string; provider: string; external: boolean } | { reason: string }> {
  const e = env();
  const config = await prisma.aITaskConfig.findUnique({ where: { householdId_task: { householdId, task: "TRANSCRIPTION" } } });
  if (config && (!config.enabled || config.provider === "LOCAL")) return { reason: "Transcrição de áudio desativada nas configurações de IA." };
  if (config && (config.provider === "OPENAI" || config.provider === "OPENAI_COMPATIBLE")) {
    const creds = await credentialsFor(householdId, config.provider);
    if (!creds.apiKey) return { reason: "Chave de API para transcrição não configurada." };
    return {
      client: new OpenAI({ apiKey: creds.apiKey, baseURL: creds.baseUrl ?? undefined, timeout: e.AI_TIMEOUT_MS }),
      model: config.model || e.TRANSCRIPTION_MODEL,
      provider: config.provider,
      external: !isPrivateHost(creds.baseUrl),
    };
  }
  if (e.TRANSCRIPTION_PROVIDER === "none") return { reason: "Transcrição de áudio não configurada (TRANSCRIPTION_PROVIDER)." };
  const apiKey = e.TRANSCRIPTION_API_KEY ?? (e.TRANSCRIPTION_PROVIDER === "openai" ? e.OPENAI_API_KEY : undefined) ?? "not-needed";
  if (e.TRANSCRIPTION_PROVIDER === "openai" && apiKey === "not-needed") return { reason: "Chave da OpenAI para transcrição não configurada." };
  const baseURL = e.TRANSCRIPTION_PROVIDER === "openai_compatible" ? e.TRANSCRIPTION_BASE_URL : undefined;
  if (e.TRANSCRIPTION_PROVIDER === "openai_compatible" && !baseURL) return { reason: "TRANSCRIPTION_BASE_URL não configurada." };
  return {
    client: new OpenAI({ apiKey, baseURL, timeout: e.AI_TIMEOUT_MS }),
    model: e.TRANSCRIPTION_MODEL,
    provider: e.TRANSCRIPTION_PROVIDER === "openai" ? "OPENAI" : "OPENAI_COMPATIBLE",
    external: e.TRANSCRIPTION_PROVIDER === "openai" || !isPrivateHost(baseURL),
  };
}

export async function transcribeAudio(householdId: string, audio: Buffer, mimeType: string, messageId?: string | null): Promise<TranscriptionResult> {
  const setup = await transcriptionClient(householdId);
  if ("reason" in setup) return { ok: false, reason: setup.reason };
  if (setup.external) {
    const settings = await prisma.householdSettings.findUnique({ where: { householdId } });
    if (!settings?.aiExternalAllowed || !settings.aiAudioAllowed) {
      return { ok: false, reason: "Envio de áudios para transcrição externa não autorizado pela família (Configurações → Privacidade)." };
    }
  }
  const started = Date.now();
  let payload = audio;
  let name = "audio.ogg";
  let type = mimeType.split(";")[0] ?? "audio/ogg";
  try {
    payload = await convertToMp3(audio);
    name = "audio.mp3";
    type = "audio/mpeg";
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "transcrição: conversão falhou, enviando original");
  }
  try {
    const res = await setup.client.audio.transcriptions.create({
      file: await toFile(payload, name, { type }),
      model: setup.model,
      language: "pt",
      prompt: "Mensagem de controle financeiro familiar em português do Brasil: valores em reais e centavos, cartão de crédito, débito, Pix, parcelas, mercado, farmácia.",
    });
    const text = (res.text ?? "").trim();
    await logAI({ householdId, task: "TRANSCRIPTION", provider: setup.provider as "OPENAI", model: setup.model, status: "SUCCESS", latencyMs: Date.now() - started, messageId, output: { chars: text.length } });
    if (!text) return { ok: false, reason: "Não foi possível entender o áudio." };
    return { ok: true, text, provider: setup.provider, model: setup.model };
  } catch (err) {
    const reason = (err as Error).message.slice(0, 200);
    await logAI({ householdId, task: "TRANSCRIPTION", provider: setup.provider as "OPENAI", model: setup.model, status: "ERROR", latencyMs: Date.now() - started, messageId, error: reason });
    return { ok: false, reason: `Falha na transcrição: ${reason}` };
  }
}
