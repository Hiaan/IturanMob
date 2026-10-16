import { Prisma, type Transaction, type TransactionSource } from "@prisma/client";
import { parsePatch } from "../../validation";
import { prisma, withTransaction, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { dateToISO, isoToDate, todayISO } from "@/lib/dates";
import { splitByWeights } from "@/lib/money";
import { audit } from "../audit/service";
import { findOrCreateMerchant } from "../merchants/service";
import { createPendingItem, resolvePendingWhere } from "../pending/service";
import { getSettings } from "../households/service";
import { getVisibilityScope, visibleTransactionWhere } from "../visibility/scope";
import { findMatchingRule } from "../rules/matcher";
import { buildInstallmentPlan } from "../cards/billing";
import { ensureStatement, resolvePaymentStatement } from "../cards/statements";
import { buildLedgerPostings, isPostable } from "./postings";
import { DUPLICATE_SUSPICION_SCORE, findPossibleDuplicates, transactionFingerprint, type DuplicateCandidate } from "./duplicates";
import {
  transactionCreateSchema,
  transactionListSchema,
  transactionUpdateSchema,
  type TransactionCreateInput,
  type TransactionFields,
  type TransactionListFilters,
  type TransactionUpdateInput,
} from "./schemas";
import { serializeTransaction, transactionInclude, type TransactionDTO } from "./serialize";

export interface CreateTransactionOptions {
  source?: TransactionSource;
  sourceMessageId?: string | null;
  sourceIndex?: number;
  confidenceScore?: number | null;
  aiMetadata?: Prisma.InputJsonValue | null;
  importBatchId?: string | null;
  recurringTransactionId?: string | null;
  /** Conta prevista (contas a pagar) quitada por esta transação. */
  scheduledPaymentId?: string | null;
  /** Verifica suspeita de duplicidade (padrão: ligado para origens automáticas). */
  checkDuplicates?: boolean;
  /** Aplica regras de categorização do usuário quando a categoria não foi informada. */
  applyRules?: boolean;
  /** Executa dentro de uma transação de banco já aberta. */
  db?: Prisma.TransactionClient;
}

export interface CreateTransactionResult {
  transaction: TransactionDTO;
  created: boolean;
  duplicates: DuplicateCandidate[];
  pendingTypes: string[];
}

type Normalized = TransactionFields & {
  competenceDate: string;
  merchantId: string | null;
  allocations: Array<{ memberId: string; amountCents: number }>;
  /** Moeda de amountCents (a da conta de origem; cartão = BRL). */
  currency: string;
  /** Receita/despesa/ajuste em moeda estrangeira: valor em reais pela PTAX da data. */
  amountBrlCents: number | null;
};

// -----------------------------------------------------------------------------
// Validação e normalização (regras de negócio por tipo)
// -----------------------------------------------------------------------------

async function normalize(db: Db, ctx: ServiceContext, input: TransactionFields): Promise<Normalized> {
  const hh = ctx.householdId;
  const data: Normalized = {
    ...input,
    notes: input.notes ?? null,
    competenceDate: input.competenceDate ?? input.date,
    categoryId: input.categoryId ?? null,
    subcategoryId: input.subcategoryId ?? null,
    paymentMethod: input.paymentMethod ?? null,
    accountId: input.accountId ?? null,
    destinationAccountId: input.destinationAccountId ?? null,
    creditCardId: input.creditCardId ?? null,
    statementId: input.statementId ?? null,
    payerMemberId: input.payerMemberId ?? ctx.memberId ?? null,
    responsibleMemberId: input.responsibleMemberId ?? null,
    goalId: input.goalId ?? null,
    merchantId: null,
    allocations: input.allocations ?? [],
    destinationAmountCents: input.destinationAmountCents ?? null,
    currency: "BRL",
    amountBrlCents: null,
  };

  const scope = await getVisibilityScope(ctx, db);
  const accountIds = [data.accountId, data.destinationAccountId].filter(Boolean) as string[];
  const currencyOf = new Map<string, string>();
  if (accountIds.length) {
    const accounts = await db.account.findMany({ where: { id: { in: accountIds }, householdId: hh }, select: { id: true, archivedAt: true, currency: true } });
    if (accounts.length !== new Set(accountIds).size) throw new ValidationError("Conta inválida.", { field: "accountId" });
    if (accountIds.some((id) => scope.hiddenAccountIds.includes(id))) throw new ValidationError("Conta inválida.", { field: "accountId" });
    for (const a of accounts) currencyOf.set(a.id, a.currency);
  }

  let card: { id: string; closingDay: number; dueDay: number; paymentAccountId: string | null } | null = null;
  if (data.creditCardId) {
    card = await db.creditCard.findFirst({
      where: { id: data.creditCardId, householdId: hh },
      select: { id: true, closingDay: true, dueDay: true, paymentAccountId: true },
    });
    if (!card || scope.hiddenCardIds.includes(card.id)) throw new ValidationError("Cartão inválido.", { field: "creditCardId" });
  }

  switch (data.type) {
    case "EXPENSE": {
      data.destinationAccountId = null;
      data.statementId = null;
      if (card) {
        data.paymentMethod = "CREDIT_CARD";
        data.accountId = null;
      } else if (data.paymentMethod === "CREDIT_CARD") {
        data.accountId = null;
      }
      if (data.installmentCount > 1 && data.paymentMethod && data.paymentMethod !== "CREDIT_CARD" && data.paymentMethod !== "BANK_SLIP") {
        throw new ValidationError("Parcelamento só é permitido no cartão de crédito ou boleto.", { field: "installmentCount" });
      }
      break;
    }
    case "INCOME": {
      data.creditCardId = null;
      data.destinationAccountId = null;
      data.statementId = null;
      data.installmentCount = 1;
      if (data.paymentMethod === "CREDIT_CARD") data.paymentMethod = null;
      break;
    }
    case "TRANSFER": {
      if (!data.accountId || !data.destinationAccountId) throw new ValidationError("Transferência exige conta de origem e de destino.", { field: "accountId" });
      if (data.accountId === data.destinationAccountId) throw new ValidationError("As contas de origem e destino devem ser diferentes.", { field: "destinationAccountId" });
      data.creditCardId = null;
      data.statementId = null;
      data.categoryId = null;
      data.subcategoryId = null;
      data.installmentCount = 1;
      data.paymentMethod = data.paymentMethod && data.paymentMethod !== "CREDIT_CARD" ? data.paymentMethod : "BANK_TRANSFER";
      data.allocations = [];
      data.ownership = "SHARED";
      data.responsibleMemberId = null;
      break;
    }
    case "CARD_PAYMENT": {
      if (!card) throw new ValidationError("Informe o cartão cuja fatura foi paga.", { field: "creditCardId" });
      data.accountId = data.accountId ?? card.paymentAccountId;
      if (!data.accountId) throw new ValidationError("Informe a conta usada para pagar a fatura.", { field: "accountId" });
      if (data.statementId) {
        const st = await db.creditCardStatement.findFirst({ where: { id: data.statementId, householdId: hh, creditCardId: card.id } });
        if (!st) throw new ValidationError("Fatura inválida.", { field: "statementId" });
      } else {
        data.statementId = (await resolvePaymentStatement(db, hh, card, data.date)).id;
      }
      data.destinationAccountId = null;
      data.categoryId = null;
      data.subcategoryId = null;
      data.installmentCount = 1;
      data.paymentMethod = data.paymentMethod && data.paymentMethod !== "CREDIT_CARD" ? data.paymentMethod : "BANK_TRANSFER";
      data.allocations = [];
      data.ownership = "SHARED";
      data.responsibleMemberId = null;
      break;
    }
    case "ADJUSTMENT": {
      if (Boolean(data.accountId) === Boolean(data.destinationAccountId)) {
        throw new ValidationError("Ajuste de saldo exige apenas uma conta (saída ou entrada).", { field: "accountId" });
      }
      data.creditCardId = null;
      data.statementId = null;
      data.categoryId = null;
      data.subcategoryId = null;
      data.installmentCount = 1;
      data.allocations = [];
      data.ownership = "SHARED";
      data.responsibleMemberId = null;
      break;
    }
  }

  // Moeda: a da conta (origem). Cartão de crédito é em reais.
  const srcCurrency = data.accountId ? currencyOf.get(data.accountId) ?? "BRL" : null;
  const dstCurrency = data.destinationAccountId ? currencyOf.get(data.destinationAccountId) ?? "BRL" : null;
  data.currency = data.type === "ADJUSTMENT" && !data.accountId ? dstCurrency ?? "BRL" : data.creditCardId && data.type === "EXPENSE" ? "BRL" : srcCurrency ?? "BRL";
  if (data.type === "TRANSFER" && srcCurrency && dstCurrency && srcCurrency !== dstCurrency) {
    if (!data.destinationAmountCents) {
      throw new ValidationError(`As contas têm moedas diferentes (${srcCurrency} → ${dstCurrency}): informe o valor creditado no destino.`, { field: "destinationAmountCents" });
    }
  } else {
    data.destinationAmountCents = null;
  }
  if (data.type === "CARD_PAYMENT" && data.currency !== "BRL") throw new ValidationError("A fatura do cartão é paga em reais: escolha uma conta em reais.", { field: "accountId" });
  if (data.currency !== "BRL" && (data.type === "INCOME" || data.type === "EXPENSE" || data.type === "ADJUSTMENT")) {
    const { toBrlCents } = await import("../fx/service");
    data.amountBrlCents = await toBrlCents(data.amountCents, data.currency, data.date, db);
  }

  // Categoria e subcategoria
  if (data.subcategoryId) {
    const sub = await db.subcategory.findFirst({ where: { id: data.subcategoryId, householdId: hh }, select: { id: true, categoryId: true } });
    if (!sub) throw new ValidationError("Subcategoria inválida.", { field: "subcategoryId" });
    if (data.categoryId && data.categoryId !== sub.categoryId) throw new ValidationError("A subcategoria não pertence à categoria informada.", { field: "subcategoryId" });
    data.categoryId = sub.categoryId;
  }
  if (data.categoryId) {
    const cat = await db.category.findFirst({ where: { id: data.categoryId, householdId: hh }, select: { kind: true } });
    if (!cat) throw new ValidationError("Categoria inválida.", { field: "categoryId" });
    const expected = data.type === "INCOME" ? "INCOME" : "EXPENSE";
    if ((data.type === "EXPENSE" || data.type === "INCOME") && cat.kind !== expected) {
      throw new ValidationError(data.type === "INCOME" ? "Use uma categoria de receita." : "Use uma categoria de despesa.", { field: "categoryId" });
    }
  }

  // Membros (pagador, responsável e rateio)
  const memberIds = [data.payerMemberId, data.responsibleMemberId, ...data.allocations.map((a) => a.memberId)].filter(Boolean) as string[];
  if (memberIds.length) {
    const found = await db.householdMember.count({ where: { id: { in: [...new Set(memberIds)] }, householdId: hh } });
    if (found !== new Set(memberIds).size) throw new ValidationError("Membro inválido.", { field: "responsibleMemberId" });
  }
  if (data.allocations.length) {
    const ids = data.allocations.map((a) => a.memberId);
    if (new Set(ids).size !== ids.length) throw new ValidationError("Cada pessoa pode aparecer apenas uma vez no rateio.", { field: "allocations" });
    const sum = data.allocations.reduce((s, a) => s + a.amountCents, 0);
    if (sum !== data.amountCents) throw new ValidationError("A soma do rateio deve ser igual ao valor total.", { field: "allocations" });
    if (data.allocations.length === 1) {
      data.ownership = "INDIVIDUAL";
      data.responsibleMemberId = data.allocations[0]!.memberId;
      data.allocations = [];
    } else {
      data.ownership = "SHARED";
      data.responsibleMemberId = null;
    }
  }
  if (data.ownership === "INDIVIDUAL") {
    data.responsibleMemberId = data.responsibleMemberId ?? data.payerMemberId ?? ctx.memberId;
    if (!data.responsibleMemberId) throw new ValidationError("Informe o responsável pela despesa individual.", { field: "responsibleMemberId" });
  } else if (!data.allocations.length) {
    data.responsibleMemberId = null;
  }

  if (data.goalId) {
    const goal = await db.financialGoal.findFirst({ where: { id: data.goalId, householdId: hh }, select: { id: true } });
    if (!goal) throw new ValidationError("Meta inválida.", { field: "goalId" });
  }

  data.merchantId = await findOrCreateMerchant(db, hh, input.merchantName);
  return data;
}

async function applyRules(db: Db, ctx: ServiceContext, data: Normalized, merchantName: string | null | undefined): Promise<string | null> {
  if (data.categoryId || (data.type !== "EXPENSE" && data.type !== "INCOME")) return null;
  // Regras de transferência (aplicação/resgate) não mexem em categoria.
  const rules = await db.financialRule.findMany({ where: { householdId: ctx.householdId, active: true, setTransferAccountId: null } });
  if (!rules.length) return null;
  const rule = findMatchingRule(rules, { description: data.description, merchant: merchantName ?? null, amountCents: data.amountCents, type: data.type });
  if (!rule) return null;
  if (rule.setCategoryId) {
    const cat = await db.category.findFirst({ where: { id: rule.setCategoryId, householdId: ctx.householdId } });
    const expected = data.type === "INCOME" ? "INCOME" : "EXPENSE";
    if (cat && cat.kind === expected) {
      data.categoryId = rule.setCategoryId;
      data.subcategoryId = rule.setSubcategoryId ?? null;
    }
  }
  if (rule.setPaymentMethod && !data.paymentMethod) data.paymentMethod = rule.setPaymentMethod;
  if (rule.setAccountId && !data.accountId && !data.creditCardId && data.paymentMethod !== "CREDIT_CARD") data.accountId = rule.setAccountId;
  if (rule.setOwnership && rule.setOwnership === "INDIVIDUAL" && rule.setResponsibleMemberId && !data.allocations.length) {
    data.ownership = "INDIVIDUAL";
    data.responsibleMemberId = rule.setResponsibleMemberId;
  }
  await db.financialRule.update({ where: { id: rule.id }, data: { timesApplied: { increment: 1 } } });
  return rule.id;
}

// -----------------------------------------------------------------------------
// Ledger e parcelas (repostagem idempotente)
// -----------------------------------------------------------------------------

/**
 * Recalcula os movimentos de caixa e as parcelas de uma transação a partir do seu estado atual.
 * Idempotente: pode ser executado quantas vezes for necessário (ex.: recálculo de saldos).
 */
export async function repostTransaction(db: Db, transactionId: string): Promise<void> {
  const tx = await db.transaction.findUnique({
    where: { id: transactionId },
    include: { creditCard: { select: { id: true, closingDay: true, dueDay: true } } },
  });
  if (!tx) return;
  await db.ledgerEntry.deleteMany({ where: { transactionId } });
  await db.installment.deleteMany({ where: { transactionId } });
  if (!isPostable(tx)) return;

  const postings = buildLedgerPostings(tx);
  if (postings.length) {
    await db.ledgerEntry.createMany({
      data: postings.map((p) => ({ householdId: tx.householdId, transactionId: tx.id, accountId: p.accountId, kind: p.kind, amountCents: p.amountCents, date: p.date })),
    });
  }

  if (tx.type === "EXPENSE" && tx.creditCard) {
    const plan = buildInstallmentPlan(tx.amountCents, tx.installmentCount, dateToISO(tx.date), tx.creditCard);
    for (const item of plan) {
      const statement = await ensureStatement(db, tx.householdId, tx.creditCard.id, item);
      await db.installment.create({
        data: {
          householdId: tx.householdId,
          transactionId: tx.id,
          statementId: statement.id,
          number: item.number,
          totalInstallments: item.totalInstallments,
          amountCents: item.amountCents,
          dueDate: isoToDate(item.dueDate),
        },
      });
    }
  }
}

/** Atualiza as pendências automáticas (sem categoria / sem forma de pagamento) de uma transação. */
async function syncAutomaticPending(db: Db, ctx: ServiceContext, tx: Transaction): Promise<string[]> {
  const created: string[] = [];
  const active = !tx.deletedAt;
  const needsCategory = active && (tx.type === "EXPENSE" || tx.type === "INCOME") && !tx.categoryId;
  const needsPayment = active && tx.type === "EXPENSE" && !tx.accountId && !tx.creditCardId;

  if (needsCategory) {
    await createPendingItem(db, {
      householdId: tx.householdId,
      type: "UNCATEGORIZED",
      title: `Sem categoria: ${tx.description}`,
      transactionId: tx.id,
      dedupeKey: `uncat:${tx.id}`,
    });
    created.push("UNCATEGORIZED");
  } else {
    await resolvePendingWhere(db, { householdId: tx.householdId, transactionId: tx.id, type: "UNCATEGORIZED" }, "Categoria definida", ctx.memberId);
  }

  if (needsPayment) {
    await createPendingItem(db, {
      householdId: tx.householdId,
      type: "MISSING_PAYMENT_METHOD",
      title: tx.paymentMethod === "CREDIT_CARD" ? `Informe o cartão: ${tx.description}` : `Sem conta ou forma de pagamento: ${tx.description}`,
      description:
        tx.paymentMethod === "CREDIT_CARD"
          ? "A compra foi no crédito, mas o cartão não foi identificado. Sem o cartão, as parcelas não entram nas faturas."
          : "Sem conta ou cartão vinculado, a despesa não altera nenhum saldo.",
      transactionId: tx.id,
      dedupeKey: `nopay:${tx.id}`,
    });
    created.push("MISSING_PAYMENT_METHOD");
  } else {
    await resolvePendingWhere(db, { householdId: tx.householdId, transactionId: tx.id, type: "MISSING_PAYMENT_METHOD" }, "Forma de pagamento definida", ctx.memberId);
  }
  return created;
}

function snapshot(tx: Transaction & { allocations?: Array<{ memberId: string; amountCents: number }> }) {
  return {
    type: tx.type,
    status: tx.status,
    amountCents: tx.amountCents,
    description: tx.description,
    notes: tx.notes,
    date: dateToISO(tx.date),
    competenceDate: dateToISO(tx.competenceDate),
    categoryId: tx.categoryId,
    subcategoryId: tx.subcategoryId,
    merchantId: tx.merchantId,
    paymentMethod: tx.paymentMethod,
    accountId: tx.accountId,
    destinationAccountId: tx.destinationAccountId,
    creditCardId: tx.creditCardId,
    statementId: tx.statementId,
    installmentCount: tx.installmentCount,
    payerMemberId: tx.payerMemberId,
    ownership: tx.ownership,
    responsibleMemberId: tx.responsibleMemberId,
    allocations: tx.allocations?.map((a) => ({ memberId: a.memberId, amountCents: a.amountCents })) ?? undefined,
    deletedAt: tx.deletedAt?.toISOString() ?? null,
    goalId: tx.goalId,
  };
}

async function loadDTO(db: Db, id: string): Promise<TransactionDTO> {
  const tx = await db.transaction.findUniqueOrThrow({ where: { id }, include: transactionInclude });
  return serializeTransaction(tx);
}

async function runInTx<T>(external: Prisma.TransactionClient | undefined, fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return external ? fn(external) : withTransaction(fn);
}

// -----------------------------------------------------------------------------
// Operações
// -----------------------------------------------------------------------------

export async function createTransaction(
  ctx: ServiceContext,
  rawInput: TransactionCreateInput,
  opts: CreateTransactionOptions = {},
): Promise<CreateTransactionResult> {
  assertCan(ctx, "transactions:write");
  const input = transactionCreateSchema.parse(rawInput);
  const source = opts.source ?? "MANUAL";
  const checkDuplicates = opts.checkDuplicates ?? !["MANUAL", "IMPORT", "RECURRING"].includes(source);

  const result = await runInTx(opts.db, async (db) => {
    // Idempotência: a mesma mensagem (e posição) nunca gera duas transações.
    if (opts.sourceMessageId) {
      const existing = await db.transaction.findUnique({
        where: { sourceMessageId_sourceIndex: { sourceMessageId: opts.sourceMessageId, sourceIndex: opts.sourceIndex ?? 0 } },
      });
      if (existing) return { id: existing.id, created: false, duplicates: [] as DuplicateCandidate[], pendingTypes: [] as string[] };
    }

    const data = await normalize(db, ctx, input);
    const ruleId = opts.applyRules === false ? null : await applyRules(db, ctx, data, input.merchantName);
    const settings = await getSettings(ctx.householdId, db);

    let duplicates: DuplicateCandidate[] = [];
    let status = data.status;
    if (checkDuplicates && (data.type === "EXPENSE" || data.type === "INCOME")) {
      duplicates = (
        await findPossibleDuplicates(
          db,
          {
            householdId: ctx.householdId,
            type: data.type,
            amountCents: data.amountCents,
            date: data.date,
            description: data.description,
            merchantName: input.merchantName,
            sourceMessageId: opts.sourceMessageId,
          },
          settings.duplicateWindowHours,
        )
      ).filter((d) => d.score >= DUPLICATE_SUSPICION_SCORE);
      if (duplicates.length) status = "PENDING";
    }

    const tx = await db.transaction.create({
      data: {
        householdId: ctx.householdId,
        type: data.type,
        status,
        amountCents: data.amountCents,
        description: data.description,
        notes: data.notes,
        merchantId: data.merchantId,
        categoryId: data.categoryId,
        subcategoryId: data.subcategoryId,
        date: isoToDate(data.date),
        competenceDate: isoToDate(data.competenceDate),
        paymentMethod: data.paymentMethod,
        accountId: data.accountId,
        destinationAccountId: data.destinationAccountId,
        destinationAmountCents: data.destinationAmountCents,
        currency: data.currency,
        amountBrlCents: data.amountBrlCents,
        creditCardId: data.creditCardId,
        statementId: data.statementId,
        installmentCount: data.installmentCount,
        payerMemberId: data.payerMemberId,
        ownership: data.ownership,
        responsibleMemberId: data.responsibleMemberId,
        source,
        sourceMessageId: opts.sourceMessageId ?? null,
        sourceIndex: opts.sourceIndex ?? 0,
        importBatchId: opts.importBatchId ?? null,
        recurringTransactionId: opts.recurringTransactionId ?? null,
        goalId: data.goalId,
        confidenceScore: opts.confidenceScore ?? null,
        aiMetadata: opts.aiMetadata ?? (ruleId ? { ruleId } : undefined),
        fingerprint: transactionFingerprint({ ...data, merchantName: input.merchantName }),
        createdByMemberId: ctx.memberId,
        allocations: data.allocations.length ? { create: data.allocations } : undefined,
      },
      include: { allocations: true },
    });

    await repostTransaction(db, tx.id);
    const pendingTypes = await syncAutomaticPending(db, ctx, tx);

    if (duplicates.length) {
      const top = duplicates[0]!;
      await createPendingItem(db, {
        householdId: ctx.householdId,
        type: "POSSIBLE_DUPLICATE",
        title: `Possível duplicidade: ${tx.description}`,
        description: `Já existe um lançamento parecido (${top.reasons.join(", ")}). Confirme se é um novo gasto.`,
        transactionId: tx.id,
        relatedTransactionId: top.id,
        messageId: opts.sourceMessageId ?? null,
        dedupeKey: `dup:${tx.id}`,
        data: { candidates: duplicates.slice(0, 3).map((d) => ({ id: d.id, score: d.score, reasons: d.reasons })) },
      });
      pendingTypes.push("POSSIBLE_DUPLICATE");
    } else if (status === "PENDING") {
      await createPendingItem(db, {
        householdId: ctx.householdId,
        type: "CONFIRMATION",
        title: `Confirmar lançamento: ${tx.description}`,
        transactionId: tx.id,
        messageId: opts.sourceMessageId ?? null,
        dedupeKey: `confirm:${tx.id}`,
        data: opts.confidenceScore != null ? { confidenceScore: opts.confidenceScore } : undefined,
      });
      pendingTypes.push("CONFIRMATION");
    }

    if (opts.scheduledPaymentId) {
      await linkScheduledPayment(db, ctx, opts.scheduledPaymentId, tx);
    }

    await audit(
      ctx,
      { action: "CREATE", entityType: "Transaction", entityId: tx.id, after: snapshot(tx), source, metadata: opts.sourceMessageId ? { sourceMessageId: opts.sourceMessageId } : null },
      db,
    );
    return { id: tx.id, created: true, duplicates, pendingTypes };
  });

  const transaction = await loadDTO(opts.db ?? prisma, result.id);
  if (result.created && !opts.db) {
    await publishEvent(ctx.householdId, "transaction.changed", result.id);
    if (result.pendingTypes.length) await publishEvent(ctx.householdId, "pending.changed");
  }
  return { transaction, created: result.created, duplicates: result.duplicates, pendingTypes: result.pendingTypes };
}

/** Vincula uma conta prevista à transação que a quitou (evita duplicidade com a recorrência). */
async function linkScheduledPayment(db: Db, ctx: ServiceContext, scheduledPaymentId: string, tx: Transaction) {
  const sp = await db.scheduledPayment.findFirst({ where: { id: scheduledPaymentId, householdId: ctx.householdId } });
  if (!sp) throw new ValidationError("Conta prevista inválida.");
  if (sp.transactionId && sp.transactionId !== tx.id) {
    const linked = await db.transaction.findUnique({ where: { id: sp.transactionId }, select: { deletedAt: true } });
    if (linked && !linked.deletedAt) throw new ConflictError("Esta conta prevista já foi quitada por outro lançamento.");
  }
  const paidNow = tx.type === "EXPENSE" && tx.creditCardId ? "POSTED" : "PAID";
  await db.scheduledPayment.update({
    where: { id: sp.id },
    data: { transactionId: tx.id, status: paidNow, paidAt: paidNow === "PAID" ? new Date() : null },
  });
}

export async function getTransaction(ctx: ServiceContext, id: string): Promise<TransactionDTO & { history: unknown[] }> {
  const scope = await getVisibilityScope(ctx);
  const tx = await prisma.transaction.findFirst({
    where: { id, householdId: ctx.householdId, ...visibleTransactionWhere(scope) },
    include: {
      ...transactionInclude,
      installments: { orderBy: { number: "asc" }, include: { statement: { select: { referenceMonth: true, dueDate: true } } } },
      attachments: { select: { id: true, kind: true, mimeType: true, createdAt: true, contentDeletedAt: true, processingStatus: true } },
      sourceMessage: { select: { id: true, type: true, sentAt: true, senderMemberId: true } },
    },
  });
  if (!tx) throw new NotFoundError("Transação");
  const history = await prisma.auditLog.findMany({
    where: { householdId: ctx.householdId, entityType: "Transaction", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return {
    ...serializeTransaction(tx),
    installments: tx.installments.map((i) => ({
      id: i.id,
      number: i.number,
      totalInstallments: i.totalInstallments,
      amountCents: i.amountCents,
      dueDate: dateToISO(i.dueDate),
      referenceMonth: i.statement.referenceMonth,
      statementId: i.statementId,
    })),
    attachments: tx.attachments,
    sourceMessage: tx.sourceMessage,
    history,
  } as TransactionDTO & { history: unknown[] };
}

async function loadEditable(db: Db, ctx: ServiceContext, id: string) {
  const scope = await getVisibilityScope(ctx, db);
  const tx = await db.transaction.findFirst({
    where: { id, householdId: ctx.householdId, ...visibleTransactionWhere(scope) },
    include: { allocations: true, merchant: { select: { name: true } } },
  });
  if (!tx) throw new NotFoundError("Transação");
  return tx;
}

export async function updateTransaction(
  ctx: ServiceContext,
  id: string,
  rawPatch: TransactionUpdateInput,
  opts: { db?: Prisma.TransactionClient; reason?: string } = {},
): Promise<TransactionDTO> {
  assertCan(ctx, "transactions:write");
  const patch = parsePatch(transactionUpdateSchema, rawPatch);

  await runInTx(opts.db, async (db) => {
    const current = await loadEditable(db, ctx, id);
    if (current.deletedAt) throw new ValidationError("Restaure a transação antes de editá-la.");
    if (patch.expectedVersion && patch.expectedVersion !== current.version) {
      throw new ConflictError("Esta transação foi alterada por outra pessoa. Recarregue e tente novamente.");
    }

    // Ajusta o rateio proporcionalmente quando o valor muda e o rateio não foi reenviado.
    let allocations = patch.allocations ?? current.allocations.map((a) => ({ memberId: a.memberId, amountCents: a.amountCents }));
    const newAmount = patch.amountCents ?? current.amountCents;
    if (!patch.allocations && allocations.length > 1 && newAmount !== current.amountCents) {
      const parts = splitByWeights(newAmount, allocations.map((a) => a.amountCents));
      allocations = allocations.map((a, i) => ({ ...a, amountCents: parts[i]! }));
    }
    const ownershipChanged = patch.ownership !== undefined && patch.ownership !== current.ownership;
    if (ownershipChanged && !patch.allocations) allocations = [];

    const merged: TransactionFields = {
      type: patch.type ?? current.type,
      amountCents: newAmount,
      description: patch.description ?? current.description,
      notes: patch.notes !== undefined ? patch.notes : current.notes,
      date: patch.date ?? dateToISO(current.date),
      competenceDate:
        patch.competenceDate !== undefined
          ? patch.competenceDate
          : patch.date && dateToISO(current.competenceDate) === dateToISO(current.date)
            ? patch.date
            : dateToISO(current.competenceDate),
      categoryId: patch.categoryId !== undefined ? patch.categoryId : current.categoryId,
      subcategoryId:
        patch.subcategoryId !== undefined ? patch.subcategoryId : patch.categoryId !== undefined && patch.categoryId !== current.categoryId ? null : current.subcategoryId,
      merchantName: patch.merchantName !== undefined ? patch.merchantName : current.merchant?.name ?? null,
      paymentMethod: patch.paymentMethod !== undefined ? patch.paymentMethod : current.paymentMethod,
      accountId: patch.accountId !== undefined ? patch.accountId : current.accountId,
      destinationAccountId: patch.destinationAccountId !== undefined ? patch.destinationAccountId : current.destinationAccountId,
      destinationAmountCents: patch.destinationAmountCents !== undefined ? patch.destinationAmountCents : current.destinationAmountCents,
      creditCardId: patch.creditCardId !== undefined ? patch.creditCardId : current.creditCardId,
      statementId: patch.statementId !== undefined ? patch.statementId : current.type === "CARD_PAYMENT" && !patch.creditCardId && !patch.date ? current.statementId : null,
      installmentCount: patch.installmentCount ?? current.installmentCount,
      payerMemberId: patch.payerMemberId !== undefined ? patch.payerMemberId : current.payerMemberId,
      ownership: patch.ownership ?? current.ownership,
      responsibleMemberId: patch.responsibleMemberId !== undefined ? patch.responsibleMemberId : current.responsibleMemberId,
      allocations,
      status: current.status,
      goalId: patch.goalId !== undefined ? patch.goalId : current.goalId,
    };
    // Trocar de cartão para débito (ou vice-versa) limpa o vínculo incompatível.
    if (patch.paymentMethod && patch.paymentMethod !== "CREDIT_CARD" && patch.creditCardId === undefined) merged.creditCardId = null;
    if (patch.creditCardId && patch.accountId === undefined && merged.type === "EXPENSE") merged.accountId = null;

    const data = await normalize(db, ctx, merged);
    const updated = await db.transaction.update({
      where: { id },
      data: {
        type: data.type,
        amountCents: data.amountCents,
        description: data.description,
        notes: data.notes,
        merchantId: data.merchantId,
        categoryId: data.categoryId,
        subcategoryId: data.subcategoryId,
        date: isoToDate(data.date),
        competenceDate: isoToDate(data.competenceDate),
        paymentMethod: data.paymentMethod,
        accountId: data.accountId,
        destinationAccountId: data.destinationAccountId,
        destinationAmountCents: data.destinationAmountCents,
        currency: data.currency,
        amountBrlCents: data.amountBrlCents,
        creditCardId: data.creditCardId,
        statementId: data.statementId,
        installmentCount: data.installmentCount,
        payerMemberId: data.payerMemberId,
        ownership: data.ownership,
        responsibleMemberId: data.responsibleMemberId,
        goalId: data.goalId,
        fingerprint: transactionFingerprint({ ...data, merchantName: merged.merchantName }),
        version: { increment: 1 },
        allocations: { deleteMany: {}, create: data.allocations },
      },
      include: { allocations: true },
    });
    await repostTransaction(db, id);
    await syncAutomaticPending(db, ctx, updated);

    const before = snapshot(current);
    const after = snapshot(updated);
    const changedKeys = Object.keys(after).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
    const onlyCategory = changedKeys.length > 0 && changedKeys.every((k) => k === "categoryId" || k === "subcategoryId");
    await audit(ctx, { action: onlyCategory ? "RECLASSIFY" : "UPDATE", entityType: "Transaction", entityId: id, before, after, source: opts.reason ?? null }, db);
  });

  if (!opts.db) {
    await publishEvent(ctx.householdId, "transaction.changed", id);
    await publishEvent(ctx.householdId, "pending.changed");
  }
  return loadDTO(opts.db ?? prisma, id);
}

/** Exclusão lógica (restaurável). Remove o efeito nos saldos e faturas. */
export async function deleteTransaction(ctx: ServiceContext, id: string, opts: { db?: Prisma.TransactionClient; reason?: string; action?: "DELETE" | "REJECT" } = {}) {
  assertCan(ctx, "transactions:delete");
  await runInTx(opts.db, async (db) => {
    const current = await loadEditable(db, ctx, id);
    if (current.deletedAt) return;
    const updated = await db.transaction.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByMemberId: ctx.memberId, version: { increment: 1 } },
      include: { allocations: true },
    });
    await repostTransaction(db, id);
    // Libera a conta prevista vinculada e as contribuições de meta associadas.
    await db.scheduledPayment.updateMany({ where: { transactionId: id }, data: { transactionId: null, status: "PENDING", paidAt: null } });
    await db.goalContribution.updateMany({ where: { transactionId: id, deletedAt: null }, data: { deletedAt: new Date() } });
    await resolvePendingWhere(db, { householdId: ctx.householdId, transactionId: id }, opts.action === "REJECT" ? "Lançamento rejeitado" : "Lançamento excluído", ctx.memberId, "DISMISSED");
    await audit(ctx, { action: opts.action ?? "DELETE", entityType: "Transaction", entityId: id, before: snapshot(current), after: snapshot(updated), source: opts.reason ?? null }, db);
  });
  if (!opts.db) {
    await publishEvent(ctx.householdId, "transaction.changed", id);
    await publishEvent(ctx.householdId, "pending.changed");
  }
}

export async function restoreTransaction(ctx: ServiceContext, id: string, opts: { db?: Prisma.TransactionClient } = {}): Promise<TransactionDTO> {
  assertCan(ctx, "transactions:delete");
  await runInTx(opts.db, async (db) => {
    const current = await loadEditable(db, ctx, id);
    if (!current.deletedAt) return;
    const updated = await db.transaction.update({
      where: { id },
      data: { deletedAt: null, deletedByMemberId: null, version: { increment: 1 } },
      include: { allocations: true },
    });
    await repostTransaction(db, id);
    await db.goalContribution.updateMany({ where: { transactionId: id }, data: { deletedAt: null } });
    await syncAutomaticPending(db, ctx, updated);
    await audit(ctx, { action: "RESTORE", entityType: "Transaction", entityId: id, before: snapshot(current), after: snapshot(updated) }, db);
  });
  if (!opts.db) await publishEvent(ctx.householdId, "transaction.changed", id);
  return loadDTO(opts.db ?? prisma, id);
}

/** Confirma uma transação pendente (passa a afetar saldos e relatórios). */
export async function confirmTransaction(ctx: ServiceContext, id: string, opts: { db?: Prisma.TransactionClient } = {}): Promise<TransactionDTO> {
  assertCan(ctx, "transactions:write");
  await runInTx(opts.db, async (db) => {
    const current = await loadEditable(db, ctx, id);
    if (current.deletedAt) throw new ValidationError("Transação excluída não pode ser confirmada.");
    if (current.status === "CONFIRMED") return;
    const updated = await db.transaction.update({ where: { id }, data: { status: "CONFIRMED", version: { increment: 1 } }, include: { allocations: true } });
    await repostTransaction(db, id);
    await resolvePendingWhere(db, { householdId: ctx.householdId, transactionId: id, type: { in: ["CONFIRMATION", "POSSIBLE_DUPLICATE"] } }, "Confirmado", ctx.memberId);
    await audit(ctx, { action: "CONFIRM", entityType: "Transaction", entityId: id, before: snapshot(current), after: snapshot(updated) }, db);
  });
  if (!opts.db) {
    await publishEvent(ctx.householdId, "transaction.changed", id);
    await publishEvent(ctx.householdId, "pending.changed");
  }
  return loadDTO(opts.db ?? prisma, id);
}

/** Exclusão definitiva — somente de transações já excluídas logicamente e com confirmação explícita. */
export async function purgeTransaction(ctx: ServiceContext, id: string, confirmation: string) {
  assertCan(ctx, "transactions:delete");
  if (confirmation !== "EXCLUIR") throw new ValidationError('Para excluir definitivamente, confirme digitando "EXCLUIR".');
  await withTransaction(async (db) => {
    const current = await loadEditable(db, ctx, id);
    if (!current.deletedAt) throw new ValidationError("Exclua a transação (lixeira) antes de removê-la definitivamente.");
    await audit(ctx, { action: "PURGE", entityType: "Transaction", entityId: id, before: snapshot(current) }, db);
    await db.transaction.delete({ where: { id } });
  });
}

/** Reclassificação em lote (auditada individualmente). */
export async function bulkReclassify(ctx: ServiceContext, ids: string[], categoryId: string, subcategoryId: string | null) {
  assertCan(ctx, "transactions:write");
  if (ids.length > 500) throw new ValidationError("Selecione no máximo 500 transações por vez.");
  let updated = 0;
  for (const id of ids) {
    await updateTransaction(ctx, id, { categoryId, subcategoryId }, { reason: "Reclassificação em lote" });
    updated++;
  }
  return { updated };
}

// -----------------------------------------------------------------------------
// Consulta
// -----------------------------------------------------------------------------

export async function buildTransactionWhere(ctx: ServiceContext, raw: TransactionListFilters): Promise<Prisma.TransactionWhereInput> {
  const f = transactionListSchema.parse(raw);
  const scope = await getVisibilityScope(ctx);
  const and: Prisma.TransactionWhereInput[] = [{ householdId: ctx.householdId }, visibleTransactionWhere(scope)];
  if (f.deleted === "exclude") and.push({ deletedAt: null });
  if (f.deleted === "only") and.push({ deletedAt: { not: null } });
  if (f.start) and.push({ [f.dateField]: { gte: isoToDate(f.start) } });
  if (f.end) and.push({ [f.dateField]: { lte: isoToDate(f.end) } });
  if (f.types?.length) and.push({ type: { in: f.types } });
  if (f.status) and.push({ status: f.status });
  if (f.categoryIds?.length) and.push({ categoryId: { in: f.categoryIds } });
  if (f.subcategoryId) and.push({ subcategoryId: f.subcategoryId });
  if (f.uncategorized) and.push({ categoryId: null, type: { in: ["EXPENSE", "INCOME"] } });
  if (f.accountId) and.push({ OR: [{ accountId: f.accountId }, { destinationAccountId: f.accountId }] });
  if (f.creditCardId) and.push({ creditCardId: f.creditCardId });
  if (f.ownership) and.push({ ownership: f.ownership });
  if (f.paymentMethods?.length) and.push({ paymentMethod: { in: f.paymentMethods } });
  if (f.sources?.length) and.push({ source: { in: f.sources } });
  if (f.merchantId) and.push({ merchantId: f.merchantId });
  if (f.minAmountCents != null) and.push({ amountCents: { gte: f.minAmountCents } });
  if (f.maxAmountCents != null) and.push({ amountCents: { lte: f.maxAmountCents } });
  if (f.memberId) {
    const byPayer: Prisma.TransactionWhereInput = { payerMemberId: f.memberId };
    const byResp: Prisma.TransactionWhereInput = { OR: [{ responsibleMemberId: f.memberId }, { allocations: { some: { memberId: f.memberId } } }] };
    and.push(f.personMode === "payer" ? byPayer : f.personMode === "responsible" ? byResp : { OR: [byPayer, byResp] });
  }
  if (f.search) {
    const term = f.search;
    const asNumber = Number(term.replace(/\./g, "").replace(",", "."));
    const or: Prisma.TransactionWhereInput[] = [
      { description: { contains: term, mode: "insensitive" } },
      { notes: { contains: term, mode: "insensitive" } },
      { merchant: { name: { contains: term, mode: "insensitive" } } },
      { category: { name: { contains: term, mode: "insensitive" } } },
      { subcategory: { name: { contains: term, mode: "insensitive" } } },
    ];
    if (Number.isFinite(asNumber) && asNumber > 0) or.push({ amountCents: Math.round(asNumber * 100) });
    and.push({ OR: or });
  }
  return { AND: and };
}

export async function listTransactions(ctx: ServiceContext, raw: TransactionListFilters) {
  assertCan(ctx, "transactions:read");
  const f = transactionListSchema.parse(raw);
  const where = await buildTransactionWhere(ctx, f);
  const orderBy: Prisma.TransactionOrderByWithRelationInput[] =
    f.sort === "date_asc"
      ? [{ date: "asc" }, { createdAt: "asc" }]
      : f.sort === "amount_desc"
        ? [{ amountCents: "desc" }, { date: "desc" }]
        : f.sort === "amount_asc"
          ? [{ amountCents: "asc" }, { date: "desc" }]
          : f.sort === "created_desc"
            ? [{ createdAt: "desc" }]
            : [{ date: "desc" }, { createdAt: "desc" }];
  const [rows, total, sums] = await Promise.all([
    prisma.transaction.findMany({ where, orderBy, skip: (f.page - 1) * f.pageSize, take: f.pageSize, include: transactionInclude }),
    prisma.transaction.count({ where }),
    // Totais em reais: lançamentos em moeda estrangeira entram pelo valor em reais (PTAX da data).
    prisma.transaction.groupBy({ by: ["type", "currency"], where: { AND: [where, { status: "CONFIRMED", deletedAt: null }] }, _sum: { amountCents: true, amountBrlCents: true } }),
  ]);
  const sumOf = (t: string) => sums.filter((s) => s.type === t).reduce((acc, s) => acc + ((s.currency === "BRL" ? s._sum.amountCents : s._sum.amountBrlCents) ?? 0), 0);
  return {
    items: rows.map(serializeTransaction),
    total,
    page: f.page,
    pageSize: f.pageSize,
    totals: { expenseCents: sumOf("EXPENSE"), incomeCents: sumOf("INCOME"), transferCents: sumOf("TRANSFER"), cardPaymentCents: sumOf("CARD_PAYMENT") },
  };
}

/** Últimas transações registradas por um membro (usado em correções via WhatsApp). */
export async function recentTransactionsForMember(ctx: ServiceContext, memberId: string | null, limit = 15) {
  const scope = await getVisibilityScope(ctx);
  const rows = await prisma.transaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      ...visibleTransactionWhere(scope),
      ...(memberId ? { OR: [{ createdByMemberId: memberId }, { payerMemberId: memberId }] } : {}),
      createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: transactionInclude,
  });
  return rows.map(serializeTransaction);
}

/** Recalcula ledger e parcelas de todas as transações da família (ferramenta de integridade). */
export async function rebuildHouseholdLedger(householdId: string): Promise<{ transactions: number }> {
  const ids = await prisma.transaction.findMany({ where: { householdId }, select: { id: true }, orderBy: { createdAt: "asc" } });
  for (const { id } of ids) {
    await withTransaction((db) => repostTransaction(db, id));
  }
  return { transactions: ids.length };
}

export { todayISO };
