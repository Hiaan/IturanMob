import { z } from "zod";
import type { Prisma, ScheduledPaymentStatus } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { addDays, dateToISO, diffDays, endOfMonth, formatDateBR, formatMonthBR, isMonthKey, isoToDate, minISO, monthRange, startOfMonth, todayISO, type ISODate } from "@/lib/dates";
import { RECURRENCE_FREQUENCY_LABELS, SCHEDULED_STATUS_LABELS } from "@/lib/labels";
import { normalizeText, tokenSimilarity } from "@/lib/utils";
import { audit } from "../audit/service";
import { listCards, listStatements } from "../cards/service";
import { createTransaction, deleteTransaction } from "../transactions/service";
import { amountCentsSchema, idSchema, isoDateSchema, PAYMENT_METHODS } from "../transactions/schemas";
import type { TransactionDTO } from "../transactions/serialize";
import { getVisibilityScope } from "../visibility/scope";

// -----------------------------------------------------------------------------
// Status derivado
// -----------------------------------------------------------------------------

/** Prevista, Vencida, Lançada, Paga, Ignorada, Cancelada. */
export const BILL_STATUSES = ["PENDING", "OVERDUE", "POSTED", "PAID", "SKIPPED", "CANCELLED"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export function deriveBillStatus(status: ScheduledPaymentStatus, dueDate: ISODate, today: ISODate): BillStatus {
  if (status === "PENDING" && dueDate < today) return "OVERDUE";
  return status;
}

function statusLabel(status: BillStatus, type: "EXPENSE" | "INCOME"): string {
  if (type === "INCOME" && status === "PAID") return "Recebida";
  if (type === "INCOME" && status === "OVERDUE") return "Atrasada";
  return SCHEDULED_STATUS_LABELS[status];
}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const billFields = {
  type: z.enum(["EXPENSE", "INCOME"]),
  description: z.string().trim().min(1, "Informe uma descrição").max(200),
  amountCents: amountCentsSchema,
  isEstimate: z.boolean(),
  dueDate: isoDateSchema,
  categoryId: idSchema.nullish(),
  accountId: idSchema.nullish(),
  creditCardId: idSchema.nullish(),
  notes: z.string().trim().max(1000).nullish(),
};

export const billCreateSchema = z.object({ ...billFields, type: billFields.type.default("EXPENSE"), isEstimate: billFields.isEstimate.default(false) });
export type BillCreateInput = z.input<typeof billCreateSchema>;

export const billUpdateSchema = z
  .object(billFields)
  .partial()
  .extend({
    /** Reabre uma conta ignorada ou cancelada. */
    status: z.literal("PENDING").optional(),
  });
export type BillUpdateInput = z.input<typeof billUpdateSchema>;

export const billListSchema = z.object({
  start: isoDateSchema.optional(),
  end: isoDateSchema.optional(),
  /** Atalho para o período de um mês (AAAA-MM). */
  month: z.string().refine((v) => isMonthKey(v), "Mês inválido (use AAAA-MM)").optional(),
  statuses: z.array(z.enum(BILL_STATUSES)).optional(),
  type: z.enum(["EXPENSE", "INCOME"]).optional(),
  /** Inclui as faturas de cartão em aberto como linhas somente leitura (padrão: sim). */
  includeStatements: z.boolean().default(true),
  /** Inclui contas vencidas anteriores ao período (padrão: sim, quando o período começa até hoje). */
  includeOverdue: z.boolean().default(true),
  search: z.string().trim().max(120).optional(),
});
export type BillListFilters = z.input<typeof billListSchema>;

export const billPaySchema = z.object({
  date: isoDateSchema.optional(),
  accountId: idSchema.nullish(),
  creditCardId: idSchema.nullish(),
  amountCents: amountCentsSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});
export type BillPayInput = z.input<typeof billPaySchema>;

// -----------------------------------------------------------------------------
// DTO
// -----------------------------------------------------------------------------

export interface BillDTO {
  /** Id da conta prevista ou `statement:<id>` para faturas de cartão. */
  id: string;
  kind: "SCHEDULED" | "CARD_STATEMENT";
  readOnly: boolean;
  type: "EXPENSE" | "INCOME";
  description: string;
  amountCents: number;
  isEstimate: boolean;
  dueDate: string;
  daysUntilDue: number;
  status: BillStatus;
  statusLabel: string;
  rawStatus: ScheduledPaymentStatus | null;
  category: { id: string; name: string; color: string; icon: string } | null;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string; color?: string } | null;
  recurring: { id: string; frequency: string; frequencyLabel: string; autoPost: boolean } | null;
  transaction: { id: string; amountCents: number; date: string; status: string; deletedAt: string | null } | null;
  /** Valor efetivamente pago (transação vinculada), quando houver. */
  paidAmountCents: number | null;
  paidAt: string | null;
  notes: string | null;
  statement: { id: string; creditCardId: string; referenceMonth: string; closingDate: string; totalCents: number; paidCents: number; status: string } | null;
}

const billInclude = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  account: { select: { id: true, name: true } },
  creditCard: { select: { id: true, name: true, color: true } },
  recurring: { select: { id: true, frequency: true, autoPost: true } },
  transaction: { select: { id: true, amountCents: true, date: true, status: true, deletedAt: true } },
} satisfies Prisma.ScheduledPaymentInclude;

type BillRow = Prisma.ScheduledPaymentGetPayload<{ include: typeof billInclude }>;

function toBillDTO(sp: BillRow, today: ISODate): BillDTO {
  const due = dateToISO(sp.dueDate);
  const type = sp.type === "INCOME" ? "INCOME" : "EXPENSE";
  const status = deriveBillStatus(sp.status, due, today);
  const tx = sp.transaction && !sp.transaction.deletedAt ? sp.transaction : null;
  return {
    id: sp.id,
    kind: "SCHEDULED",
    readOnly: false,
    type,
    description: sp.description,
    amountCents: sp.amountCents,
    isEstimate: sp.isEstimate,
    dueDate: due,
    daysUntilDue: diffDays(due, today),
    status,
    statusLabel: statusLabel(status, type),
    rawStatus: sp.status,
    category: sp.category,
    account: sp.account,
    creditCard: sp.creditCard,
    recurring: sp.recurring
      ? { id: sp.recurring.id, frequency: sp.recurring.frequency, frequencyLabel: RECURRENCE_FREQUENCY_LABELS[sp.recurring.frequency], autoPost: sp.recurring.autoPost }
      : null,
    transaction: sp.transaction
      ? {
          id: sp.transaction.id,
          amountCents: sp.transaction.amountCents,
          date: dateToISO(sp.transaction.date),
          status: sp.transaction.status,
          deletedAt: sp.transaction.deletedAt?.toISOString() ?? null,
        }
      : null,
    paidAmountCents: tx && (sp.status === "PAID" || sp.status === "POSTED") ? tx.amountCents : null,
    paidAt: sp.paidAt?.toISOString() ?? null,
    notes: sp.notes,
    statement: null,
  };
}

async function hiddenFilter(ctx: ServiceContext, db: Db = prisma): Promise<Prisma.ScheduledPaymentWhereInput> {
  const scope = await getVisibilityScope(ctx, db);
  const and: Prisma.ScheduledPaymentWhereInput[] = [];
  if (scope.hiddenAccountIds.length) and.push({ OR: [{ accountId: null }, { accountId: { notIn: scope.hiddenAccountIds } }] });
  if (scope.hiddenCardIds.length) and.push({ OR: [{ creditCardId: null }, { creditCardId: { notIn: scope.hiddenCardIds } }] });
  return and.length ? { AND: and } : {};
}

async function loadBill(ctx: ServiceContext, id: string, db: Db = prisma): Promise<BillRow> {
  const sp = await db.scheduledPayment.findFirst({ where: { AND: [{ id, householdId: ctx.householdId }, await hiddenFilter(ctx, db)] }, include: billInclude });
  if (!sp) throw new NotFoundError("Conta");
  return sp;
}

export async function getBill(ctx: ServiceContext, id: string): Promise<BillDTO> {
  return toBillDTO(await loadBill(ctx, id), todayISO(ctx.timezone));
}

// -----------------------------------------------------------------------------
// Listagem
// -----------------------------------------------------------------------------

export interface BillTotals {
  /** Despesas previstas (a vencer) no período, incluindo faturas de cartão. */
  pendingCents: number;
  pendingCount: number;
  /** Despesas vencidas e não pagas. */
  overdueCents: number;
  overdueCount: number;
  /** A pagar = previstas + vencidas. */
  toPayCents: number;
  paidCents: number;
  paidCount: number;
  expectedIncomeCents: number;
  receivedIncomeCents: number;
  statementsCents: number;
}

/**
 * Contas a pagar/receber do período com status derivado, mais as faturas de cartão em aberto
 * (somente leitura). Os totais consideram todo o período, independentemente do filtro de status.
 */
export async function listBills(ctx: ServiceContext, filters: BillListFilters = {}) {
  const f = billListSchema.parse(filters);
  const today = todayISO(ctx.timezone);
  const start = f.start ?? (f.month ? monthRange(f.month).start : startOfMonth(today));
  const end = f.end ?? (f.month ? monthRange(f.month).end : endOfMonth(today));
  if (start > end) throw new ValidationError("O início do período deve ser anterior ao fim.", { field: "start" });
  const withOverdue = f.includeOverdue && start <= today;

  const periodOr: Prisma.ScheduledPaymentWhereInput[] = [{ dueDate: { gte: isoToDate(start), lte: isoToDate(end) } }];
  if (withOverdue) periodOr.push({ status: "PENDING", dueDate: { lt: isoToDate(minISO(start, today)) } });

  const rows = await prisma.scheduledPayment.findMany({
    where: {
      AND: [
        { householdId: ctx.householdId },
        f.type ? { type: f.type } : { type: { in: ["EXPENSE", "INCOME"] } },
        { OR: periodOr },
        await hiddenFilter(ctx),
      ],
    },
    include: billInclude,
    orderBy: [{ dueDate: "asc" }, { description: "asc" }],
  });
  const items: BillDTO[] = rows.map((r) => toBillDTO(r, today));

  if (f.includeStatements && f.type !== "INCOME") {
    const cards = await listCards(ctx);
    for (const card of cards) {
      const statements = await listStatements(ctx, card.id);
      for (const st of statements) {
        if (st.remainingCents <= 0) continue;
        const inPeriod = st.dueDate >= start && st.dueDate <= end;
        const overdueBefore = withOverdue && st.dueDate < minISO(start, today);
        if (!inPeriod && !overdueBefore) continue;
        const status: BillStatus = st.dueDate < today ? "OVERDUE" : "PENDING";
        items.push({
          id: `statement:${st.id}`,
          kind: "CARD_STATEMENT",
          readOnly: true,
          type: "EXPENSE",
          description: `Fatura ${card.name} (${formatMonthBR(st.referenceMonth)})`,
          amountCents: st.remainingCents,
          isEstimate: st.closingDate > today,
          dueDate: st.dueDate,
          daysUntilDue: diffDays(st.dueDate, today),
          status,
          statusLabel: statusLabel(status, "EXPENSE"),
          rawStatus: null,
          category: null,
          account: card.paymentAccountId ? { id: card.paymentAccountId, name: card.paymentAccountName ?? "" } : null,
          creditCard: { id: card.id, name: card.name, color: card.color },
          recurring: null,
          transaction: null,
          paidAmountCents: null,
          paidAt: null,
          notes: null,
          statement: {
            id: st.id,
            creditCardId: card.id,
            referenceMonth: st.referenceMonth,
            closingDate: st.closingDate,
            totalCents: st.totalCents,
            paidCents: st.paidCents,
            status: st.status,
          },
        });
      }
    }
  }

  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.kind.localeCompare(b.kind) || a.description.localeCompare(b.description));

  const totals: BillTotals = {
    pendingCents: 0,
    pendingCount: 0,
    overdueCents: 0,
    overdueCount: 0,
    toPayCents: 0,
    paidCents: 0,
    paidCount: 0,
    expectedIncomeCents: 0,
    receivedIncomeCents: 0,
    statementsCents: 0,
  };
  for (const i of items) {
    if (i.kind === "CARD_STATEMENT") totals.statementsCents += i.amountCents;
    if (i.type === "EXPENSE") {
      if (i.status === "PENDING") {
        totals.pendingCents += i.amountCents;
        totals.pendingCount++;
      } else if (i.status === "OVERDUE") {
        totals.overdueCents += i.amountCents;
        totals.overdueCount++;
      } else if (i.status === "PAID" || i.status === "POSTED") {
        totals.paidCents += i.paidAmountCents ?? i.amountCents;
        totals.paidCount++;
      }
    } else if (i.status === "PENDING" || i.status === "OVERDUE") {
      totals.expectedIncomeCents += i.amountCents;
    } else if (i.status === "PAID" || i.status === "POSTED") {
      totals.receivedIncomeCents += i.paidAmountCents ?? i.amountCents;
    }
  }
  totals.toPayCents = totals.pendingCents + totals.overdueCents;

  const term = f.search ? normalizeText(f.search) : null;
  const filtered = items.filter(
    (i) => (!f.statuses?.length || f.statuses.includes(i.status)) && (!term || normalizeText(`${i.description} ${i.category?.name ?? ""} ${i.notes ?? ""}`).includes(term)),
  );
  return { period: { start, end }, today, items: filtered, totals };
}

// -----------------------------------------------------------------------------
// Mutações
// -----------------------------------------------------------------------------

interface RefInput {
  type: "EXPENSE" | "INCOME";
  categoryId?: string | null;
  accountId?: string | null;
  creditCardId?: string | null;
}

async function validateRefs(ctx: ServiceContext, db: Db, data: RefInput) {
  const scope = await getVisibilityScope(ctx, db);
  if (data.type === "INCOME" && data.creditCardId) throw new ValidationError("Receitas não podem ser vinculadas a cartão de crédito.", { field: "creditCardId" });
  if (data.accountId) {
    const acc = await db.account.findFirst({ where: { id: data.accountId, householdId: ctx.householdId }, select: { id: true } });
    if (!acc || scope.hiddenAccountIds.includes(acc.id)) throw new ValidationError("Conta inválida.", { field: "accountId" });
  }
  if (data.creditCardId) {
    const card = await db.creditCard.findFirst({ where: { id: data.creditCardId, householdId: ctx.householdId }, select: { id: true } });
    if (!card || scope.hiddenCardIds.includes(card.id)) throw new ValidationError("Cartão inválido.", { field: "creditCardId" });
  }
  if (data.categoryId) {
    const cat = await db.category.findFirst({ where: { id: data.categoryId, householdId: ctx.householdId }, select: { kind: true } });
    if (!cat) throw new ValidationError("Categoria inválida.", { field: "categoryId" });
    if (cat.kind !== data.type) throw new ValidationError(data.type === "INCOME" ? "Use uma categoria de receita." : "Use uma categoria de despesa.", { field: "categoryId" });
  }
}

function billSnapshot(sp: { type: string; description: string; amountCents: number; isEstimate: boolean; dueDate: Date; status: string; categoryId: string | null; accountId: string | null; creditCardId: string | null; notes: string | null; transactionId: string | null }) {
  return {
    type: sp.type,
    description: sp.description,
    amountCents: sp.amountCents,
    isEstimate: sp.isEstimate,
    dueDate: dateToISO(sp.dueDate),
    status: sp.status,
    categoryId: sp.categoryId,
    accountId: sp.accountId,
    creditCardId: sp.creditCardId,
    notes: sp.notes,
    transactionId: sp.transactionId,
  };
}

/** Cria uma conta avulsa (despesa ou receita prevista). */
export async function createBill(ctx: ServiceContext, input: BillCreateInput): Promise<BillDTO> {
  assertCan(ctx, "bills:write");
  const data = billCreateSchema.parse(input);
  const creditCardId = data.type === "EXPENSE" ? data.creditCardId ?? null : null;
  const id = await withTransaction(async (db) => {
    await validateRefs(ctx, db, data);
    const sp = await db.scheduledPayment.create({
      data: {
        householdId: ctx.householdId,
        type: data.type,
        description: data.description,
        amountCents: data.amountCents,
        isEstimate: data.isEstimate,
        dueDate: isoToDate(data.dueDate),
        status: "PENDING",
        categoryId: data.categoryId ?? null,
        accountId: creditCardId ? null : data.accountId ?? null,
        creditCardId,
        notes: data.notes ?? null,
      },
    });
    await audit(ctx, { action: "CREATE", entityType: "ScheduledPayment", entityId: sp.id, after: billSnapshot(sp) }, db);
    return sp.id;
  });
  await publishEvent(ctx.householdId, "bill.changed", id);
  return getBill(ctx, id);
}

/** Edita uma conta prevista (contas pagas precisam ter o pagamento desfeito antes). */
export async function updateBill(ctx: ServiceContext, id: string, input: BillUpdateInput): Promise<BillDTO> {
  assertCan(ctx, "bills:write");
  const patch = billUpdateSchema.parse(input);
  await withTransaction(async (db) => {
    const current = await loadBill(ctx, id, db);
    if (current.status === "PAID" || current.status === "POSTED") {
      throw new ValidationError("Esta conta já foi paga. Desfaça o pagamento para editá-la.");
    }
    const type = patch.type ?? (current.type === "INCOME" ? "INCOME" : "EXPENSE");
    const merged = {
      type,
      categoryId: patch.categoryId !== undefined ? patch.categoryId : patch.type && patch.type !== current.type ? null : current.categoryId,
      accountId: patch.accountId !== undefined ? patch.accountId : patch.creditCardId ? null : current.accountId,
      creditCardId: type === "INCOME" ? null : patch.creditCardId !== undefined ? patch.creditCardId : patch.accountId ? null : current.creditCardId,
    };
    await validateRefs(ctx, db, merged);
    const dueDate = patch.dueDate ?? dateToISO(current.dueDate);
    if (current.recurringTransactionId && dueDate !== dateToISO(current.dueDate)) {
      const clash = await db.scheduledPayment.findFirst({
        where: { recurringTransactionId: current.recurringTransactionId, dueDate: isoToDate(dueDate), id: { not: id } },
        select: { id: true },
      });
      if (clash) throw new ConflictError("Já existe uma ocorrência desta recorrência nesta data.");
    }
    let status: ScheduledPaymentStatus = current.status;
    if (patch.status === "PENDING") {
      if (current.status !== "SKIPPED" && current.status !== "CANCELLED" && current.status !== "PENDING") {
        throw new ValidationError("Somente contas ignoradas ou canceladas podem ser reabertas.");
      }
      status = "PENDING";
    }
    const updated = await db.scheduledPayment.update({
      where: { id },
      data: {
        type,
        description: patch.description ?? current.description,
        amountCents: patch.amountCents ?? current.amountCents,
        isEstimate: patch.isEstimate ?? current.isEstimate,
        dueDate: isoToDate(dueDate),
        categoryId: merged.categoryId ?? null,
        accountId: merged.accountId ?? null,
        creditCardId: merged.creditCardId ?? null,
        notes: patch.notes !== undefined ? patch.notes ?? null : current.notes,
        status,
      },
    });
    await audit(ctx, { action: "UPDATE", entityType: "ScheduledPayment", entityId: id, before: billSnapshot(current), after: billSnapshot(updated) }, db);
  });
  await publishEvent(ctx.householdId, "bill.changed", id);
  return getBill(ctx, id);
}

async function setBillStatus(ctx: ServiceContext, id: string, status: "SKIPPED" | "CANCELLED"): Promise<BillDTO> {
  assertCan(ctx, "bills:write");
  const changed = await withTransaction(async (db) => {
    const current = await loadBill(ctx, id, db);
    if (current.status === status) return false;
    if (current.status !== "PENDING") {
      throw new ValidationError(
        current.status === "PAID" || current.status === "POSTED"
          ? "Esta conta já foi paga. Desfaça o pagamento antes."
          : "Somente contas previstas podem ser ignoradas ou canceladas.",
      );
    }
    await db.scheduledPayment.update({ where: { id }, data: { status } });
    await audit(ctx, { action: "UPDATE", entityType: "ScheduledPayment", entityId: id, before: { status: current.status }, after: { status } }, db);
    return true;
  });
  if (changed) await publishEvent(ctx.householdId, "bill.changed", id);
  return getBill(ctx, id);
}

/** Ignora uma ocorrência (ex.: mês sem cobrança). Não gera transação. */
export function skipBill(ctx: ServiceContext, id: string): Promise<BillDTO> {
  return setBillStatus(ctx, id, "SKIPPED");
}

/** Cancela a conta prevista. Não gera transação. */
export function cancelBill(ctx: ServiceContext, id: string): Promise<BillDTO> {
  return setBillStatus(ctx, id, "CANCELLED");
}

/**
 * Registra o pagamento (ou recebimento) da conta: cria a transação pelo serviço de transações,
 * que vincula a conta prevista e muda o status para PAID (ou POSTED, no cartão de crédito).
 */
export async function markPaid(ctx: ServiceContext, id: string, input: BillPayInput = {}): Promise<{ bill: BillDTO; transaction: TransactionDTO }> {
  assertCan(ctx, "bills:write");
  const data = billPaySchema.parse(input);
  const transaction = await withTransaction(async (db) => {
    const locked = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "ScheduledPayment" WHERE id = ${id} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
    if (!locked.length) throw new NotFoundError("Conta");
    const sp = await loadBill(ctx, id, db);
    if (sp.transaction && !sp.transaction.deletedAt) throw new ConflictError("Esta conta já foi paga.");
    if (sp.status !== "PENDING") throw new ValidationError("Reabra a conta (ignorada ou cancelada) antes de registrar o pagamento.");
    if (sp.type !== "EXPENSE" && sp.type !== "INCOME") throw new ValidationError("Tipo de conta não suportado.");

    const rec = sp.recurringTransactionId
      ? await db.recurringTransaction.findUnique({
          where: { id: sp.recurringTransactionId },
          select: { categoryId: true, subcategoryId: true, paymentMethod: true, ownership: true, responsibleMemberId: true, scope: true, merchant: { select: { name: true } } },
        })
      : null;

    let accountId = data.accountId !== undefined ? data.accountId : data.creditCardId ? null : sp.accountId;
    let creditCardId = sp.type === "INCOME" ? null : data.creditCardId !== undefined ? data.creditCardId : data.accountId ? null : sp.creditCardId;
    const paymentMethod = data.paymentMethod !== undefined ? data.paymentMethod : rec?.paymentMethod ?? null;
    if (paymentMethod && paymentMethod !== "CREDIT_CARD" && data.creditCardId === undefined) creditCardId = null;
    if (creditCardId) accountId = null;

    const res = await createTransaction(
      ctx,
      {
        type: sp.type,
        amountCents: data.amountCents ?? sp.amountCents,
        description: sp.description,
        notes: data.notes !== undefined ? data.notes : sp.notes,
        date: data.date ?? todayISO(ctx.timezone),
        categoryId: sp.categoryId,
        subcategoryId: rec?.subcategoryId && rec.categoryId === sp.categoryId ? rec.subcategoryId : null,
        merchantName: rec?.merchant?.name ?? null,
        paymentMethod,
        accountId,
        creditCardId,
        ownership: rec?.ownership ?? "SHARED",
        responsibleMemberId: rec?.ownership === "INDIVIDUAL" ? rec.responsibleMemberId : null,
        ...(rec?.scope ? { nature: rec.scope } : {}),
      },
      { scheduledPaymentId: id, source: "MANUAL", checkDuplicates: false, db },
    );
    await audit(ctx, { action: "UPDATE", entityType: "ScheduledPayment", entityId: id, before: { status: sp.status }, after: { status: "PAID", transactionId: res.transaction.id }, source: "pay" }, db);
    return res.transaction;
  });
  await publishEvent(ctx.householdId, "transaction.changed", transaction.id);
  await publishEvent(ctx.householdId, "bill.changed", id);
  await publishEvent(ctx.householdId, "pending.changed");
  return { bill: await getBill(ctx, id), transaction };
}

/** Desfaz o pagamento: exclui (logicamente) a transação vinculada; a conta volta a ficar prevista. */
export async function undoPayment(ctx: ServiceContext, id: string): Promise<BillDTO> {
  assertCan(ctx, "bills:write");
  const sp = await loadBill(ctx, id);
  if (!sp.transactionId) throw new ValidationError("Esta conta não possui pagamento registrado.");
  await deleteTransaction(ctx, sp.transactionId, { reason: "Pagamento de conta desfeito" });
  await publishEvent(ctx.householdId, "bill.changed", id);
  return getBill(ctx, id);
}

// -----------------------------------------------------------------------------
// Conciliação: lançamento manual de uma conta prevista ("Paguei 120 de internet")
// -----------------------------------------------------------------------------

export interface ScheduledPaymentDraft {
  type: "EXPENSE" | "INCOME";
  amountCents: number;
  date: string;
  description: string;
  categoryId?: string | null;
  merchantName?: string | null;
}

export interface ScheduledPaymentMatch {
  id: string;
  description: string;
  amountCents: number;
  isEstimate: boolean;
  dueDate: string;
  categoryId: string | null;
  accountId: string | null;
  creditCardId: string | null;
  recurringTransactionId: string | null;
  /** 0..1 */
  score: number;
  reasons: string[];
}

/** Palavras sem valor para identificar a conta. */
const BILL_STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "a", "o", "as", "os", "e", "em", "no", "na", "para", "pra", "pro", "um", "uma",
  "conta", "contas", "boleto", "pagamento", "pagto", "paguei", "pago", "paga", "pagar", "valor", "mensal", "mes", "referente",
]);

function informativeTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(normalizeText(text).split(" ").filter((t) => t.length > 1 && !BILL_STOPWORDS.has(t)));
}

/** Similaridade entre textos: Jaccard (tokenSimilarity) ou cobertura do conjunto menor. */
function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const ta = informativeTokens(a);
  const tb = informativeTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (!inter) return 0;
  return Math.max(tokenSimilarity(a, b), (inter / Math.min(ta.size, tb.size)) * 0.9);
}

/** Alguma palavra-chave da subcategoria aparece (como palavra inteira) no texto. */
function keywordHit(text: string, keywords: string[]): boolean {
  const padded = ` ${normalizeText(text)} `;
  return keywords.some((k) => {
    const nk = normalizeText(k);
    return nk.length > 2 && !BILL_STOPWORDS.has(nk) && padded.includes(` ${nk} `);
  });
}

/**
 * Procura a conta prevista (PENDING, sem transação) que corresponde a um lançamento informado
 * manualmente, para vinculá-lo em vez de criar duplicidade. Critérios:
 * - mesmo tipo; vencimento entre 20 dias antes e 10 dias depois da data do lançamento;
 * - valor igual (ou até ±20% quando o valor previsto é estimado);
 * - descrição/estabelecimento parecidos ou mesma categoria (quando a descrição não é informativa,
 *   a categoria precisa coincidir ou o valor precisa ser exatamente igual).
 * Retorna a melhor ocorrência ou null.
 */
export async function findMatchingScheduledPayment(ctx: ServiceContext, draft: ScheduledPaymentDraft): Promise<ScheduledPaymentMatch | null> {
  if (!Number.isInteger(draft.amountCents) || draft.amountCents <= 0) return null;
  const candidates = await prisma.scheduledPayment.findMany({
    where: {
      AND: [
        {
          householdId: ctx.householdId,
          type: draft.type,
          status: "PENDING",
          transactionId: null,
          dueDate: { gte: isoToDate(addDays(draft.date, -20)), lte: isoToDate(addDays(draft.date, 10)) },
        },
        await hiddenFilter(ctx),
      ],
    },
    include: {
      category: { select: { name: true } },
      recurring: { select: { merchant: { select: { name: true } }, subcategory: { select: { name: true, keywords: true } } } },
    },
  });
  if (!candidates.length) return null;

  const draftTexts = [draft.description, draft.merchantName].filter((t): t is string => Boolean(t && t.trim()));
  const draftInformative = draftTexts.some((t) => informativeTokens(t).size > 0);
  let best: ScheduledPaymentMatch | null = null;

  for (const sp of candidates) {
    const reasons: string[] = [];
    const diff = Math.abs(draft.amountCents - sp.amountCents);
    let amountScore: number;
    if (diff === 0) {
      amountScore = 1;
      reasons.push("valor igual");
    } else if (sp.isEstimate && diff * 5 <= sp.amountCents) {
      amountScore = 1 - (diff / (sp.amountCents * 0.2)) * 0.5;
      reasons.push("valor dentro da estimativa (±20%)");
    } else {
      continue;
    }

    const candidateTexts = [sp.description, sp.recurring?.merchant?.name, sp.recurring?.subcategory?.name].filter((t): t is string => Boolean(t));
    let textScore = 0;
    for (const d of draftTexts) for (const c of candidateTexts) textScore = Math.max(textScore, textSimilarity(d, c));
    const keywords = sp.recurring?.subcategory?.keywords ?? [];
    if (textScore < 0.8 && keywords.length && draftTexts.some((d) => keywordHit(d, keywords))) textScore = 0.8;
    if (textScore > 0) reasons.push("descrição parecida");

    const categoryMatch = Boolean(draft.categoryId && sp.categoryId && draft.categoryId === sp.categoryId);
    if (categoryMatch) reasons.push("mesma categoria");

    if (draftInformative) {
      // Descrição informativa sem nenhuma semelhança: é outro gasto (ex.: "luz" × "internet").
      if (textScore < 0.3) continue;
    } else {
      // Descrição genérica ("paguei o boleto"): exige categoria igual ou valor exato.
      if (!categoryMatch && diff !== 0) continue;
      if (diff === 0) textScore = 0.5;
    }

    const due = dateToISO(sp.dueDate);
    const dateScore = Math.max(0, 1 - Math.abs(diffDays(due, draft.date)) / 20);
    reasons.push(`vencimento em ${formatDateBR(due)}`);
    const score = Math.round((0.35 * amountScore + 0.4 * textScore + 0.15 * (categoryMatch ? 1 : 0) + 0.1 * dateScore) * 1000) / 1000;
    const minScore = draftInformative ? 0.5 : 0.45;
    if (score < minScore) continue;
    if (!best || score > best.score || (score === best.score && due < best.dueDate)) {
      best = {
        id: sp.id,
        description: sp.description,
        amountCents: sp.amountCents,
        isEstimate: sp.isEstimate,
        dueDate: due,
        categoryId: sp.categoryId,
        accountId: sp.accountId,
        creditCardId: sp.creditCardId,
        recurringTransactionId: sp.recurringTransactionId,
        score,
        reasons,
      };
    }
  }
  return best;
}
