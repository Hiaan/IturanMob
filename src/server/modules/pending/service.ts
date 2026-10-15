import type { PendingStatus, PendingType, Prisma } from "@prisma/client";
import { prisma, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { NotFoundError } from "../../errors";
import { publishEvent } from "../../events";

export interface PendingInput {
  householdId: string;
  type: PendingType;
  title: string;
  description?: string | null;
  transactionId?: string | null;
  relatedTransactionId?: string | null;
  messageId?: string | null;
  attachmentId?: string | null;
  importRowId?: string | null;
  data?: Prisma.InputJsonValue | null;
  /** Evita itens repetidos para a mesma situação. */
  dedupeKey?: string | null;
}

export async function createPendingItem(db: Db, input: PendingInput) {
  const data = {
    householdId: input.householdId,
    type: input.type,
    title: input.title.slice(0, 200),
    description: input.description?.slice(0, 1000) ?? null,
    transactionId: input.transactionId ?? null,
    relatedTransactionId: input.relatedTransactionId ?? null,
    messageId: input.messageId ?? null,
    attachmentId: input.attachmentId ?? null,
    importRowId: input.importRowId ?? null,
    data: input.data ?? undefined,
    dedupeKey: input.dedupeKey ?? null,
  };
  if (input.dedupeKey) {
    return db.pendingItem.upsert({
      where: { householdId_dedupeKey: { householdId: input.householdId, dedupeKey: input.dedupeKey } },
      update: { status: "OPEN", title: data.title, description: data.description, data: data.data, resolvedAt: null, resolution: null },
      create: data,
    });
  }
  return db.pendingItem.create({ data });
}

/** Resolve itens abertos que satisfazem o filtro (ex.: ao categorizar uma transação). */
export async function resolvePendingWhere(
  db: Db,
  where: Prisma.PendingItemWhereInput & { householdId: string },
  resolution: string,
  memberId: string | null,
  status: Extract<PendingStatus, "RESOLVED" | "DISMISSED"> = "RESOLVED",
): Promise<number> {
  const res = await db.pendingItem.updateMany({
    where: { ...where, status: "OPEN" },
    data: { status, resolution: resolution.slice(0, 300), resolvedAt: new Date(), resolvedByMemberId: memberId },
  });
  return res.count;
}

export async function listPendingItems(
  ctx: ServiceContext,
  filters: { status?: PendingStatus; type?: PendingType; limit?: number; cursor?: string },
) {
  const limit = Math.min(filters.limit ?? 50, 200);
  const where: Prisma.PendingItemWhereInput = {
    householdId: ctx.householdId,
    status: filters.status ?? "OPEN",
    ...(filters.type ? { type: filters.type } : {}),
  };
  const rows = await prisma.pendingItem.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    include: {
      transaction: {
        select: {
          id: true,
          type: true,
          status: true,
          amountCents: true,
          description: true,
          date: true,
          categoryId: true,
          paymentMethod: true,
          accountId: true,
          creditCardId: true,
          installmentCount: true,
          deletedAt: true,
          confidenceScore: true,
          source: true,
        },
      },
      message: { select: { id: true, type: true, status: true, sentAt: true, statusDetail: true, senderMemberId: true } },
      attachment: { select: { id: true, kind: true, mimeType: true, contentDeletedAt: true } },
      importRow: { select: { id: true, batchId: true, date: true, amountCents: true, description: true, status: true, matchedTransactionId: true } },
    },
  });
  const relatedIds = rows.map((r) => r.relatedTransactionId).filter(Boolean) as string[];
  const related = relatedIds.length
    ? await prisma.transaction.findMany({
        where: { id: { in: relatedIds }, householdId: ctx.householdId },
        select: { id: true, amountCents: true, description: true, date: true, type: true, deletedAt: true, source: true },
      })
    : [];
  const relatedMap = new Map(related.map((r) => [r.id, r]));
  const items = rows.slice(0, limit).map((r) => ({ ...r, relatedTransaction: r.relatedTransactionId ? relatedMap.get(r.relatedTransactionId) ?? null : null }));
  return { items, nextCursor: rows.length > limit ? rows[limit]?.id ?? null : null };
}

export async function pendingCounts(ctx: ServiceContext) {
  const groups = await prisma.pendingItem.groupBy({
    by: ["type"],
    where: { householdId: ctx.householdId, status: "OPEN" },
    _count: { _all: true },
  });
  const byType: Record<string, number> = {};
  let total = 0;
  for (const g of groups) {
    byType[g.type] = g._count._all;
    total += g._count._all;
  }
  return { total, byType };
}

export async function setPendingStatus(ctx: ServiceContext, id: string, status: "RESOLVED" | "DISMISSED", resolution?: string) {
  const item = await prisma.pendingItem.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!item) throw new NotFoundError("Pendência");
  const updated = await prisma.pendingItem.update({
    where: { id },
    data: { status, resolution: resolution?.slice(0, 300) ?? (status === "DISMISSED" ? "Descartada" : "Resolvida"), resolvedAt: new Date(), resolvedByMemberId: ctx.memberId },
  });
  await publishEvent(ctx.householdId, "pending.changed", id);
  return updated;
}
