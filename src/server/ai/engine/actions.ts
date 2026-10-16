import type { Prisma, TransactionSource } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { logger, errorInfo } from "../../logger";
import { publishEvent } from "../../events";
import { formatBRL } from "@/lib/money";
import { normalizeText } from "@/lib/utils";
import { isISODate } from "@/lib/dates";
import { createTransaction, updateTransaction, deleteTransaction, restoreTransaction, confirmTransaction } from "../../modules/transactions/service";
import type { TransactionUpdateInput } from "../../modules/transactions/schemas";
import { resolvePaymentStatement } from "../../modules/cards/statements";
import { createPendingItem } from "../../modules/pending/service";
import { contributeToGoal } from "../../modules/goals/service";
import { findMatchingScheduledPayment } from "../../modules/bills/service";
import { checkBudgetAlerts } from "../../modules/budgets/service";
import { extractAmounts } from "../nlu/numbers";
import { normalizeForNlu } from "../nlu/text";
import { answerImportConfirmation } from "./statement-import";
import { findMentions, matchCategory, detectPaymentMethod, parseLocally } from "../nlu/local-parser";
import { CONFIRM_HINT, createdLine, kindVerb, missingQuestion, relativeDate } from "./replies";
import { closeClarification, findOpenClarification, openClarification } from "./clarifications";
import { answerFollowUp, askNextFollowUp, planFollowUps } from "./follow-ups";
import { decide, resolveMember, type ResolvedDraft } from "./resolve";
import type { InterpretResult, RecentTx } from "./interpret";
import type { HouseholdContext } from "./context";
import type { RawCorrection, RawDeletion } from "./schemas";
import { answerQuestion } from "../assistant/service";

export interface ActionOutcome {
  status: "PROCESSED" | "IGNORED" | "NEEDS_CLARIFICATION";
  intent: string;
  replies: string[];
  transactionIds: string[];
  detail?: string;
}

export interface ExecuteOptions {
  channel: "WHATSAPP" | "DASHBOARD";
  chatId: string;
  messageId?: string | null;
  source: TransactionSource;
  attachmentId?: string | null;
  answerQueries: boolean;
  /** Texto original (para reprocessar respostas de esclarecimento). */
  text: string;
  /** O usuário já revisou e confirmou a pré-visualização (lançamento rápido do painel). */
  forceConfirm?: boolean;
}

type DraftPayload = ResolvedDraft[];

// -----------------------------------------------------------------------------
// Criação de lançamentos
// -----------------------------------------------------------------------------

interface CreatedInfo {
  draft: ResolvedDraft;
  transactionId: string | null;
  status: "CONFIRMED" | "PENDING";
  duplicateOf: { id: string; description: string; date: string } | null;
  billLinked: string | null;
  note?: string;
}

async function createFromDraft(ctx: ServiceContext, d: ResolvedDraft, opts: ExecuteOptions, hc: HouseholdContext, forceStatus?: "CONFIRMED" | "PENDING"): Promise<CreatedInfo> {
  const status = forceStatus ?? (d.decision === "AUTO" ? "CONFIRMED" : "PENDING");
  const aiMetadata = { warnings: d.warnings, decision: d.decision, ruleId: d.ruleId } as Prisma.InputJsonValue;

  if (d.kind === "GOAL_CONTRIBUTION") {
    const res = await contributeToGoal(
      ctx,
      d.goalId!,
      { amountCents: d.amountCents!, date: d.date, fromAccountId: d.accountId, note: d.description, sourceMessageId: opts.messageId ?? null },
      { source: opts.source, sourceIndex: d.index },
    );
    return { draft: d, transactionId: res.transaction?.id ?? null, status: "CONFIRMED", duplicateOf: null, billLinked: null, note: res.transaction ? "transferência para a conta da meta" : "alocação interna (sem movimentar contas)" };
  }

  if (d.kind === "CARD_PAYMENT") {
    const card = await prisma.creditCard.findFirstOrThrow({ where: { id: d.creditCardId!, householdId: ctx.householdId } });
    const statement = await resolvePaymentStatement(prisma, ctx.householdId, card, d.date);
    let amount = d.amountCents;
    let derived = false;
    if (!amount) {
      if (statement.remainingCents <= 0) {
        return { draft: d, transactionId: null, status: "CONFIRMED", duplicateOf: null, billLinked: null, note: `Não há saldo em aberto na fatura ${card.name} (${statement.referenceMonth}).` };
      }
      amount = statement.remainingCents;
      derived = true;
    }
    const accountId = d.accountId ?? card.paymentAccountId;
    if (!accountId) {
      return { draft: { ...d, missing: ["conta de pagamento"] }, transactionId: null, status: "PENDING", duplicateOf: null, billLinked: null, note: "Informe a conta usada para pagar a fatura." };
    }
    const res = await createTransaction(
      ctx,
      {
        type: "CARD_PAYMENT",
        amountCents: amount,
        description: d.description,
        date: d.date,
        creditCardId: card.id,
        statementId: statement.id,
        accountId,
        paymentMethod: d.paymentMethod,
        status: derived ? "PENDING" : status,
      },
      { source: opts.source, sourceMessageId: opts.messageId ?? null, sourceIndex: d.index, confidenceScore: d.confidence, aiMetadata, checkDuplicates: false },
    );
    return {
      draft: { ...d, amountCents: amount },
      transactionId: res.transaction.id,
      status: res.transaction.status as "CONFIRMED" | "PENDING",
      duplicateOf: null,
      billLinked: null,
      note: derived ? `valor do saldo em aberto da fatura ${statement.referenceMonth}` : undefined,
    };
  }

  // Despesas e receitas: evita duplicar uma conta prevista que está sendo paga.
  let scheduledPaymentId: string | null = null;
  let billLinked: string | null = null;
  if ((d.kind === "EXPENSE" || d.kind === "INCOME") && d.amountCents) {
    try {
      const match = await findMatchingScheduledPayment(ctx, { type: d.kind, amountCents: d.amountCents, date: d.date, description: d.description, categoryId: d.categoryId, merchantName: d.merchantName });
      if (match && match.score >= 0.7) {
        scheduledPaymentId = match.id;
        billLinked = match.description;
      }
    } catch (err) {
      logger.debug({ err: errorInfo(err) }, "actions: falha ao buscar conta prevista");
    }
  }

  const type = d.kind === "INCOME" ? "INCOME" : d.kind === "TRANSFER" ? "TRANSFER" : "EXPENSE";
  const res = await createTransaction(
    ctx,
    {
      type,
      amountCents: d.amountCents!,
      description: d.description,
      date: d.date,
      categoryId: d.subcategoryId ? null : d.categoryId,
      subcategoryId: d.subcategoryId,
      merchantName: d.merchantName,
      paymentMethod: d.paymentMethod,
      accountId: d.accountId,
      destinationAccountId: d.destinationAccountId,
      creditCardId: d.creditCardId,
      installmentCount: d.installmentCount,
      payerMemberId: d.payerMemberId,
      ownership: d.ownership,
      responsibleMemberId: d.responsibleMemberId,
      status,
    },
    {
      source: opts.source,
      sourceMessageId: opts.messageId ?? null,
      sourceIndex: d.index,
      confidenceScore: d.confidence,
      aiMetadata,
      checkDuplicates: true,
      scheduledPaymentId,
      applyRules: !d.categoryId,
    },
  );
  if (opts.attachmentId && d.index === 0) {
    await prisma.attachment.updateMany({ where: { id: opts.attachmentId, householdId: ctx.householdId, transactionId: null }, data: { transactionId: res.transaction.id } });
  }
  const dup = res.duplicates[0];
  return {
    draft: d,
    transactionId: res.transaction.id,
    status: res.transaction.status as "CONFIRMED" | "PENDING",
    duplicateOf: dup ? { id: dup.id, description: dup.description, date: dup.date } : null,
    billLinked,
  };
}

/** Abre a primeira pergunta de complemento (só no WhatsApp). Nunca interrompe o registro em caso de erro. */
async function askFollowUps(ctx: ServiceContext, hc: HouseholdContext, opts: ExecuteOptions, transactionIds: string[]): Promise<string | null> {
  if (opts.channel !== "WHATSAPP" || !transactionIds.length) return null;
  try {
    const plan = await planFollowUps(ctx.householdId, transactionIds, hc);
    return await askNextFollowUp(ctx, hc, opts, plan);
  } catch (err) {
    logger.warn({ err: errorInfo(err), householdId: ctx.householdId }, "actions: pergunta de complemento falhou");
    return null;
  }
}

function listNames(hc: HouseholdContext) {
  return { cards: hc.cards.map((c) => c.name), accounts: hc.accounts.map((a) => a.name), goals: hc.goals.map((g) => g.name) };
}

async function executeDrafts(ctx: ServiceContext, drafts: ResolvedDraft[], hc: HouseholdContext, opts: ExecuteOptions, forceStatus?: "CONFIRMED" | "PENDING"): Promise<ActionOutcome> {
  const ready = drafts.filter((d) => d.decision !== "CLARIFY");
  const unclear = drafts.filter((d) => d.decision === "CLARIFY");
  const created: CreatedInfo[] = [];
  const replies: string[] = [];
  const failures: string[] = [];

  for (const d of ready) {
    try {
      created.push(await createFromDraft(ctx, d, opts, hc, forceStatus));
    } catch (err) {
      failures.push(`${d.description}: ${(err as Error).message}`);
      logger.warn({ err: errorInfo(err), householdId: ctx.householdId }, "actions: falha ao criar lançamento");
    }
  }

  const confirmed = created.filter((c) => c.transactionId && c.status === "CONFIRMED" || (c.draft.kind === "GOAL_CONTRIBUTION" && c.status === "CONFIRMED"));
  const pending = created.filter((c) => c.transactionId && c.status === "PENDING" && !c.duplicateOf);
  const duplicates = created.filter((c) => c.duplicateOf);
  const notes = created.filter((c) => !c.transactionId && c.note && c.draft.kind !== "GOAL_CONTRIBUTION");

  if (confirmed.length) {
    const lines = confirmed.map((c) => `${createdLine(c.draft, hc.today)}${c.billLinked ? `\nConta prevista “${c.billLinked}” marcada como paga.` : ""}${c.note ? `\n(${c.note})` : ""}`);
    replies.push(`✅ ${confirmed.length > 1 ? `${confirmed.length} lançamentos registrados` : kindVerb(confirmed[0]!.draft.kind)}:\n${lines.join("\n\n")}`);
  }
  if (pending.length) {
    const lines = pending.map((c) => `${createdLine(c.draft, hc.today)}${c.note ? `\n(${c.note})` : ""}${c.draft.warnings.length ? `\n_${c.draft.warnings.join(" ")}_` : ""}`);
    replies.push(`📝 Registrei como *pendente de confirmação*:\n${lines.join("\n\n")}\n${CONFIRM_HINT}`);
    await openClarification({
      householdId: ctx.householdId,
      memberId: hc.sender?.memberId ?? null,
      channel: opts.channel,
      chatId: opts.chatId,
      messageId: opts.messageId,
      kind: "CONFIRM_TRANSACTION",
      question: "Confirmar lançamentos pendentes",
      payload: { transactionIds: pending.map((p) => p.transactionId!) },
    });
  }
  for (const c of duplicates) {
    replies.push(
      `⚠️ *${c.draft.description}* — ${formatBRL(c.draft.amountCents ?? 0)} parece repetir “${c.duplicateOf!.description}” (${relativeDate(c.duplicateOf!.date, hc.today)}). Ficou pendente.\nÉ um *novo* gasto? Responda *sim* para manter ou *não* para descartar.`,
    );
    await openClarification({
      householdId: ctx.householdId,
      memberId: hc.sender?.memberId ?? null,
      channel: opts.channel,
      chatId: opts.chatId,
      messageId: opts.messageId,
      kind: "CONFIRM_DUPLICATE",
      question: "Confirmar possível duplicidade",
      payload: { transactionIds: [c.transactionId!] },
    });
  }
  for (const n of notes) replies.push(`ℹ️ ${n.note}`);
  if (failures.length) replies.push(`Não consegui registrar: ${failures.join("; ")}`);

  if (unclear.length) {
    const first = unclear[0]!;
    const question = missingQuestion(first, listNames(hc));
    replies.push(question);
    await openClarification({
      householdId: ctx.householdId,
      memberId: hc.sender?.memberId ?? null,
      channel: opts.channel,
      chatId: opts.chatId,
      messageId: opts.messageId,
      kind: "MISSING_FIELDS",
      question,
      payload: { drafts: unclear as unknown as Prisma.InputJsonValue, attempts: 1, source: opts.source, attachmentId: opts.attachmentId ?? null } as Prisma.InputJsonValue,
    });
    if (opts.messageId) {
      await createPendingItem(prisma, {
        householdId: ctx.householdId,
        type: "CLARIFICATION",
        title: `Aguardando informação: ${first.description}`,
        description: question.replace(/\*/g, ""),
        messageId: opts.messageId,
        dedupeKey: `clarify:${opts.messageId}`,
        data: { missing: first.missing },
      });
      await publishEvent(ctx.householdId, "pending.changed");
    }
  }

  // Sem outra pergunta em aberto: pergunta o que faltou nos lançamentos registrados (categoria, conta).
  if (!pending.length && !duplicates.length && !unclear.length) {
    const question = await askFollowUps(ctx, hc, opts, confirmed.map((c) => c.transactionId).filter(Boolean) as string[]);
    if (question) replies.push(question);
  }

  const ids = created.map((c) => c.transactionId).filter(Boolean) as string[];
  if (ids.length) {
    checkBudgetAlerts(ctx.householdId).catch((err) => logger.debug({ err: errorInfo(err) }, "actions: alerta de orçamento falhou"));
  }
  return {
    status: unclear.length ? "NEEDS_CLARIFICATION" : "PROCESSED",
    intent: "CREATE_TRANSACTIONS",
    replies,
    transactionIds: ids,
    detail: `${created.length} criado(s), ${unclear.length} aguardando esclarecimento${failures.length ? `, ${failures.length} falha(s)` : ""}`,
  };
}

// -----------------------------------------------------------------------------
// Correções e exclusões
// -----------------------------------------------------------------------------

function candidateText(r: RecentTx): string {
  return normalizeText(`${r.description} ${r.categoryName ?? ""} ${r.merchantName ?? ""}`);
}

function textMatches(r: RecentTx, target: string, hc: HouseholdContext): boolean {
  const t = normalizeForNlu(target);
  if (!t) return true;
  const hay = candidateText(r);
  if (hay.includes(t)) return true;
  // "mercado" → transação classificada como Supermercado (via palavras-chave da subcategoria)
  const m = matchCategory(t, hc, "EXPENSE") ?? matchCategory(t, hc, "INCOME");
  if (m) {
    const label = normalizeText(m.label.split(" > ").pop() ?? "");
    if (hay.includes(label)) return true;
  }
  return false;
}

function findTarget(target: { targetId?: string | null; targetLast: boolean; targetText: string | null; targetAmountCents: number | null; targetDate?: string | null }, recent: RecentTx[], hc: HouseholdContext) {
  if (target.targetId) {
    const t = recent.find((r) => r.id === target.targetId);
    // Referência explícita fora dos lançamentos recentes da família: nunca redirecionar para outro lançamento.
    return t ? { target: t, candidates: [t] } : { target: null, candidates: [] };
  }
  let list = recent.filter((r) => r.type !== "ADJUSTMENT");
  if (target.targetAmountCents) {
    const byAmount = list.filter((r) => r.amountCents === target.targetAmountCents);
    if (byAmount.length) list = byAmount;
  }
  if (target.targetText) list = list.filter((r) => textMatches(r, target.targetText!, hc));
  if (target.targetDate) list = list.filter((r) => r.date === target.targetDate);
  if (!list.length) return { target: null, candidates: [] };
  const mine = list.filter((r) => r.createdByMemberId === hc.sender?.memberId);
  if (target.targetLast || list.length === 1) return { target: (mine[0] ?? list[0])!, candidates: list };
  if (mine.length === 1 && !target.targetText) return { target: mine[0]!, candidates: list };
  // Mais recente quando há uma referência textual clara e o mais novo é bem mais recente.
  return { target: null, candidates: list.slice(0, 4) };
}

function choiceQuestion(candidates: RecentTx[], hc: HouseholdContext, action: string): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.description} — ${formatBRL(c.amountCents)} (${relativeDate(c.date, hc.today)})`);
  return `Encontrei mais de um lançamento. Qual você quer ${action}?\n${lines.join("\n")}\nResponda com o número.`;
}

async function buildCorrectionPatch(ctx: ServiceContext, corr: RawCorrection, txId: string, hc: HouseholdContext): Promise<{ patch: TransactionUpdateInput; missing: string | null; summary: string[] }> {
  const tx = await prisma.transaction.findFirstOrThrow({ where: { id: txId, householdId: ctx.householdId } });
  const patch: TransactionUpdateInput = {};
  const summary: string[] = [];
  const c = corr.changes;
  if (c.amountCents && c.amountCents > 0 && c.amountCents !== tx.amountCents) {
    patch.amountCents = c.amountCents;
    summary.push(`valor ${formatBRL(tx.amountCents)} → ${formatBRL(c.amountCents)}`);
  }
  if (c.categoryHint) {
    const kind = tx.type === "INCOME" ? "INCOME" : "EXPENSE";
    const [catName, subName] = c.categoryHint.split(">").map((s) => s.trim());
    const cat = hc.categories.find((x) => x.kind === kind && x.normalized === normalizeForNlu(catName ?? ""));
    const viaKeyword = matchCategory(normalizeForNlu(c.categoryHint), hc, kind);
    if (cat) {
      const sub = subName ? cat.subcategories.find((s) => s.normalized === normalizeForNlu(subName)) : null;
      patch.categoryId = cat.id;
      patch.subcategoryId = sub?.id ?? null;
      summary.push(`categoria → ${cat.name}${sub ? ` › ${sub.name}` : ""}`);
    } else if (viaKeyword) {
      patch.categoryId = viaKeyword.categoryId;
      patch.subcategoryId = viaKeyword.subcategoryId;
      summary.push(`categoria → ${viaKeyword.label.replace(" > ", " › ")}`);
    }
  }
  if (c.paymentMethod) {
    if (c.paymentMethod === "CREDIT_CARD") {
      const card = c.cardHint ? hc.cards.find((x) => normalizeForNlu(x.name) === normalizeForNlu(c.cardHint!)) : tx.creditCardId ? hc.cards.find((x) => x.id === tx.creditCardId) : hc.cards.length === 1 ? hc.cards[0] : undefined;
      if (!card) return { patch, missing: `Em qual cartão foi? Opções: ${hc.cards.map((x) => x.name).join(", ") || "nenhum cadastrado"}.`, summary };
      patch.paymentMethod = "CREDIT_CARD";
      patch.creditCardId = card.id;
      patch.accountId = null;
      summary.push(`forma de pagamento → crédito (${card.name})`);
    } else {
      patch.paymentMethod = c.paymentMethod;
      patch.creditCardId = null;
      if (tx.creditCardId && !tx.accountId) {
        const card = hc.cards.find((x) => x.id === tx.creditCardId);
        if (card?.paymentAccountId) patch.accountId = card.paymentAccountId;
      }
      if (c.accountHint) {
        const acc = hc.accounts.find((x) => normalizeForNlu(x.name) === normalizeForNlu(c.accountHint!));
        if (acc) patch.accountId = acc.id;
      }
      summary.push(`forma de pagamento → ${c.paymentMethod === "DEBIT_CARD" ? "débito" : c.paymentMethod === "PIX" ? "Pix" : c.paymentMethod === "CASH" ? "dinheiro" : c.paymentMethod.toLowerCase()}`);
    }
  } else if (c.cardHint) {
    const card = hc.cards.find((x) => normalizeForNlu(x.name) === normalizeForNlu(c.cardHint!));
    if (card) {
      patch.creditCardId = card.id;
      patch.paymentMethod = "CREDIT_CARD";
      patch.accountId = null;
      summary.push(`cartão → ${card.name}`);
    }
  } else if (c.accountHint) {
    const acc = hc.accounts.find((x) => normalizeForNlu(x.name) === normalizeForNlu(c.accountHint!));
    if (acc) {
      patch.accountId = acc.id;
      summary.push(`conta → ${acc.name}`);
    }
  }
  if (c.personHint) {
    const m = resolveMember(c.personHint, hc);
    if (m) {
      patch.payerMemberId = m.id;
      if (tx.ownership === "INDIVIDUAL") patch.responsibleMemberId = m.id;
      summary.push(`pessoa → ${m.displayName}`);
    }
  }
  if (c.installments && c.installments >= 1 && c.installments !== tx.installmentCount) {
    if (tx.creditCardId || patch.creditCardId) {
      patch.installmentCount = c.installments;
      summary.push(`parcelas → ${c.installments}x`);
    } else {
      return { patch, missing: "Parcelamento só se aplica a compras no cartão de crédito. Em qual cartão foi?", summary };
    }
  }
  if (c.date && isISODate(c.date)) {
    patch.date = c.date;
    summary.push(`data → ${relativeDate(c.date, hc.today)}`);
  }
  if (c.description) {
    patch.description = c.description.slice(0, 200);
    summary.push(`descrição → ${c.description}`);
  }
  return { patch, missing: null, summary };
}

async function applyCorrection(ctx: ServiceContext, corr: RawCorrection, txId: string, hc: HouseholdContext): Promise<ActionOutcome> {
  const tx = await prisma.transaction.findFirstOrThrow({ where: { id: txId, householdId: ctx.householdId } });
  const { patch, missing, summary } = await buildCorrectionPatch(ctx, corr, txId, hc);
  if (missing) return { status: "NEEDS_CLARIFICATION", intent: "CORRECTION", replies: [missing], transactionIds: [txId] };
  if (!Object.keys(patch).length) {
    return { status: "PROCESSED", intent: "CORRECTION", replies: [`Não identifiquei o que alterar em *${tx.description}*. Ex.: "foram 285", "foi no crédito", "muda para saúde".`], transactionIds: [] };
  }
  await updateTransaction(ctx, txId, patch, { reason: "Correção via mensagem" });
  return { status: "PROCESSED", intent: "CORRECTION", replies: [`✏️ Corrigido: *${tx.description}*\n${summary.join("\n")}`], transactionIds: [txId] };
}

async function handleCorrection(ctx: ServiceContext, result: InterpretResult, opts: ExecuteOptions): Promise<ActionOutcome> {
  const corr = result.raw.correction;
  if (!corr) return { status: "PROCESSED", intent: "CORRECTION", replies: ["Não entendi a correção. Ex.: “O mercado foram 285, não 258”."], transactionIds: [] };
  const { target, candidates } = findTarget(corr, result.recent, result.hc);
  if (target) return applyCorrection(ctx, corr, target.id, result.hc);
  if (!candidates.length) {
    return { status: "PROCESSED", intent: "CORRECTION", replies: ["Não encontrei o lançamento a corrigir nos últimos 30 dias. Você pode editá-lo pelo painel (Transações)."], transactionIds: [] };
  }
  const question = choiceQuestion(candidates, result.hc, "corrigir");
  await openClarification({
    householdId: ctx.householdId,
    memberId: result.hc.sender?.memberId ?? null,
    channel: opts.channel,
    chatId: opts.chatId,
    messageId: opts.messageId,
    kind: "CHOOSE_TRANSACTION",
    question,
    payload: { action: "correct", candidates: candidates.map((c) => c.id), correction: corr as unknown as Prisma.InputJsonValue } as Prisma.InputJsonValue,
  });
  return { status: "NEEDS_CLARIFICATION", intent: "CORRECTION", replies: [question], transactionIds: [] };
}

async function deleteOne(ctx: ServiceContext, txId: string, hc: HouseholdContext): Promise<ActionOutcome> {
  const tx = await prisma.transaction.findFirstOrThrow({ where: { id: txId, householdId: ctx.householdId } });
  await deleteTransaction(ctx, txId, { reason: "Exclusão via mensagem" });
  return {
    status: "PROCESSED",
    intent: "DELETE",
    replies: [`🗑️ Excluí *${tx.description}* — ${formatBRL(tx.amountCents)} (${relativeDate(tx.date.toISOString().slice(0, 10), hc.today)}).\nPara desfazer, responda *desfazer*.`],
    transactionIds: [txId],
  };
}

async function handleDeletion(ctx: ServiceContext, result: InterpretResult, opts: ExecuteOptions): Promise<ActionOutcome> {
  const del: RawDeletion | null = result.raw.deletion;
  if (!del || del.bulk) {
    return {
      status: "PROCESSED",
      intent: "DELETE",
      replies: ["Por segurança, exclusões em massa não são feitas por mensagem. Exclua um lançamento por vez ou use o painel."],
      transactionIds: [],
      detail: "exclusão em massa recusada",
    };
  }
  // Exclusão do "último" restringe-se ao que o próprio remetente registrou.
  const pool = del.targetLast && !del.targetText && !del.targetAmountCents ? result.recent.filter((r) => r.createdByMemberId === result.hc.sender?.memberId) : result.recent;
  const { target, candidates } = findTarget({ ...del, targetDate: null }, pool, result.hc);
  if (target) return deleteOne(ctx, target.id, result.hc);
  if (!candidates.length) return { status: "PROCESSED", intent: "DELETE", replies: ["Não encontrei um lançamento recente para excluir."], transactionIds: [] };
  const question = choiceQuestion(candidates, result.hc, "excluir");
  await openClarification({
    householdId: ctx.householdId,
    memberId: result.hc.sender?.memberId ?? null,
    channel: opts.channel,
    chatId: opts.chatId,
    messageId: opts.messageId,
    kind: "CHOOSE_TRANSACTION",
    question,
    payload: { action: "delete", candidates: candidates.map((c) => c.id) },
  });
  return { status: "NEEDS_CLARIFICATION", intent: "DELETE", replies: [question], transactionIds: [] };
}

async function handleRestore(ctx: ServiceContext, hc: HouseholdContext): Promise<ActionOutcome> {
  const last = await prisma.transaction.findFirst({
    where: { householdId: ctx.householdId, deletedAt: { gte: new Date(Date.now() - 2 * 86_400_000) }, deletedByMemberId: hc.sender?.memberId ?? undefined },
    orderBy: { deletedAt: "desc" },
  });
  if (!last) return { status: "PROCESSED", intent: "RESTORE", replies: ["Não encontrei exclusões recentes para desfazer."], transactionIds: [] };
  await restoreTransaction(ctx, last.id);
  return { status: "PROCESSED", intent: "RESTORE", replies: [`↩️ Restaurado: *${last.description}* — ${formatBRL(last.amountCents)}.`], transactionIds: [last.id] };
}

// -----------------------------------------------------------------------------
// Respostas a esclarecimentos
// -----------------------------------------------------------------------------

const YES = /^(sim|s|isso|isso mesmo|confirmo|confirmado|confirmar|confirma|pode|pode sim|ok|okay|certo|correto|exato|positivo|beleza|blz|uhum|aham|claro|perfeito|e novo|novo|mantem|mantenha|👍)\b/;
const NO = /^(nao|n|negativo|errado|errada|cancela|cancelar|descarta|descartar|apaga|nada disso)\b/;

/**
 * Se houver uma pergunta aberta para este remetente/conversa, tenta tratar a mensagem como resposta.
 * Retorna null quando a mensagem não é uma resposta (segue o fluxo normal).
 */
export async function tryAnswerClarification(ctx: ServiceContext, hc: HouseholdContext, opts: ExecuteOptions): Promise<ActionOutcome | null> {
  const open = await findOpenClarification(ctx.householdId, opts.chatId, hc.sender?.memberId ?? null);
  if (!open) return null;
  const norm = normalizeForNlu(opts.text);
  const payload = open.payload as Record<string, unknown>;

  if (open.kind === "CONFIRM_TRANSACTION" || open.kind === "CONFIRM_DUPLICATE") {
    const ids = (payload.transactionIds as string[] | undefined) ?? [];
    if (YES.test(norm)) {
      for (const id of ids) await confirmTransaction(ctx, id).catch(() => undefined);
      await closeClarification(open.id);
      const replies = [`👍 Confirmado${ids.length > 1 ? ` (${ids.length} lançamentos)` : ""}.`];
      const question = await askFollowUps(ctx, hc, opts, ids);
      if (question) replies.push(question);
      return { status: question ? "NEEDS_CLARIFICATION" : "PROCESSED", intent: "CONFIRMATION", replies, transactionIds: ids };
    }
    if (NO.test(norm)) {
      for (const id of ids) await deleteTransaction(ctx, id, { action: "REJECT", reason: "Rejeitado pelo usuário" }).catch(() => undefined);
      await closeClarification(open.id);
      return { status: "PROCESSED", intent: "REJECTION", replies: ["Ok, descartado."], transactionIds: ids };
    }
    return null;
  }

  if (open.kind === "CONFIRM_IMPORT") {
    return answerImportConfirmation(ctx, opts.chatId, opts.text, open);
  }

  if (open.kind === "COMPLETE_TRANSACTION") {
    return answerFollowUp(ctx, hc, { channel: opts.channel, chatId: opts.chatId, messageId: open.messageId ?? opts.messageId, text: opts.text }, open);
  }

  if (open.kind === "CHOOSE_TRANSACTION") {
    const candidates = (payload.candidates as string[] | undefined) ?? [];
    const m = /^(\d{1,2})\b|\b(primeir[oa]|segund[oa]|terceir[oa]|quart[oa])\b/.exec(norm);
    if (!m) {
      if (NO.test(norm)) {
        await closeClarification(open.id, "CANCELLED");
        return { status: "PROCESSED", intent: "REJECTION", replies: ["Ok, nada foi alterado."], transactionIds: [] };
      }
      return null;
    }
    const ord = m[1] ? Number(m[1]) : ["primeir", "segund", "terceir", "quart"].findIndex((p) => m[2]!.startsWith(p)) + 1;
    const id = candidates[ord - 1];
    if (!id) return { status: "NEEDS_CLARIFICATION", intent: "CLARIFICATION", replies: [`Escolha um número entre 1 e ${candidates.length}.`], transactionIds: [] };
    await closeClarification(open.id);
    if (payload.action === "delete") return deleteOne(ctx, id, hc);
    return applyCorrection(ctx, payload.correction as unknown as RawCorrection, id, hc);
  }

  if (open.kind === "MISSING_FIELDS") {
    const drafts = (payload.drafts as unknown as DraftPayload) ?? [];
    const first = drafts[0];
    if (!first) {
      await closeClarification(open.id, "CANCELLED");
      return null;
    }
    if (NO.test(norm) && norm.split(" ").length <= 3) {
      await closeClarification(open.id, "CANCELLED");
      return { status: "PROCESSED", intent: "REJECTION", replies: ["Ok, lançamento descartado."], transactionIds: [] };
    }
    let filled = false;
    const d: ResolvedDraft = { ...first, missing: [...first.missing], warnings: [...first.warnings] };
    if (d.missing.includes("valor")) {
      const amounts = extractAmounts(opts.text);
      if (amounts.length === 1) {
        d.amountCents = amounts[0]!.cents;
        d.missing = d.missing.filter((x) => x !== "valor");
        filled = true;
      }
    }
    if (d.missing.includes("cartão")) {
      const cards = findMentions(norm, hc.cards);
      if (cards[0]) {
        const card = hc.cards.find((c) => c.id === cards[0]!.id)!;
        d.creditCardId = card.id;
        d.paymentMethod = "CREDIT_CARD";
        d.labels = { ...d.labels, card: card.name };
        d.missing = d.missing.filter((x) => x !== "cartão");
        filled = true;
      } else if (detectPaymentMethod(norm) && detectPaymentMethod(norm) !== "CREDIT_CARD") {
        d.paymentMethod = detectPaymentMethod(norm);
        d.installmentCount = 1;
        d.missing = d.missing.filter((x) => x !== "cartão");
        filled = true;
      }
    }
    if (d.missing.some((x) => x.startsWith("conta"))) {
      const accs = findMentions(norm, hc.accounts);
      if (accs.length >= 2) {
        d.accountId = accs[0]!.id;
        d.destinationAccountId = accs[1]!.id;
        d.labels = { ...d.labels, account: hc.accounts.find((a) => a.id === accs[0]!.id)!.name, destinationAccount: hc.accounts.find((a) => a.id === accs[1]!.id)!.name };
        d.missing = d.missing.filter((x) => !x.startsWith("conta"));
        filled = true;
      }
    }
    if (d.missing.some((x) => x.startsWith("meta"))) {
      const goals = findMentions(norm, hc.goals);
      if (goals[0]) {
        d.goalId = goals[0].id;
        d.labels = { ...d.labels, goal: hc.goals.find((g) => g.id === goals[0]!.id)!.name };
        d.missing = d.missing.filter((x) => !x.startsWith("meta"));
        filled = true;
      }
    }
    if (!filled) {
      // Parece uma nova mensagem financeira: encerra a pergunta e segue o fluxo normal.
      const asNew = parseLocally(opts.text, hc);
      if (asNew.intent !== "SMALL_TALK" && asNew.intent !== "UNKNOWN") {
        await closeClarification(open.id, "CANCELLED");
        return null;
      }
      const attempts = Number(payload.attempts ?? 1);
      if (attempts >= 2) {
        await closeClarification(open.id, "CANCELLED");
        return { status: "PROCESSED", intent: "CLARIFICATION", replies: ["Não consegui completar o lançamento. Ele ficou em Pendências no painel para revisão."], transactionIds: [] };
      }
      await prisma.clarification.update({ where: { id: open.id }, data: { payload: { ...payload, attempts: attempts + 1 } as Prisma.InputJsonValue } });
      return { status: "NEEDS_CLARIFICATION", intent: "CLARIFICATION", replies: [open.question], transactionIds: [] };
    }
    d.decision = decide(Math.max(d.confidence, 0.86), d.missing, hc, d.amountCents);
    await closeClarification(open.id);
    if (open.messageId) {
      await prisma.pendingItem.updateMany({ where: { householdId: ctx.householdId, dedupeKey: `clarify:${open.messageId}`, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: new Date(), resolution: "Informação recebida" } });
    }
    const rest = drafts.slice(1);
    return executeDrafts(ctx, [d, ...rest], hc, {
      ...opts,
      messageId: open.messageId ?? opts.messageId,
      source: (payload.source as TransactionSource) ?? opts.source,
      attachmentId: (payload.attachmentId as string | null) ?? opts.attachmentId,
    });
  }
  return null;
}

// -----------------------------------------------------------------------------
// Entrada principal
// -----------------------------------------------------------------------------

export async function executeInterpretation(ctx: ServiceContext, result: InterpretResult, opts: ExecuteOptions): Promise<ActionOutcome> {
  switch (result.raw.intent) {
    case "CREATE_TRANSACTIONS":
      if (!result.drafts.length) return { status: "IGNORED", intent: "CREATE_TRANSACTIONS", replies: [], transactionIds: [], detail: "nenhum lançamento identificado" };
      return executeDrafts(ctx, result.drafts, result.hc, opts, opts.forceConfirm ? "CONFIRMED" : undefined);
    case "CORRECTION":
      return handleCorrection(ctx, result, opts);
    case "DELETE":
      return handleDeletion(ctx, result, opts);
    case "RESTORE":
      return handleRestore(ctx, result.hc);
    case "QUERY": {
      if (!opts.answerQueries) return { status: "IGNORED", intent: "QUERY", replies: [], transactionIds: [], detail: "consultas desativadas no grupo" };
      const answer = await answerQuestion(ctx, result.raw.question ?? opts.text, { channel: opts.channel });
      return { status: "PROCESSED", intent: "QUERY", replies: [answer.text], transactionIds: [] };
    }
    case "CONFIRMATION":
    case "REJECTION":
      return { status: "IGNORED", intent: result.raw.intent, replies: [], transactionIds: [], detail: "sem pergunta pendente" };
    default:
      return { status: "IGNORED", intent: result.raw.intent, replies: [], transactionIds: [], detail: "sem relevância financeira" };
  }
}
