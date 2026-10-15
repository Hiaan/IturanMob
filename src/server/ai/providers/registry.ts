import type { AIProviderType, AITask, Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { env } from "../../env";
import { decryptStringSafe } from "../../crypto";
import { logger } from "../../logger";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./types";

/**
 * Seleção do provedor por tarefa. Ordem: configuração da família (AITaskConfig) →
 * padrão do ambiente (AI_DEFAULT_PROVIDER). Exige consentimento explícito da família
 * para envio de dados a provedores externos; sem consentimento, usa o motor local.
 */
export interface ProviderResolution {
  provider: LLMProvider | null;
  type: AIProviderType;
  model: string;
  reason: string | null;
}

export function defaultModelFor(type: AIProviderType): string {
  const e = env();
  switch (type) {
    case "ANTHROPIC":
      return e.ANTHROPIC_MODEL;
    case "OPENAI":
      return e.OPENAI_MODEL;
    case "OPENAI_COMPATIBLE":
      return e.OPENAI_COMPATIBLE_MODEL ?? e.OPENAI_MODEL;
    case "LOCAL":
      return "heuristico-ptbr";
  }
}

export async function credentialsFor(householdId: string, type: AIProviderType): Promise<{ apiKey: string | null; baseUrl: string | null; source: "database" | "env" | null }> {
  const e = env();
  const stored = await prisma.aIProviderCredential.findUnique({ where: { householdId_provider: { householdId, provider: type } } });
  const storedKey = stored ? decryptStringSafe(stored.encryptedApiKey) : null;
  if (storedKey) return { apiKey: storedKey, baseUrl: stored?.baseUrl ?? null, source: "database" };
  if (type === "ANTHROPIC" && e.ANTHROPIC_API_KEY) return { apiKey: e.ANTHROPIC_API_KEY, baseUrl: null, source: "env" };
  if (type === "OPENAI" && e.OPENAI_API_KEY) return { apiKey: e.OPENAI_API_KEY, baseUrl: e.OPENAI_BASE_URL ?? null, source: "env" };
  if (type === "OPENAI_COMPATIBLE" && e.OPENAI_COMPATIBLE_BASE_URL) {
    return { apiKey: e.OPENAI_COMPATIBLE_API_KEY ?? "not-needed", baseUrl: e.OPENAI_COMPATIBLE_BASE_URL, source: "env" };
  }
  return { apiKey: null, baseUrl: stored?.baseUrl ?? null, source: null };
}

export function buildProvider(type: AIProviderType, model: string, apiKey: string, baseUrl: string | null): LLMProvider | null {
  if (type === "ANTHROPIC") return new AnthropicProvider(apiKey, model);
  if (type === "OPENAI") return new OpenAIProvider("OPENAI", apiKey, model, baseUrl);
  if (type === "OPENAI_COMPATIBLE") return new OpenAIProvider("OPENAI_COMPATIBLE", apiKey, model, baseUrl);
  return null;
}

export async function resolveProvider(householdId: string, task: AITask): Promise<ProviderResolution> {
  const settings = await prisma.householdSettings.findUnique({ where: { householdId } });
  const config = await prisma.aITaskConfig.findUnique({ where: { householdId_task: { householdId, task } } });
  const type: AIProviderType = config?.enabled === false ? "LOCAL" : config?.provider ?? env().AI_DEFAULT_PROVIDER;
  const model = config?.model || defaultModelFor(type);
  if (type === "LOCAL") return { provider: null, type, model: defaultModelFor("LOCAL"), reason: null };
  if (!settings?.aiExternalAllowed) {
    return { provider: null, type: "LOCAL", model: defaultModelFor("LOCAL"), reason: "Envio de dados a provedores de IA não autorizado pela família (Configurações → Privacidade)." };
  }
  if (task === "RECEIPT_EXTRACTION" && !settings.aiImageAllowed) {
    return { provider: null, type: "LOCAL", model: "-", reason: "Leitura de comprovantes por IA não autorizada." };
  }
  const creds = await credentialsFor(householdId, type);
  if (!creds.apiKey) return { provider: null, type: "LOCAL", model: defaultModelFor("LOCAL"), reason: `Chave de API não configurada para ${type}.` };
  return { provider: buildProvider(type, model, creds.apiKey, creds.baseUrl), type, model, reason: null };
}

export interface AILogInput {
  householdId: string;
  task: AITask;
  provider: AIProviderType;
  model: string;
  status: "SUCCESS" | "ERROR" | "FALLBACK";
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  messageId?: string | null;
  error?: string | null;
  output?: Prisma.InputJsonValue;
}

/** Registro de uso de IA (sem conteúdo bruto das mensagens). */
export async function logAI(input: AILogInput): Promise<void> {
  try {
    await prisma.aIProcessingLog.create({
      data: {
        householdId: input.householdId,
        task: input.task,
        provider: input.provider,
        model: input.model,
        status: input.status,
        latencyMs: Math.round(input.latencyMs),
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        messageId: input.messageId ?? null,
        error: input.error?.slice(0, 500) ?? null,
        output: input.output,
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "ai: falha ao registrar log");
  }
}
