import { z } from "zod";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { NotFoundError } from "../../errors";
import { todayISO } from "@/lib/dates";
import { logger } from "../../logger";
import { sanitizeUntrusted } from "../nlu/text";
import { logAI, resolveProvider } from "../providers/registry";
import { assistantSystemPrompt } from "../prompts/assistant";
import { answerLocally } from "./local";
import { runTool, toolDefinitions } from "./tools";

export interface AssistantAnswer {
  text: string;
  engine: string;
  model: string | null;
  toolCalls: Array<{ name: string; input: unknown; ok?: boolean }>;
  fallbackReason: string | null;
}

/**
 * Responde uma pergunta sobre os dados da família. Com provedor de IA autorizado, usa um
 * loop de ferramentas somente-leitura; caso contrário (ou em falha), o assistente local.
 */
export async function answerQuestion(
  ctx: ServiceContext,
  rawQuestion: string,
  opts: { channel: "WHATSAPP" | "DASHBOARD"; history?: Array<{ role: "user" | "assistant"; content: string }> } = { channel: "DASHBOARD" },
): Promise<AssistantAnswer> {
  const question = sanitizeUntrusted(rawQuestion, 1000);
  const resolution = await resolveProvider(ctx.householdId, "ASSISTANT");
  let fallbackReason = resolution.reason;
  if (resolution.provider) {
    const started = Date.now();
    try {
      const household = await prisma.household.findUniqueOrThrow({ where: { id: ctx.householdId }, select: { name: true } });
      const member = ctx.memberId ? await prisma.householdMember.findUnique({ where: { id: ctx.memberId }, select: { displayName: true } }) : null;
      const res = await resolution.provider.runTools({
        system: assistantSystemPrompt({ householdName: household.name, today: todayISO(ctx.timezone), memberName: member?.displayName ?? null, channel: opts.channel }),
        messages: [...(opts.history ?? []).slice(-8), { role: "user", content: question }],
        tools: toolDefinitions(),
        execute: (name, input) => runTool(ctx, name, input),
        maxIterations: 8,
      });
      await logAI({
        householdId: ctx.householdId,
        task: "ASSISTANT",
        provider: resolution.type,
        model: resolution.model,
        status: "SUCCESS",
        latencyMs: Date.now() - started,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        output: { tools: res.toolCalls.map((t) => t.name) },
      });
      if (res.text) return { text: res.text, engine: resolution.type, model: resolution.model, toolCalls: res.toolCalls, fallbackReason: null };
      fallbackReason = "Resposta vazia do provedor.";
    } catch (err) {
      fallbackReason = (err as Error).message;
      logger.warn({ err: fallbackReason }, "assistant: falha no provedor, usando assistente local");
      await logAI({ householdId: ctx.householdId, task: "ASSISTANT", provider: resolution.type, model: resolution.model, status: "FALLBACK", latencyMs: Date.now() - started, error: fallbackReason });
    }
  }
  const local = await answerLocally(ctx, question);
  return { text: local.text, engine: "LOCAL", model: null, toolCalls: local.toolCalls, fallbackReason };
}

// -----------------------------------------------------------------------------
// Conversas do painel
// -----------------------------------------------------------------------------

export const askSchema = z.object({
  conversationId: z.string().nullish(),
  question: z.string().trim().min(1, "Digite uma pergunta").max(1000),
});

export async function listConversations(ctx: ServiceContext) {
  return prisma.assistantConversation.findMany({
    where: { householdId: ctx.householdId, memberId: ctx.memberId ?? "" },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } },
  });
}

export async function getConversation(ctx: ServiceContext, id: string) {
  const conv = await prisma.assistantConversation.findFirst({
    where: { id, householdId: ctx.householdId, memberId: ctx.memberId ?? "" },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conv) throw new NotFoundError("Conversa");
  return conv;
}

export async function deleteConversation(ctx: ServiceContext, id: string) {
  const conv = await getConversation(ctx, id);
  await prisma.assistantConversation.delete({ where: { id: conv.id } });
}

export async function ask(ctx: ServiceContext, input: z.input<typeof askSchema>) {
  const data = askSchema.parse(input);
  if (!ctx.memberId) throw new NotFoundError("Membro");
  let conversationId = data.conversationId ?? null;
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (conversationId) {
    const conv = await getConversation(ctx, conversationId);
    history = conv.messages.map((m) => ({ role: m.role === "USER" ? "user" : "assistant", content: m.content }));
  } else {
    const conv = await prisma.assistantConversation.create({
      data: { householdId: ctx.householdId, memberId: ctx.memberId, title: data.question.slice(0, 60) },
    });
    conversationId = conv.id;
  }
  const userMsg = await prisma.assistantMessage.create({ data: { conversationId, role: "USER", content: data.question } });
  const answer = await answerQuestion(ctx, data.question, { channel: "DASHBOARD", history });
  const assistantMsg = await prisma.assistantMessage.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: answer.text,
      metadata: { engine: answer.engine, model: answer.model, tools: answer.toolCalls.map((t) => t.name), fallbackReason: answer.fallbackReason },
    },
  });
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return { conversationId, userMessage: userMsg, assistantMessage: assistantMsg };
}
