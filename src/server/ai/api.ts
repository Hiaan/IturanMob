import { z } from "zod";
import type { AIProviderType, AITask } from "@prisma/client";
import { prisma } from "../db";
import type { ServiceContext } from "../auth/context";
import { assertCan } from "../auth/permissions";
import { encryptString } from "../crypto";
import { env } from "../env";
import { ValidationError } from "../errors";
import { audit } from "../modules/audit/service";
import { getSettings } from "../modules/households/service";
import { interpretText } from "./engine/interpret";
import { executeInterpretation } from "./engine/actions";
import { answerQuestion } from "./assistant/service";
import { buildProvider, credentialsFor, defaultModelFor, resolveProvider } from "./providers/registry";
import { transcriptionStatus } from "./transcription";

export const textSchema = z.object({ text: z.string().trim().min(1, "Escreva o lançamento").max(1000) });

const ENGINE_LABEL: Record<string, string> = { LOCAL: "Motor local", ANTHROPIC: "Claude", OPENAI: "OpenAI", OPENAI_COMPATIBLE: "Modelo compatível" };

/** Pré-visualização do lançamento rápido: interpreta sem gravar. */
export async function previewText(ctx: ServiceContext, text: string) {
  const result = await interpretText(ctx, text, { senderMemberId: ctx.memberId });
  let message: string | null = null;
  if (result.raw.intent === "QUERY") message = (await answerQuestion(ctx, result.raw.question ?? text, { channel: "DASHBOARD" })).text;
  else if (result.raw.intent === "CORRECTION" || result.raw.intent === "DELETE") message = "Correções e exclusões pelo painel são feitas na tela de Transações (ou por mensagem no grupo do WhatsApp).";
  else if (result.raw.intent !== "CREATE_TRANSACTIONS") message = "Não identifiquei um lançamento nesta mensagem.";
  if (result.fallbackReason && result.raw.engine === "LOCAL") message = [message, `Interpretado pelo motor local (${result.fallbackReason})`].filter(Boolean).join("\n");
  return {
    intent: result.raw.intent,
    engine: `${ENGINE_LABEL[result.raw.engine] ?? result.raw.engine}${result.raw.model ? ` · ${result.raw.model}` : ""}`,
    message,
    requiresConfirmation: result.drafts.some((d) => d.decision !== "AUTO"),
    drafts: result.drafts.map((d) => ({
      index: d.index,
      type: d.kind === "GOAL_CONTRIBUTION" ? "GOAL_CONTRIBUTION" : d.kind,
      amountCents: d.amountCents,
      description: d.description,
      date: d.date,
      categoryName: d.labels.category,
      subcategoryName: d.labels.subcategory,
      paymentMethod: d.paymentMethod,
      accountName: d.kind === "TRANSFER" ? `${d.labels.account ?? "?"} → ${d.labels.destinationAccount ?? "?"}` : d.labels.account,
      creditCardName: d.labels.card,
      installmentCount: d.installmentCount,
      responsibleName: d.ownership === "INDIVIDUAL" ? d.labels.responsible : d.labels.payer,
      merchant: d.merchantName,
      confidence: d.confidence,
      missing: d.missing,
      warnings: d.warnings,
    })),
  };
}

/** Aplica o lançamento rápido após a confirmação do usuário na pré-visualização. */
export async function applyText(ctx: ServiceContext, text: string) {
  assertCan(ctx, "transactions:write");
  const result = await interpretText(ctx, text, { senderMemberId: ctx.memberId });
  if (result.raw.intent !== "CREATE_TRANSACTIONS" || !result.drafts.length) throw new ValidationError("Não identifiquei um lançamento nesta mensagem.");
  const missing = result.drafts.find((d) => d.missing.length);
  if (missing) throw new ValidationError(`Falta informar: ${missing.missing.join(", ")} (${missing.description}).`);
  const outcome = await executeInterpretation(ctx, result, {
    channel: "DASHBOARD",
    chatId: `dashboard:${ctx.memberId}`,
    source: "DASHBOARD_CHAT",
    answerQueries: false,
    text,
    forceConfirm: true,
  });
  const plain = outcome.replies.join("\n").replace(/\*/g, "").replace(/_/g, "");
  return { created: outcome.transactionIds.length, transactionIds: outcome.transactionIds, message: outcome.transactionIds.length ? `${outcome.transactionIds.length} lançamento(s) registrado(s)` : plain || "Nada foi registrado.", details: plain };
}

// -----------------------------------------------------------------------------
// Configuração de provedores
// -----------------------------------------------------------------------------

const TASKS: AITask[] = ["PARSE_MESSAGE", "RECEIPT_EXTRACTION", "TRANSCRIPTION", "ASSISTANT", "INSIGHTS"];
const PROVIDERS: AIProviderType[] = ["ANTHROPIC", "OPENAI", "OPENAI_COMPATIBLE"];

export async function getAIConfig(ctx: ServiceContext) {
  const settings = await getSettings(ctx.householdId);
  const configs = await prisma.aITaskConfig.findMany({ where: { householdId: ctx.householdId } });
  const providers = [];
  for (const p of PROVIDERS) {
    const creds = await credentialsFor(ctx.householdId, p);
    const stored = await prisma.aIProviderCredential.findUnique({ where: { householdId_provider: { householdId: ctx.householdId, provider: p } }, select: { updatedAt: true, baseUrl: true } });
    providers.push({ type: p, configured: Boolean(creds.apiKey), source: creds.source, baseUrl: creds.baseUrl, storedAt: stored?.updatedAt ?? null, defaultModel: defaultModelFor(p) });
  }
  const tasks = [];
  for (const t of TASKS) {
    const c = configs.find((x) => x.task === t);
    const resolution = t === "TRANSCRIPTION" ? null : await resolveProvider(ctx.householdId, t);
    // Transcrição: o que vale de fato (servidor da instância, OpenAI, compatível ou desligada).
    const tStatus = t === "TRANSCRIPTION" ? await transcriptionStatus(ctx.householdId) : null;
    const transcriptionEffective = tStatus
      ? tStatus.enabled
        ? {
            provider: tStatus.provider as "OPENAI" | "OPENAI_COMPATIBLE",
            model: tStatus.model ?? "",
            reason: tStatus.external && !(settings.aiExternalAllowed && settings.aiAudioAllowed) ? "o envio de áudios para fora não foi autorizado (Privacidade)" : null,
          }
        : { provider: "LOCAL" as const, model: "", reason: tStatus.reason }
      : null;
    tasks.push({
      task: t,
      provider: c?.provider ?? (t === "TRANSCRIPTION" ? (env().TRANSCRIPTION_PROVIDER === "none" ? "LOCAL" : env().TRANSCRIPTION_PROVIDER === "openai" ? "OPENAI" : "OPENAI_COMPATIBLE") : env().AI_DEFAULT_PROVIDER),
      model: c?.model ?? (t === "TRANSCRIPTION" ? env().TRANSCRIPTION_MODEL : defaultModelFor(env().AI_DEFAULT_PROVIDER)),
      enabled: c?.enabled ?? true,
      customized: Boolean(c),
      effective: resolution
        ? { provider: resolution.provider ? resolution.type : "LOCAL", model: resolution.provider ? resolution.model : "heuristico-ptbr", reason: resolution.reason }
        : transcriptionEffective,
    });
  }
  return {
    consent: { aiExternalAllowed: settings.aiExternalAllowed, aiAudioAllowed: settings.aiAudioAllowed, aiImageAllowed: settings.aiImageAllowed },
    defaults: { provider: env().AI_DEFAULT_PROVIDER, transcription: env().TRANSCRIPTION_PROVIDER, transcriptionServer: Boolean(env().TRANSCRIPTION_PROVIDER === "openai_compatible" && env().TRANSCRIPTION_BASE_URL) },
    providers,
    tasks,
  };
}

export const taskConfigSchema = z.object({
  items: z
    .array(
      z.object({
        task: z.enum(["PARSE_MESSAGE", "RECEIPT_EXTRACTION", "TRANSCRIPTION", "ASSISTANT", "INSIGHTS"]),
        provider: z.enum(["ANTHROPIC", "OPENAI", "OPENAI_COMPATIBLE", "LOCAL"]),
        model: z.string().trim().max(100).default(""),
        enabled: z.boolean().default(true),
      }),
    )
    .max(10),
});

export async function updateTaskConfigs(ctx: ServiceContext, input: z.input<typeof taskConfigSchema>) {
  assertCan(ctx, "integrations:manage");
  const data = taskConfigSchema.parse(input);
  for (const item of data.items) {
    if (item.task === "TRANSCRIPTION" && item.provider === "ANTHROPIC") throw new ValidationError("A transcrição de áudio exige um provedor compatível com Whisper (OpenAI ou servidor compatível).");
    const model = item.model || (item.task === "TRANSCRIPTION" ? env().TRANSCRIPTION_MODEL : defaultModelFor(item.provider));
    await prisma.aITaskConfig.upsert({
      where: { householdId_task: { householdId: ctx.householdId, task: item.task } },
      update: { provider: item.provider, model, enabled: item.enabled },
      create: { householdId: ctx.householdId, task: item.task, provider: item.provider, model, enabled: item.enabled },
    });
  }
  await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "AITaskConfig", metadata: { items: data.items } });
  return getAIConfig(ctx);
}

export const credentialSchema = z.object({
  provider: z.enum(["ANTHROPIC", "OPENAI", "OPENAI_COMPATIBLE"]),
  apiKey: z.string().trim().min(8, "Chave inválida").max(500),
  baseUrl: z.string().trim().url().max(300).nullish(),
});

export async function saveCredential(ctx: ServiceContext, input: z.input<typeof credentialSchema>) {
  assertCan(ctx, "integrations:manage");
  const data = credentialSchema.parse(input);
  await prisma.aIProviderCredential.upsert({
    where: { householdId_provider: { householdId: ctx.householdId, provider: data.provider } },
    update: { encryptedApiKey: encryptString(data.apiKey), baseUrl: data.baseUrl ?? null },
    create: { householdId: ctx.householdId, provider: data.provider, encryptedApiKey: encryptString(data.apiKey), baseUrl: data.baseUrl ?? null },
  });
  // A chave nunca é registrada na auditoria.
  await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "AIProviderCredential", metadata: { provider: data.provider, baseUrl: data.baseUrl ?? null } });
  return { ok: true };
}

export async function deleteCredential(ctx: ServiceContext, provider: AIProviderType) {
  assertCan(ctx, "integrations:manage");
  await prisma.aIProviderCredential.deleteMany({ where: { householdId: ctx.householdId, provider } });
  await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "AIProviderCredential", metadata: { provider, removed: true } });
  return { ok: true };
}

/** Teste de conectividade com dados sintéticos (nenhum dado da família é enviado). */
export async function testProvider(ctx: ServiceContext, provider: AIProviderType, model?: string) {
  assertCan(ctx, "integrations:manage");
  const creds = await credentialsFor(ctx.householdId, provider);
  if (!creds.apiKey) throw new ValidationError("Chave de API não configurada para este provedor.");
  const p = buildProvider(provider, model || defaultModelFor(provider), creds.apiKey, creds.baseUrl);
  if (!p) throw new ValidationError("Provedor inválido.");
  const started = Date.now();
  try {
    const res = await p.structured({
      task: "PARSE_MESSAGE",
      system: "Responda apenas no formato JSON solicitado.",
      user: [{ type: "text", text: "Teste de conectividade: retorne ok=true." }],
      jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
      schemaName: "teste",
      maxTokens: 300,
      effort: "low",
    });
    return { ok: true, latencyMs: Date.now() - started, model: p.model, response: res.json };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, model: p.model, error: (err as Error).message };
  }
}

export async function listAILogs(ctx: ServiceContext, limit = 50) {
  return prisma.aIProcessingLog.findMany({ where: { householdId: ctx.householdId }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 200) });
}
