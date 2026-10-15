import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { dateToISO } from "@/lib/dates";
import { logger } from "../../logger";
import { parseLocally } from "../nlu/local-parser";
import { sanitizeUntrusted } from "../nlu/text";
import { extractDate } from "../nlu/dates";
import { amountMentioned } from "../nlu/numbers";
import { loadHouseholdContext, type HouseholdContext } from "./context";
import { resolveDraft, type ResolvedDraft } from "./resolve";
import { llmInterpretationJsonSchema, llmInterpretationSchema, type LlmInterpretation, type RawDraft, type RawInterpretation } from "./schemas";
import { logAI, resolveProvider } from "../providers/registry";
import { parseSystemPrompt, parseUserPrompt } from "../prompts/parse-message";

export interface RecentTx {
  index: number;
  id: string;
  description: string;
  amountCents: number;
  date: string;
  type: string;
  createdByMemberId: string | null;
  categoryName: string | null;
  merchantName: string | null;
  createdAt: Date;
}

export interface InterpretResult {
  raw: RawInterpretation;
  drafts: ResolvedDraft[];
  hc: HouseholdContext;
  recent: RecentTx[];
  /** Motivo de uso do motor local quando um provedor externo estava configurado. */
  fallbackReason: string | null;
}

/** Transações recentes (30 dias) para correções/exclusões, mais recentes primeiro. */
export async function loadRecentTransactions(ctx: ServiceContext, limit = 20): Promise<RecentTx[]> {
  const rows = await prisma.transaction.findMany({
    where: { householdId: ctx.householdId, deletedAt: null, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { category: { select: { name: true } }, subcategory: { select: { name: true } }, merchant: { select: { name: true } } },
  });
  return rows.map((r, i) => ({
    index: i + 1,
    id: r.id,
    description: r.description,
    amountCents: r.amountCents,
    date: dateToISO(r.date),
    type: r.type,
    createdByMemberId: r.createdByMemberId,
    categoryName: r.subcategory?.name ?? r.category?.name ?? null,
    merchantName: r.merchant?.name ?? null,
    createdAt: r.createdAt,
  }));
}

const toCents = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100));

/** Converte a saída validada do LLM para o formato interno. */
export function mapLlmOutput(out: LlmInterpretation, text: string, hc: HouseholdContext, recent: RecentTx[], meta: { engine: RawInterpretation["engine"]; model: string }): RawInterpretation {
  const drafts: RawDraft[] = out.transactions.map((t) => {
    const date = t.date ?? null;
    return {
      kind: t.kind,
      amountCents: toCents(t.amount),
      amountText: t.amount_text,
      amountIsInstallmentValue: t.amount_is_installment_value,
      description: t.description,
      merchant: t.merchant,
      categoryHint: t.category,
      date,
      dateExplicit: Boolean(date && date !== hc.today) || extractDate(text, hc.today).explicit,
      paymentMethod: t.payment_method,
      accountHint: t.account,
      destinationAccountHint: t.destination_account,
      cardHint: t.card,
      installments: t.installments,
      personHint: t.person,
      responsibleHint: t.responsible,
      ownership: t.ownership,
      goalHint: t.goal,
      confidence: t.confidence,
      segment: t.amount_text ?? text,
    };
  });
  // Parcela informada: total = parcela × quantidade (derivado de valores ditos).
  for (const d of drafts) {
    if (d.amountIsInstallmentValue && d.amountCents && d.installments && d.installments > 1) d.amountCents = d.amountCents * d.installments;
  }
  const byIndex = (i: number | null | undefined) => (i ? recent.find((r) => r.index === i)?.id ?? null : null);
  // Anti-alucinação também na correção: o novo valor precisa constar na mensagem.
  const newAmount = out.correction ? toCents(out.correction.new_amount) : null;
  const correctionAmount = newAmount !== null && amountMentioned(text, newAmount) ? newAmount : null;
  return {
    intent: out.intent,
    drafts,
    correction: out.correction
      ? {
          targetLast: out.correction.target_last,
          targetText: out.correction.target_text,
          targetAmountCents: toCents(out.correction.target_amount),
          targetDate: null,
          targetId: byIndex(out.correction.target_index),
          changes: {
            ...(correctionAmount !== null ? { amountCents: correctionAmount } : {}),
            ...(out.correction.new_category ? { categoryHint: out.correction.new_category } : {}),
            ...(out.correction.new_payment_method ? { paymentMethod: out.correction.new_payment_method } : {}),
            ...(out.correction.new_account ? { accountHint: out.correction.new_account } : {}),
            ...(out.correction.new_card ? { cardHint: out.correction.new_card } : {}),
            ...(out.correction.new_person ? { personHint: out.correction.new_person } : {}),
            ...(out.correction.new_installments ? { installments: out.correction.new_installments } : {}),
            ...(out.correction.new_date ? { date: out.correction.new_date } : {}),
            ...(out.correction.new_description ? { description: out.correction.new_description } : {}),
          },
        }
      : null,
    deletion: out.deletion
      ? {
          targetLast: out.deletion.target_last,
          targetText: out.deletion.target_text,
          targetAmountCents: toCents(out.deletion.target_amount),
          targetId: byIndex(out.deletion.target_index),
          bulk: /\b(todas|todos|tudo)\b/i.test(text),
        }
      : null,
    question: out.question,
    confidence: out.confidence,
    engine: meta.engine,
    model: meta.model,
  };
}

/**
 * Interpreta um texto (mensagem do WhatsApp, transcrição ou lançamento rápido).
 * Não grava nada: apenas produz rascunhos resolvidos e a decisão para cada um.
 */
export async function interpretText(
  ctx: ServiceContext,
  input: string,
  opts: { senderMemberId?: string | null; messageId?: string | null; hc?: HouseholdContext; forceLocal?: boolean } = {},
): Promise<InterpretResult> {
  const text = sanitizeUntrusted(input);
  const hc = opts.hc ?? (await loadHouseholdContext(ctx, opts.senderMemberId));
  const recent = await loadRecentTransactions(ctx);
  const local = parseLocally(text, hc);
  let raw: RawInterpretation = local;
  let fallbackReason: string | null = null;

  if (!opts.forceLocal && text.length > 0) {
    const resolution = await resolveProvider(ctx.householdId, "PARSE_MESSAGE");
    if (resolution.provider) {
      const started = Date.now();
      try {
        const res = await resolution.provider.structured({
          task: "PARSE_MESSAGE",
          system: parseSystemPrompt(hc),
          user: [{ type: "text", text: parseUserPrompt(hc, text, recent) }],
          jsonSchema: llmInterpretationJsonSchema(),
          schemaName: "interpretacao_financeira",
          maxTokens: 4096,
          effort: "low",
        });
        const parsed = llmInterpretationSchema.parse(res.json);
        raw = mapLlmOutput(parsed, text, hc, recent, { engine: resolution.type as RawInterpretation["engine"], model: resolution.model });
        await logAI({
          householdId: ctx.householdId,
          task: "PARSE_MESSAGE",
          provider: resolution.type,
          model: resolution.model,
          status: "SUCCESS",
          latencyMs: Date.now() - started,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          messageId: opts.messageId,
          output: { intent: raw.intent, drafts: raw.drafts.length, confidence: raw.confidence },
        });
      } catch (err) {
        fallbackReason = (err as Error).message;
        logger.warn({ err: fallbackReason, householdId: ctx.householdId }, "ai: falha no provedor, usando motor local");
        await logAI({
          householdId: ctx.householdId,
          task: "PARSE_MESSAGE",
          provider: resolution.type,
          model: resolution.model,
          status: "FALLBACK",
          latencyMs: Date.now() - started,
          messageId: opts.messageId,
          error: fallbackReason,
        });
        raw = local;
      }
    } else if (resolution.reason) {
      fallbackReason = resolution.reason;
    }
  }

  // Salvaguarda: se o motor local encontrou valores e o LLM devolveu menos lançamentos sem valor, prevalece o local.
  if (raw !== local && raw.intent === "CREATE_TRANSACTIONS" && local.intent === "CREATE_TRANSACTIONS" && raw.drafts.every((d) => d.amountCents === null) && local.drafts.some((d) => d.amountCents !== null)) {
    raw = { ...local, engine: raw.engine, model: raw.model };
  }

  const drafts = raw.intent === "CREATE_TRANSACTIONS" ? raw.drafts.map((d, i) => resolveDraft(d, i, hc, text)) : [];
  return { raw, drafts, hc, recent, fallbackReason };
}
