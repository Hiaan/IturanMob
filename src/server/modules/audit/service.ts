import type { AuditAction, Prisma } from "@prisma/client";
import type { Db } from "../../db";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Calcula apenas os campos alterados entre dois snapshots. */
export function diffSnapshots(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return null;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = JSON.stringify(before[k] ?? null);
    const b = JSON.stringify(after[k] ?? null);
    if (a !== b) changes[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return changes;
}

/** Registra um evento de auditoria (na mesma transação de banco, quando informada). */
export async function audit(ctx: ServiceContext, input: AuditInput, db: Db = prisma): Promise<void> {
  const before = input.before as Record<string, unknown> | undefined;
  const after = input.after as Record<string, unknown> | undefined;
  const changes = input.action === "UPDATE" || input.action === "RECLASSIFY" ? diffSnapshots(before ?? null, after ?? null) : null;
  await db.auditLog.create({
    data: {
      householdId: ctx.householdId,
      actorType: ctx.actorType,
      actorMemberId: ctx.memberId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: toJson(before),
      after: toJson(after),
      source: input.source ?? null,
      ip: ctx.ip ?? null,
      metadata: toJson(changes ? { ...(input.metadata ?? {}), changes } : input.metadata),
    },
  });
}

export async function listAuditLogs(
  ctx: ServiceContext,
  filters: { entityType?: string; entityId?: string; limit?: number; cursor?: string },
) {
  const limit = Math.min(filters.limit ?? 50, 200);
  const rows = await prisma.auditLog.findMany({
    where: {
      householdId: ctx.householdId,
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
  });
  const actorIds = [...new Set(rows.map((r) => r.actorMemberId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await prisma.householdMember.findMany({ where: { id: { in: actorIds }, householdId: ctx.householdId }, select: { id: true, displayName: true } })
    : [];
  const names = new Map(actors.map((a) => [a.id, a.displayName]));
  const items = rows.slice(0, limit).map((r) => ({ ...r, actorName: r.actorMemberId ? names.get(r.actorMemberId) ?? null : null }));
  return { items, nextCursor: rows.length > limit ? rows[limit]?.id ?? null : null };
}
