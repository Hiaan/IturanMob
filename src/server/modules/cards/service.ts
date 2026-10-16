import { z } from "zod";
import { parsePatch } from "../../validation";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { addMonthsToKey, dateToISO, todayISO } from "@/lib/dates";
import { audit } from "../audit/service";
import { visibleCardWhere } from "../visibility/scope";
import { createTransaction, rebuildHouseholdLedger } from "../transactions/service";
import { isoDateSchema } from "../transactions/schemas";
import { statementForPurchase } from "./billing";
import { statementTotals, withStatus } from "./statements";
import { natureOf, type Nature } from "../transactions/nature";

export const cardSchema = z.object({
  name: z.string().trim().min(1).max(60),
  issuer: z.string().trim().max(60).nullish(),
  brand: z.string().trim().max(30).nullish(),
  last4: z
    .string()
    .regex(/^\d{4}$/, "Informe apenas os 4 últimos dígitos")
    .nullish(),
  holderMemberId: z.string().nullish(),
  visibility: z.enum(["SHARED", "PRIVATE"]).default("SHARED"),
  limitCents: z.number().int().min(0).max(1_000_000_000).default(0),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  paymentAccountId: z.string().nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1e3a5f"),
  icon: z.string().max(40).default("credit-card"),
});
export const cardUpdateSchema = cardSchema.partial().extend({ archived: z.boolean().optional() });

async function validateRefs(ctx: ServiceContext, data: { holderMemberId?: string | null; paymentAccountId?: string | null }) {
  if (data.holderMemberId && !(await prisma.householdMember.findFirst({ where: { id: data.holderMemberId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Titular inválido.", { field: "holderMemberId" });
  }
  if (data.paymentAccountId && !(await prisma.account.findFirst({ where: { id: data.paymentAccountId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Conta de pagamento inválida.", { field: "paymentAccountId" });
  }
}

export async function listCards(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}) {
  const today = todayISO(ctx.timezone);
  const cards = await prisma.creditCard.findMany({
    where: { ...visibleCardWhere(ctx), ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: "asc" }, { createdAt: "asc" }],
    include: { holder: { select: { displayName: true } }, paymentAccount: { select: { name: true } } },
  });
  const result = [];
  for (const card of cards) {
    const totals = await statementTotals(prisma, ctx.householdId, { creditCardId: card.id });
    const current = statementForPurchase(today, card);
    const statements = totals.map((t) => withStatus(t, today, current.referenceMonth));
    const outstanding = statements.reduce((s, t) => s + t.remainingCents, 0);
    const currentStatement = statements.find((s) => s.referenceMonth === current.referenceMonth) ?? null;
    const nextDue = statements.find((s) => s.remainingCents > 0 && s.closingDate <= today) ?? null;
    result.push({
      id: card.id,
      name: card.name,
      issuer: card.issuer,
      brand: card.brand,
      last4: card.last4,
      holderMemberId: card.holderMemberId,
      holderName: card.holder?.displayName ?? null,
      visibility: card.visibility,
      limitCents: card.limitCents,
      usedLimitCents: outstanding,
      availableLimitCents: card.limitCents ? Math.max(0, card.limitCents - outstanding) : null,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      paymentAccountId: card.paymentAccountId,
      paymentAccountName: card.paymentAccount?.name ?? null,
      color: card.color,
      icon: card.icon,
      archivedAt: card.archivedAt?.toISOString() ?? null,
      currentStatement: currentStatement ?? { referenceMonth: current.referenceMonth, closingDate: current.closingDate, dueDate: current.dueDate, totalCents: 0, paidCents: 0, remainingCents: 0, status: "OPEN" },
      nextDueStatement: nextDue,
      outstandingCents: outstanding,
    });
  }
  return result;
}

export async function createCard(ctx: ServiceContext, input: z.input<typeof cardSchema>) {
  assertCan(ctx, "cards:write");
  const data = cardSchema.parse(input);
  await validateRefs(ctx, data);
  if (await prisma.creditCard.findFirst({ where: { householdId: ctx.householdId, name: data.name } })) throw new ConflictError("Já existe um cartão com este nome.");
  if (data.visibility === "PRIVATE" && !data.holderMemberId) data.holderMemberId = ctx.memberId;
  const card = await prisma.creditCard.create({ data: { ...data, householdId: ctx.householdId } });
  await audit(ctx, { action: "CREATE", entityType: "CreditCard", entityId: card.id, after: card });
  await publishEvent(ctx.householdId, "card.changed", card.id);
  return card;
}

export async function updateCard(ctx: ServiceContext, id: string, input: z.input<typeof cardUpdateSchema>) {
  assertCan(ctx, "cards:write");
  const data = parsePatch(cardUpdateSchema, input);
  const current = await prisma.creditCard.findFirst({ where: { id, ...visibleCardWhere(ctx) } });
  if (!current) throw new NotFoundError("Cartão");
  await validateRefs(ctx, data);
  const { archived, ...rest } = data;
  const updated = await prisma.creditCard.update({
    where: { id },
    data: { ...rest, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) },
  });
  await audit(ctx, { action: "UPDATE", entityType: "CreditCard", entityId: id, before: current, after: updated });
  // Mudança nos dias de fechamento/vencimento: as faturas futuras são recalculadas.
  if ((data.closingDay && data.closingDay !== current.closingDay) || (data.dueDay && data.dueDay !== current.dueDay)) {
    await rebuildHouseholdLedger(ctx.householdId);
  }
  await publishEvent(ctx.householdId, "card.changed", id);
  return updated;
}

export async function deleteCard(ctx: ServiceContext, id: string) {
  assertCan(ctx, "cards:write");
  const current = await prisma.creditCard.findFirst({ where: { id, ...visibleCardWhere(ctx) } });
  if (!current) throw new NotFoundError("Cartão");
  const used = await prisma.transaction.count({ where: { creditCardId: id } });
  if (used) throw new ConflictError("Este cartão possui lançamentos. Arquive-o em vez de excluir.");
  await prisma.creditCard.delete({ where: { id } });
  await audit(ctx, { action: "DELETE", entityType: "CreditCard", entityId: id, before: current });
  await publishEvent(ctx.householdId, "card.changed", id);
}

export async function listStatements(ctx: ServiceContext, cardId: string) {
  const card = await prisma.creditCard.findFirst({ where: { id: cardId, ...visibleCardWhere(ctx) } });
  if (!card) throw new NotFoundError("Cartão");
  const today = todayISO(ctx.timezone);
  const current = statementForPurchase(today, card);
  const totals = await statementTotals(prisma, ctx.householdId, { creditCardId: cardId });
  return totals
    .filter((t) => t.totalCents > 0 || t.paidCents > 0 || t.referenceMonth === current.referenceMonth)
    .map((t) => withStatus(t, today, current.referenceMonth));
}

export async function getStatement(ctx: ServiceContext, statementId: string) {
  const st = await prisma.creditCardStatement.findFirst({ where: { id: statementId, householdId: ctx.householdId }, include: { creditCard: true } });
  if (!st) throw new NotFoundError("Fatura");
  const visible = await prisma.creditCard.findFirst({ where: { id: st.creditCardId, ...visibleCardWhere(ctx) } });
  if (!visible) throw new NotFoundError("Fatura");
  const today = todayISO(ctx.timezone);
  const [totals] = await statementTotals(prisma, ctx.householdId, { statementIds: [statementId] });
  const installments = await prisma.installment.findMany({
    where: { statementId },
    orderBy: [{ transaction: { date: "asc" } }],
    include: {
      transaction: {
        select: {
          id: true,
          description: true,
          date: true,
          amountCents: true,
          installmentCount: true,
          categoryId: true,
          scope: true,
          excludedFromReports: true,
          category: { select: { name: true, color: true } },
          payer: { select: { displayName: true } },
        },
      },
    },
  });
  const payments = await prisma.transaction.findMany({
    where: { statementId, type: "CARD_PAYMENT", deletedAt: null },
    orderBy: { date: "asc" },
    select: { id: true, amountCents: true, date: true, status: true, account: { select: { name: true } } },
  });
  const current = statementForPurchase(today, st.creditCard);
  return {
    ...withStatus(totals!, today, current.referenceMonth),
    card: { id: st.creditCard.id, name: st.creditCard.name, color: st.creditCard.color, paymentAccountId: st.creditCard.paymentAccountId },
    installments: installments.map((i) => ({
      id: i.id,
      number: i.number,
      totalInstallments: i.totalInstallments,
      amountCents: i.amountCents,
      transactionId: i.transaction.id,
      description: i.transaction.description,
      purchaseDate: dateToISO(i.transaction.date),
      totalAmountCents: i.transaction.amountCents,
      category: i.transaction.category,
      categoryId: i.transaction.categoryId,
      nature: natureOf(i.transaction),
      payerName: i.transaction.payer?.displayName ?? null,
    })),
    /** Resumo da fatura por categoria (valor e %) e por natureza (Pessoal/Empresa/Repasse). */
    byCategory: groupByCategory(installments.map((i) => ({ categoryId: i.transaction.categoryId, category: i.transaction.category, amountCents: i.amountCents }))),
    byNature: groupByNature(installments.map((i) => ({ nature: natureOf(i.transaction), amountCents: i.amountCents }))),
    payments: payments.map((p) => ({ ...p, date: dateToISO(p.date) })),
  };
}

export interface CategorySlice {
  categoryId: string | null;
  name: string;
  color: string;
  amountCents: number;
  percent: number;
  count: number;
}

/** Agrupa itens da fatura por categoria (sem categoria em um grupo próprio), do maior para o menor. */
export function groupByCategory(items: Array<{ categoryId: string | null; category: { name: string; color: string } | null; amountCents: number }>): CategorySlice[] {
  const total = items.reduce((s, i) => s + i.amountCents, 0);
  const map = new Map<string, CategorySlice>();
  for (const i of items) {
    const key = i.categoryId ?? "";
    const cur = map.get(key) ?? { categoryId: i.categoryId, name: i.category?.name ?? "Sem categoria", color: i.category?.color ?? "#94a3b8", amountCents: 0, percent: 0, count: 0 };
    cur.amountCents += i.amountCents;
    cur.count++;
    map.set(key, cur);
  }
  return [...map.values()]
    .map((c) => ({ ...c, percent: total ? Math.round((c.amountCents / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

function groupByNature(items: Array<{ nature: Nature; amountCents: number }>) {
  const out: Record<Nature, number> = { PERSONAL: 0, BUSINESS: 0, PASSTHROUGH: 0 };
  for (const i of items) out[i.nature] += i.amountCents;
  return out;
}

/**
 * Gastos por categoria da fatura atual (aberta) e da anterior de cada cartão, e a soma de todos.
 * Fatura = o que entra na cobrança (parcelas), por isso mostra também quanto é Empresa/Repasse.
 */
export async function cardsSpendingByCategory(ctx: ServiceContext) {
  const today = todayISO(ctx.timezone);
  const cards = await listCards(ctx);
  const out: Array<{
    card: { id: string; name: string; color: string };
    current: StatementCategorySummary | null;
    previous: StatementCategorySummary | null;
  }> = [];
  const combinedCurrent: Array<{ categoryId: string | null; category: { name: string; color: string } | null; amountCents: number }> = [];
  const combinedPrevious: typeof combinedCurrent = [];
  for (const card of cards) {
    const cfg = await prisma.creditCard.findUniqueOrThrow({ where: { id: card.id } });
    const currentRef = statementForPurchase(today, cfg).referenceMonth;
    const previousRef = addMonthsToKey(currentRef, -1);
    const statements = await prisma.creditCardStatement.findMany({
      where: { householdId: ctx.householdId, creditCardId: card.id, referenceMonth: { in: [currentRef, previousRef] } },
      include: {
        installments: {
          select: { amountCents: true, transaction: { select: { categoryId: true, scope: true, excludedFromReports: true, category: { select: { name: true, color: true } } } } },
        },
      },
    });
    const summarize = (ref: string): StatementCategorySummary | null => {
      const st = statements.find((s) => s.referenceMonth === ref);
      if (!st) return null;
      const items = st.installments.map((i) => ({ categoryId: i.transaction.categoryId, category: i.transaction.category, amountCents: i.amountCents }));
      (ref === currentRef ? combinedCurrent : combinedPrevious).push(...items);
      return {
        statementId: st.id,
        referenceMonth: st.referenceMonth,
        dueDate: dateToISO(st.dueDate),
        totalCents: items.reduce((s, i) => s + i.amountCents, 0),
        byCategory: groupByCategory(items),
        byNature: groupByNature(st.installments.map((i) => ({ nature: natureOf(i.transaction), amountCents: i.amountCents }))),
      };
    };
    out.push({ card: { id: card.id, name: card.name, color: card.color }, current: summarize(currentRef), previous: summarize(previousRef) });
  }
  return {
    cards: out,
    combined: {
      current: { totalCents: combinedCurrent.reduce((s, i) => s + i.amountCents, 0), byCategory: groupByCategory(combinedCurrent) },
      previous: { totalCents: combinedPrevious.reduce((s, i) => s + i.amountCents, 0), byCategory: groupByCategory(combinedPrevious) },
    },
  };
}

interface StatementCategorySummary {
  statementId: string;
  referenceMonth: string;
  dueDate: string;
  totalCents: number;
  byCategory: CategorySlice[];
  byNature: Record<Nature, number>;
}

export const payStatementSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  accountId: z.string().optional(),
  date: isoDateSchema.optional(),
});

/** Registra o pagamento da fatura (saída de caixa — não é despesa). */
export async function payStatement(ctx: ServiceContext, statementId: string, input: z.input<typeof payStatementSchema>) {
  const data = payStatementSchema.parse(input);
  const st = await getStatement(ctx, statementId);
  const amount = data.amountCents ?? st.remainingCents;
  if (amount <= 0) throw new ValidationError("Esta fatura não possui saldo em aberto.");
  const accountId = data.accountId ?? st.card.paymentAccountId;
  if (!accountId) throw new ValidationError("Informe a conta usada para pagar a fatura.", { field: "accountId" });
  const result = await createTransaction(
    ctx,
    {
      type: "CARD_PAYMENT",
      amountCents: amount,
      description: `Pagamento da fatura ${st.card.name} (${st.referenceMonth})`,
      date: data.date ?? todayISO(ctx.timezone),
      creditCardId: st.card.id,
      statementId,
      accountId,
    },
    { source: "MANUAL", checkDuplicates: false },
  );
  await publishEvent(ctx.householdId, "card.changed", st.card.id);
  return result.transaction;
}

/** Compromissos futuros no cartão (parcelas a vencer), agrupados por mês de vencimento. */
export async function futureCommitments(ctx: ServiceContext, months = 12) {
  const today = todayISO(ctx.timezone);
  const cards = await listCards(ctx);
  const byMonth = new Map<string, number>();
  for (const card of cards) {
    const statements = await listStatements(ctx, card.id);
    for (const s of statements) {
      if (s.remainingCents <= 0 || s.dueDate < today) continue;
      byMonth.set(s.referenceMonth, (byMonth.get(s.referenceMonth) ?? 0) + s.remainingCents);
    }
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, months)
    .map(([month, amountCents]) => ({ month, amountCents }));
}
