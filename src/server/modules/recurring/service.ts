import { z } from "zod";
import type { Prisma, RecurringTransaction } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { AppError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { addDays, dateToISO, isoToDate, maxISO, todayISO, type ISODate } from "@/lib/dates";
import { RECURRENCE_FREQUENCY_LABELS } from "@/lib/labels";
import { audit } from "../audit/service";
import { findOrCreateMerchant } from "../merchants/service";
import { createPendingItem } from "../pending/service";
import { createTransaction } from "../transactions/service";
import { amountCentsSchema, idSchema, isoDateSchema, PAYMENT_METHODS } from "../transactions/schemas";
import { getVisibilityScope } from "../visibility/scope";
import { describeRecurrence, monthlyEquivalentCents, nextOccurrence, occurrencesBetween, RECURRENCE_FREQUENCIES, type RecurrenceRule } from "./schedule";

/** Ocorrências previstas são geradas para os próximos N dias. */
export const GENERATION_HORIZON_DAYS = 60;

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const fields = {
  type: z.enum(["EXPENSE", "INCOME"]),
  description: z.string().trim().min(1, "Informe uma descrição").max(200),
  amountCents: amountCentsSchema,
  /** Valor variável (ex.: energia): o valor informado é uma estimativa. */
  isVariableAmount: z.boolean(),
  categoryId: idSchema.nullish(),
  subcategoryId: idSchema.nullish(),
  merchantName: z.string().trim().max(120).nullish(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
  accountId: idSchema.nullish(),
  creditCardId: idSchema.nullish(),
  ownership: z.enum(["SHARED", "INDIVIDUAL"]),
  responsibleMemberId: idSchema.nullish(),
  /** Natureza dos lançamentos gerados: Pessoal ou Empresa. */
  scope: z.enum(["PERSONAL", "BUSINESS"]),
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  interval: z.number().int().min(1).max(366),
  dayOfMonth: z.number().int().min(1).max(31).nullish(),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullish(),
  autoPost: z.boolean(),
  reminderDaysBefore: z.number().int().min(0).max(30),
};

export const recurringCreateSchema = z.object({
  ...fields,
  type: fields.type.default("EXPENSE"),
  isVariableAmount: fields.isVariableAmount.default(false),
  ownership: fields.ownership.default("SHARED"),
  scope: fields.scope.default("PERSONAL"),
  frequency: fields.frequency.default("MONTHLY"),
  interval: fields.interval.default(1),
  startDate: isoDateSchema.optional(),
  autoPost: fields.autoPost.default(false),
  reminderDaysBefore: fields.reminderDaysBefore.default(3),
  active: z.boolean().default(true),
});
export type RecurringCreateInput = z.input<typeof recurringCreateSchema>;

export const recurringUpdateSchema = z.object(fields).partial();
export type RecurringUpdateInput = z.input<typeof recurringUpdateSchema>;

export const recurringListSchema = z.object({
  active: z.boolean().optional(),
  type: z.enum(["EXPENSE", "INCOME"]).optional(),
});

// -----------------------------------------------------------------------------
// Normalização e validação
// -----------------------------------------------------------------------------

type RecurringFields = z.output<typeof recurringUpdateSchema> & z.output<typeof recurringCreateSchema>;

interface NormalizedRecurring {
  type: "EXPENSE" | "INCOME";
  description: string;
  amountCents: number;
  isVariableAmount: boolean;
  categoryId: string | null;
  subcategoryId: string | null;
  merchantId: string | null;
  paymentMethod: (typeof PAYMENT_METHODS)[number] | null;
  accountId: string | null;
  creditCardId: string | null;
  ownership: "SHARED" | "INDIVIDUAL";
  responsibleMemberId: string | null;
  scope: "PERSONAL" | "BUSINESS";
  frequency: (typeof RECURRENCE_FREQUENCIES)[number];
  interval: number;
  dayOfMonth: number | null;
  startDate: ISODate;
  endDate: ISODate | null;
  autoPost: boolean;
  reminderDaysBefore: number;
}

const MONTH_BASED = new Set(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY", "CUSTOM_MONTHS"]);

async function normalizeRecurring(db: Db, ctx: ServiceContext, input: Omit<RecurringFields, "active"> & { startDate: ISODate }): Promise<NormalizedRecurring> {
  const hh = ctx.householdId;
  const data: NormalizedRecurring = {
    type: input.type,
    description: input.description,
    amountCents: input.amountCents,
    isVariableAmount: input.isVariableAmount,
    categoryId: input.categoryId ?? null,
    subcategoryId: input.subcategoryId ?? null,
    merchantId: null,
    paymentMethod: input.paymentMethod ?? null,
    accountId: input.accountId ?? null,
    creditCardId: input.creditCardId ?? null,
    ownership: input.ownership,
    responsibleMemberId: input.responsibleMemberId ?? null,
    scope: input.scope ?? "PERSONAL",
    frequency: input.frequency,
    interval: input.frequency === "CUSTOM_DAYS" || input.frequency === "CUSTOM_MONTHS" ? input.interval : 1,
    dayOfMonth: MONTH_BASED.has(input.frequency) ? input.dayOfMonth ?? null : null,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    autoPost: input.autoPost,
    reminderDaysBefore: input.reminderDaysBefore,
  };

  if (data.endDate && data.endDate < data.startDate) throw new ValidationError("A data final deve ser igual ou posterior à data inicial.", { field: "endDate" });

  if (data.type === "INCOME") {
    if (data.creditCardId) throw new ValidationError("Receitas não podem ser vinculadas a cartão de crédito.", { field: "creditCardId" });
    if (data.paymentMethod === "CREDIT_CARD") data.paymentMethod = null;
  }

  const scope = await getVisibilityScope(ctx, db);
  if (data.creditCardId) {
    const card = await db.creditCard.findFirst({ where: { id: data.creditCardId, householdId: hh }, select: { id: true, archivedAt: true } });
    if (!card || scope.hiddenCardIds.includes(card.id)) throw new ValidationError("Cartão inválido.", { field: "creditCardId" });
    if (card.archivedAt) throw new ValidationError("O cartão selecionado está arquivado.", { field: "creditCardId" });
    data.paymentMethod = "CREDIT_CARD";
    data.accountId = null;
  } else if (data.paymentMethod === "CREDIT_CARD") {
    data.accountId = null;
  }
  if (data.accountId) {
    const acc = await db.account.findFirst({ where: { id: data.accountId, householdId: hh }, select: { id: true, archivedAt: true } });
    if (!acc || scope.hiddenAccountIds.includes(acc.id)) throw new ValidationError("Conta inválida.", { field: "accountId" });
    if (acc.archivedAt) throw new ValidationError("A conta selecionada está arquivada.", { field: "accountId" });
  }

  if (data.subcategoryId) {
    const sub = await db.subcategory.findFirst({ where: { id: data.subcategoryId, householdId: hh }, select: { categoryId: true } });
    if (!sub) throw new ValidationError("Subcategoria inválida.", { field: "subcategoryId" });
    if (data.categoryId && data.categoryId !== sub.categoryId) throw new ValidationError("A subcategoria não pertence à categoria informada.", { field: "subcategoryId" });
    data.categoryId = sub.categoryId;
  }
  if (data.categoryId) {
    const cat = await db.category.findFirst({ where: { id: data.categoryId, householdId: hh }, select: { kind: true } });
    if (!cat) throw new ValidationError("Categoria inválida.", { field: "categoryId" });
    if (cat.kind !== data.type) throw new ValidationError(data.type === "INCOME" ? "Use uma categoria de receita." : "Use uma categoria de despesa.", { field: "categoryId" });
  }

  if (data.ownership === "INDIVIDUAL") data.responsibleMemberId = data.responsibleMemberId ?? ctx.memberId;
  if (data.ownership === "INDIVIDUAL" && !data.responsibleMemberId) {
    throw new ValidationError("Informe o responsável pela recorrência individual.", { field: "responsibleMemberId" });
  }
  if (data.responsibleMemberId) {
    const m = await db.householdMember.findFirst({ where: { id: data.responsibleMemberId, householdId: hh }, select: { id: true } });
    if (!m) throw new ValidationError("Responsável inválido.", { field: "responsibleMemberId" });
  }

  if (data.autoPost) {
    if (data.type === "EXPENSE" && !data.accountId && !data.creditCardId) {
      throw new ValidationError("Para lançar automaticamente, informe a conta ou o cartão.", { field: "autoPost" });
    }
    if (data.type === "INCOME" && !data.accountId) throw new ValidationError("Para lançar automaticamente, informe a conta de destino.", { field: "autoPost" });
  }

  data.merchantId = await findOrCreateMerchant(db, hh, input.merchantName);
  return data;
}

// -----------------------------------------------------------------------------
// Ocorrências previstas
// -----------------------------------------------------------------------------

export function ruleOf(rec: Pick<RecurringTransaction, "frequency" | "interval" | "dayOfMonth" | "startDate" | "endDate">): RecurrenceRule {
  return {
    frequency: rec.frequency,
    interval: rec.interval,
    dayOfMonth: rec.dayOfMonth,
    startDate: dateToISO(rec.startDate),
    endDate: rec.endDate ? dateToISO(rec.endDate) : null,
  };
}

/** Datas previstas a partir de hoje, dentro do horizonte de geração. */
function plannedDates(rec: RecurringTransaction, today: ISODate): ISODate[] {
  if (!rec.active) return [];
  const rule = ruleOf(rec);
  return occurrencesBetween(rule, maxISO(rule.startDate, today), addDays(today, GENERATION_HORIZON_DAYS));
}

function occurrenceData(rec: RecurringTransaction, dueDate: ISODate): Prisma.ScheduledPaymentCreateManyInput {
  return {
    householdId: rec.householdId,
    recurringTransactionId: rec.id,
    type: rec.type,
    description: rec.description,
    amountCents: rec.amountCents,
    isEstimate: rec.isVariableAmount,
    dueDate: isoToDate(dueDate),
    status: "PENDING",
    categoryId: rec.categoryId,
    accountId: rec.accountId,
    creditCardId: rec.creditCardId,
  };
}

/**
 * Gera as ocorrências previstas (ScheduledPayment) de hoje até o horizonte.
 * Idempotente: o índice único (recorrência, vencimento) impede duplicatas e preserva as
 * ocorrências existentes (pagas, ignoradas ou editadas individualmente).
 */
export async function generateOccurrences(db: Db, rec: RecurringTransaction, today: ISODate): Promise<number> {
  const dates = plannedDates(rec, today);
  if (!dates.length) return 0;
  const res = await db.scheduledPayment.createMany({ data: dates.map((d) => occurrenceData(rec, d)), skipDuplicates: true });
  return res.count;
}

/**
 * Após editar a recorrência: ajusta somente as ocorrências FUTURAS ainda PENDENTES (sem transação).
 * Datas que deixaram de existir são removidas; campos alterados no modelo são aplicados; datas novas
 * são criadas. Ocorrências pagas, lançadas, ignoradas ou vencidas nunca são alteradas.
 */
async function regenerateFuture(db: Db, before: RecurringTransaction, after: RecurringTransaction, today: ISODate) {
  const future = await db.scheduledPayment.findMany({
    where: { recurringTransactionId: after.id, status: { in: ["PENDING", "SKIPPED", "CANCELLED"] }, transactionId: null, dueDate: { gte: isoToDate(today) } },
    select: { id: true, dueDate: true, status: true },
  });
  const a = ruleOf(before);
  const b = ruleOf(after);
  const scheduleChanged =
    a.frequency !== b.frequency || a.interval !== b.interval || a.dayOfMonth !== b.dayOfMonth || a.startDate !== b.startDate || (a.endDate ?? null) !== (b.endDate ?? null);
  const valid = new Set(plannedDates(after, today));
  // Pendentes fora da nova agenda saem; ignoradas/canceladas só saem quando a agenda mudou.
  const toRemove = future.filter((f) => !valid.has(dateToISO(f.dueDate)) && (f.status === "PENDING" || scheduleChanged)).map((f) => f.id);
  const toKeep = future.filter((f) => f.status === "PENDING" && valid.has(dateToISO(f.dueDate))).map((f) => f.id);
  if (toRemove.length) await db.scheduledPayment.deleteMany({ where: { id: { in: toRemove } } });

  const patch: Prisma.ScheduledPaymentUncheckedUpdateManyInput = {};
  if (before.description !== after.description) patch.description = after.description;
  if (before.amountCents !== after.amountCents) patch.amountCents = after.amountCents;
  if (before.isVariableAmount !== after.isVariableAmount) patch.isEstimate = after.isVariableAmount;
  if (before.type !== after.type) patch.type = after.type;
  if (before.categoryId !== after.categoryId) patch.categoryId = after.categoryId;
  if (before.accountId !== after.accountId) patch.accountId = after.accountId;
  if (before.creditCardId !== after.creditCardId) patch.creditCardId = after.creditCardId;
  let updated = 0;
  if (toKeep.length && Object.keys(patch).length) {
    updated = (await db.scheduledPayment.updateMany({ where: { id: { in: toKeep } }, data: patch })).count;
  }
  const created = await generateOccurrences(db, after, today);
  return { removed: toRemove.length, updated, created };
}

// -----------------------------------------------------------------------------
// DTO
// -----------------------------------------------------------------------------

const recurringInclude = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  subcategory: { select: { id: true, name: true } },
  merchant: { select: { id: true, name: true } },
  account: { select: { id: true, name: true, color: true } },
  creditCard: { select: { id: true, name: true, color: true } },
  responsible: { select: { id: true, displayName: true, color: true } },
} satisfies Prisma.RecurringTransactionInclude;

type RecurringRow = Prisma.RecurringTransactionGetPayload<{ include: typeof recurringInclude }>;

export interface RecurringDTO {
  id: string;
  type: "EXPENSE" | "INCOME";
  description: string;
  amountCents: number;
  isVariableAmount: boolean;
  category: { id: string; name: string; color: string; icon: string } | null;
  subcategory: { id: string; name: string } | null;
  merchant: { id: string; name: string } | null;
  paymentMethod: string | null;
  account: { id: string; name: string; color: string } | null;
  creditCard: { id: string; name: string; color: string } | null;
  ownership: string;
  responsible: { id: string; displayName: string; color: string } | null;
  /** Natureza: Pessoal ou Empresa. */
  scope: "PERSONAL" | "BUSINESS";
  frequency: string;
  frequencyLabel: string;
  scheduleLabel: string;
  interval: number;
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
  autoPost: boolean;
  reminderDaysBefore: number;
  active: boolean;
  nextOccurrence: string | null;
  /** Alias de `nextOccurrence` (compatibilidade com a interface do dashboard). */
  nextDueDate: string | null;
  nextScheduledPaymentId: string | null;
  monthlyEquivalentCents: number;
  createdAt: string;
  updatedAt: string;
}

function toDTO(rec: RecurringRow, next: { date: string | null; scheduledPaymentId: string | null }): RecurringDTO {
  const rule = ruleOf(rec);
  return {
    id: rec.id,
    type: rec.type === "INCOME" ? "INCOME" : "EXPENSE",
    description: rec.description,
    amountCents: rec.amountCents,
    isVariableAmount: rec.isVariableAmount,
    category: rec.category,
    subcategory: rec.subcategory,
    merchant: rec.merchant,
    paymentMethod: rec.paymentMethod,
    account: rec.account,
    creditCard: rec.creditCard,
    ownership: rec.ownership,
    responsible: rec.responsible,
    scope: rec.scope,
    frequency: rec.frequency,
    frequencyLabel: RECURRENCE_FREQUENCY_LABELS[rec.frequency],
    scheduleLabel: describeRecurrence(rule),
    interval: rec.interval,
    dayOfMonth: rec.dayOfMonth,
    startDate: rule.startDate,
    endDate: rule.endDate ?? null,
    autoPost: rec.autoPost,
    reminderDaysBefore: rec.reminderDaysBefore,
    active: rec.active,
    nextOccurrence: next.date,
    nextDueDate: next.date,
    nextScheduledPaymentId: next.scheduledPaymentId,
    monthlyEquivalentCents: monthlyEquivalentCents(rec.amountCents, rule),
    createdAt: rec.createdAt.toISOString(),
    updatedAt: rec.updatedAt.toISOString(),
  };
}

async function withNext(ctx: ServiceContext, recs: RecurringRow[]): Promise<RecurringDTO[]> {
  if (!recs.length) return [];
  const today = todayISO(ctx.timezone);
  const pending = await prisma.scheduledPayment.findMany({
    where: { recurringTransactionId: { in: recs.map((r) => r.id) }, status: "PENDING", dueDate: { gte: isoToDate(today) } },
    orderBy: { dueDate: "asc" },
    select: { id: true, recurringTransactionId: true, dueDate: true },
  });
  return recs.map((rec) => {
    const sp = pending.find((p) => p.recurringTransactionId === rec.id);
    if (sp) return toDTO(rec, { date: dateToISO(sp.dueDate), scheduledPaymentId: sp.id });
    return toDTO(rec, { date: rec.active ? nextOccurrence(ruleOf(rec), today) : null, scheduledPaymentId: null });
  });
}

async function hiddenFilter(ctx: ServiceContext): Promise<Prisma.RecurringTransactionWhereInput> {
  const scope = await getVisibilityScope(ctx);
  const and: Prisma.RecurringTransactionWhereInput[] = [];
  if (scope.hiddenAccountIds.length) and.push({ OR: [{ accountId: null }, { accountId: { notIn: scope.hiddenAccountIds } }] });
  if (scope.hiddenCardIds.length) and.push({ OR: [{ creditCardId: null }, { creditCardId: { notIn: scope.hiddenCardIds } }] });
  return and.length ? { AND: and } : {};
}

async function loadRecurring(ctx: ServiceContext, id: string, db: Db = prisma): Promise<RecurringTransaction> {
  const rec = await db.recurringTransaction.findFirst({ where: { AND: [{ id, householdId: ctx.householdId }, await hiddenFilter(ctx)] } });
  if (!rec) throw new NotFoundError("Recorrência");
  return rec;
}

function snapshot(rec: RecurringTransaction) {
  const rule = ruleOf(rec);
  return {
    type: rec.type,
    description: rec.description,
    amountCents: rec.amountCents,
    isVariableAmount: rec.isVariableAmount,
    categoryId: rec.categoryId,
    subcategoryId: rec.subcategoryId,
    merchantId: rec.merchantId,
    paymentMethod: rec.paymentMethod,
    accountId: rec.accountId,
    creditCardId: rec.creditCardId,
    ownership: rec.ownership,
    responsibleMemberId: rec.responsibleMemberId,
    frequency: rec.frequency,
    interval: rec.interval,
    dayOfMonth: rec.dayOfMonth,
    startDate: rule.startDate,
    endDate: rule.endDate ?? null,
    autoPost: rec.autoPost,
    reminderDaysBefore: rec.reminderDaysBefore,
    active: rec.active,
  };
}

// -----------------------------------------------------------------------------
// Consulta
// -----------------------------------------------------------------------------

/** Recorrências com próxima ocorrência e total mensal equivalente (somente as ativas entram nos totais). */
export async function listRecurring(ctx: ServiceContext, params: z.input<typeof recurringListSchema> = {}) {
  const f = recurringListSchema.parse(params);
  const recs = await prisma.recurringTransaction.findMany({
    where: {
      AND: [
        { householdId: ctx.householdId },
        f.active !== undefined ? { active: f.active } : {},
        f.type ? { type: f.type } : { type: { in: ["EXPENSE", "INCOME"] } },
        await hiddenFilter(ctx),
      ],
    },
    orderBy: [{ active: "desc" }, { description: "asc" }],
    include: recurringInclude,
  });
  const items = await withNext(ctx, recs);
  const active = items.filter((i) => i.active);
  const monthlyExpenseCents = active.filter((i) => i.type === "EXPENSE").reduce((s, i) => s + i.monthlyEquivalentCents, 0);
  const monthlyIncomeCents = active.filter((i) => i.type === "INCOME").reduce((s, i) => s + i.monthlyEquivalentCents, 0);
  return {
    items,
    totals: {
      activeCount: active.length,
      monthlyExpenseCents,
      monthlyIncomeCents,
      monthlyNetCents: monthlyIncomeCents - monthlyExpenseCents,
      estimatedCount: active.filter((i) => i.isVariableAmount).length,
    },
  };
}

/** Detalhe da recorrência com as ocorrências recentes e futuras. */
export async function getRecurring(ctx: ServiceContext, id: string) {
  await loadRecurring(ctx, id);
  const rec = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id }, include: recurringInclude });
  const [dto] = await withNext(ctx, [rec]);
  const occurrences = await prisma.scheduledPayment.findMany({
    where: { recurringTransactionId: id, householdId: ctx.householdId },
    orderBy: { dueDate: "desc" },
    take: 24,
    select: { id: true, dueDate: true, amountCents: true, isEstimate: true, status: true, transactionId: true, paidAt: true },
  });
  const today = todayISO(ctx.timezone);
  return {
    ...dto!,
    occurrences: occurrences.map((o) => {
      const due = dateToISO(o.dueDate);
      return {
        id: o.id,
        dueDate: due,
        amountCents: o.amountCents,
        isEstimate: o.isEstimate,
        status: o.status,
        overdue: o.status === "PENDING" && due < today,
        transactionId: o.transactionId,
        paidAt: o.paidAt?.toISOString() ?? null,
      };
    }),
  };
}

// -----------------------------------------------------------------------------
// Mutações
// -----------------------------------------------------------------------------

async function loadDTO(ctx: ServiceContext, id: string): Promise<RecurringDTO> {
  const rec = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id }, include: recurringInclude });
  return (await withNext(ctx, [rec]))[0]!;
}

export async function createRecurring(ctx: ServiceContext, input: RecurringCreateInput): Promise<RecurringDTO> {
  assertCan(ctx, "bills:write");
  const parsed = recurringCreateSchema.parse(input);
  const today = todayISO(ctx.timezone);
  const id = await withTransaction(async (db) => {
    const data = await normalizeRecurring(db, ctx, { ...parsed, startDate: parsed.startDate ?? today });
    const rec = await db.recurringTransaction.create({
      data: {
        householdId: ctx.householdId,
        ...data,
        startDate: isoToDate(data.startDate),
        endDate: data.endDate ? isoToDate(data.endDate) : null,
        active: parsed.active,
      },
    });
    await generateOccurrences(db, rec, today);
    await audit(ctx, { action: "CREATE", entityType: "RecurringTransaction", entityId: rec.id, after: snapshot(rec) }, db);
    return rec.id;
  });
  await publishEvent(ctx.householdId, "bill.changed", id);
  return loadDTO(ctx, id);
}

/** Edita a recorrência. Somente as ocorrências futuras pendentes são regeneradas (as pagas nunca mudam). */
export async function updateRecurring(ctx: ServiceContext, id: string, input: RecurringUpdateInput): Promise<RecurringDTO & { occurrences: { removed: number; updated: number; created: number } }> {
  assertCan(ctx, "bills:write");
  const patch = recurringUpdateSchema.parse(input);
  const today = todayISO(ctx.timezone);
  const changes = await withTransaction(async (db) => {
    const current = await loadRecurring(ctx, id, db);
    const merchant = current.merchantId ? await db.merchant.findUnique({ where: { id: current.merchantId }, select: { name: true } }) : null;
    const typeChanged = patch.type !== undefined && patch.type !== current.type;
    const merged = {
      type: patch.type ?? (current.type === "INCOME" ? "INCOME" : "EXPENSE"),
      description: patch.description ?? current.description,
      amountCents: patch.amountCents ?? current.amountCents,
      isVariableAmount: patch.isVariableAmount ?? current.isVariableAmount,
      categoryId: patch.categoryId !== undefined ? patch.categoryId : typeChanged ? null : current.categoryId,
      subcategoryId:
        patch.subcategoryId !== undefined
          ? patch.subcategoryId
          : typeChanged || (patch.categoryId !== undefined && patch.categoryId !== current.categoryId)
            ? null
            : current.subcategoryId,
      merchantName: patch.merchantName !== undefined ? patch.merchantName : merchant?.name ?? null,
      paymentMethod: patch.paymentMethod !== undefined ? patch.paymentMethod : current.paymentMethod,
      accountId: patch.accountId !== undefined ? patch.accountId : current.accountId,
      creditCardId: patch.creditCardId !== undefined ? patch.creditCardId : current.creditCardId,
      ownership: patch.ownership ?? current.ownership,
      responsibleMemberId: patch.responsibleMemberId !== undefined ? patch.responsibleMemberId : current.responsibleMemberId,
      scope: patch.scope ?? current.scope,
      frequency: patch.frequency ?? current.frequency,
      interval: patch.interval ?? current.interval,
      dayOfMonth: patch.dayOfMonth !== undefined ? patch.dayOfMonth : current.dayOfMonth,
      startDate: patch.startDate ?? dateToISO(current.startDate),
      endDate: patch.endDate !== undefined ? patch.endDate : current.endDate ? dateToISO(current.endDate) : null,
      autoPost: patch.autoPost ?? current.autoPost,
      reminderDaysBefore: patch.reminderDaysBefore ?? current.reminderDaysBefore,
    } satisfies Omit<RecurringFields, "active"> & { startDate: ISODate };
    // Trocar de cartão para conta (ou vice-versa) limpa o vínculo incompatível.
    if (patch.accountId && patch.creditCardId === undefined) merged.creditCardId = null;
    if (patch.creditCardId && patch.accountId === undefined) merged.accountId = null;
    if (patch.paymentMethod && patch.paymentMethod !== "CREDIT_CARD" && patch.creditCardId === undefined) merged.creditCardId = null;

    const data = await normalizeRecurring(db, ctx, merged);
    const updated = await db.recurringTransaction.update({
      where: { id },
      data: { ...data, startDate: isoToDate(data.startDate), endDate: data.endDate ? isoToDate(data.endDate) : null },
    });
    const occ = await regenerateFuture(db, current, updated, today);
    await audit(ctx, { action: "UPDATE", entityType: "RecurringTransaction", entityId: id, before: snapshot(current), after: snapshot(updated), metadata: { occurrences: occ } }, db);
    return occ;
  });
  await publishEvent(ctx.householdId, "bill.changed", id);
  return { ...(await loadDTO(ctx, id)), occurrences: changes };
}

/**
 * Ativa ou desativa a recorrência. Desativar cancela as ocorrências futuras pendentes;
 * reativar restaura as canceladas que ainda pertencem à agenda e gera as que faltam.
 */
export async function setRecurringActive(ctx: ServiceContext, id: string, active?: boolean): Promise<RecurringDTO & { affectedOccurrences: number }> {
  assertCan(ctx, "bills:write");
  const today = todayISO(ctx.timezone);
  const affected = await withTransaction(async (db) => {
    const current = await loadRecurring(ctx, id, db);
    const target = active ?? !current.active;
    if (target === current.active) return 0;
    const updated = await db.recurringTransaction.update({ where: { id }, data: { active: target } });
    let count: number;
    if (!target) {
      count = (
        await db.scheduledPayment.updateMany({
          where: { recurringTransactionId: id, status: "PENDING", transactionId: null, dueDate: { gte: isoToDate(today) } },
          data: { status: "CANCELLED" },
        })
      ).count;
    } else {
      const valid = plannedDates(updated, today).map(isoToDate);
      count = valid.length
        ? (
            await db.scheduledPayment.updateMany({
              where: { recurringTransactionId: id, status: "CANCELLED", transactionId: null, dueDate: { in: valid } },
              // Restauradas com os dados atuais do modelo (podem ter sido editados enquanto inativa).
              data: {
                status: "PENDING",
                type: updated.type,
                description: updated.description,
                amountCents: updated.amountCents,
                isEstimate: updated.isVariableAmount,
                categoryId: updated.categoryId,
                accountId: updated.accountId,
                creditCardId: updated.creditCardId,
              },
            })
          ).count
        : 0;
      count += await generateOccurrences(db, updated, today);
    }
    await audit(ctx, { action: "UPDATE", entityType: "RecurringTransaction", entityId: id, before: { active: current.active }, after: { active: target }, metadata: { occurrences: count } }, db);
    return count;
  });
  await publishEvent(ctx.householdId, "bill.changed", id);
  return { ...(await loadDTO(ctx, id)), affectedOccurrences: affected };
}

/**
 * Exclui a recorrência e as ocorrências futuras pendentes. O histórico (ocorrências pagas,
 * transações lançadas e contas vencidas em aberto) é preservado, sem vínculo com a recorrência.
 */
export async function deleteRecurring(ctx: ServiceContext, id: string): Promise<{ removedOccurrences: number }> {
  assertCan(ctx, "bills:write");
  const today = todayISO(ctx.timezone);
  const removed = await withTransaction(async (db) => {
    const current = await loadRecurring(ctx, id, db);
    const res = await db.scheduledPayment.deleteMany({
      where: { recurringTransactionId: id, status: { in: ["PENDING", "CANCELLED", "SKIPPED"] }, transactionId: null, dueDate: { gte: isoToDate(today) } },
    });
    await db.recurringTransaction.delete({ where: { id } });
    await audit(ctx, { action: "DELETE", entityType: "RecurringTransaction", entityId: id, before: snapshot(current), metadata: { removedOccurrences: res.count } }, db);
    return res.count;
  });
  await publishEvent(ctx.householdId, "bill.changed", id);
  return { removedOccurrences: removed };
}

// -----------------------------------------------------------------------------
// Lançamento automático
// -----------------------------------------------------------------------------

/**
 * Lança a transação de uma ocorrência com `autoPost` (bloqueando a linha para evitar duplicidade
 * entre execuções concorrentes). Valores estimados entram como "aguardando confirmação".
 */
export async function autoPostOccurrence(ctx: ServiceContext, scheduledPaymentId: string): Promise<{ posted: boolean; transactionId?: string }> {
  const result = await withTransaction(async (db) => {
    const locked = await db.$queryRaw<Array<{ id: string; transactionId: string | null; status: string }>>`
      SELECT id, "transactionId", status::text AS status FROM "ScheduledPayment"
      WHERE id = ${scheduledPaymentId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
    const row = locked[0];
    if (!row || row.status !== "PENDING" || row.transactionId) return { posted: false };
    const sp = await db.scheduledPayment.findUniqueOrThrow({ where: { id: scheduledPaymentId }, include: { recurring: { include: { merchant: { select: { name: true } } } } } });
    const rec = sp.recurring;
    if (!rec || !rec.active || !rec.autoPost || (sp.type !== "EXPENSE" && sp.type !== "INCOME")) return { posted: false };
    const res = await createTransaction(
      ctx,
      {
        type: sp.type,
        amountCents: sp.amountCents,
        description: sp.description,
        notes: sp.notes,
        date: dateToISO(sp.dueDate),
        categoryId: sp.categoryId,
        subcategoryId: rec.subcategoryId && rec.categoryId === sp.categoryId ? rec.subcategoryId : null,
        merchantName: rec.merchant?.name ?? null,
        paymentMethod: rec.paymentMethod,
        accountId: sp.creditCardId ? null : sp.accountId,
        creditCardId: sp.type === "EXPENSE" ? sp.creditCardId : null,
        ownership: rec.ownership,
        responsibleMemberId: rec.ownership === "INDIVIDUAL" ? rec.responsibleMemberId : null,
        payerMemberId: rec.responsibleMemberId,
        status: sp.isEstimate ? "PENDING" : "CONFIRMED",
        nature: rec.scope,
      },
      { source: "RECURRING", recurringTransactionId: rec.id, scheduledPaymentId: sp.id, checkDuplicates: false, db },
    );
    return { posted: true, transactionId: res.transaction.id };
  });
  if (result.posted) {
    await publishEvent(ctx.householdId, "transaction.changed", result.transactionId);
    await publishEvent(ctx.householdId, "bill.changed", scheduledPaymentId);
  }
  return result;
}

/** Registra uma pendência quando o lançamento automático falha (uma vez por ocorrência). */
export async function reportAutoPostFailure(householdId: string, scheduledPaymentId: string, description: string, err: unknown): Promise<void> {
  const dedupeKey = `recurring-post:${scheduledPaymentId}`;
  const existing = await prisma.pendingItem.findUnique({ where: { householdId_dedupeKey: { householdId, dedupeKey } }, select: { id: true } });
  if (existing) return;
  const reason = err instanceof AppError ? err.message : "Erro inesperado ao lançar a transação.";
  await createPendingItem(prisma, {
    householdId,
    type: "PROCESSING_FAILED",
    title: `Lançamento automático não realizado: ${description}`,
    description: `${reason} A conta continua prevista em "Contas a pagar"; registre o pagamento manualmente ou ajuste a recorrência.`,
    dedupeKey,
    data: { scheduledPaymentId },
  });
  await publishEvent(householdId, "pending.changed");
}
