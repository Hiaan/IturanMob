import { prisma } from "../db";
import { hashToken, randomToken } from "../crypto";
import type { ServiceContext } from "./context";

export const SESSION_COOKIE = "fa_session";
export const SESSION_TTL_DAYS = 30;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

export interface SessionInfo {
  sessionId: string;
  ctx: ServiceContext;
  user: { id: string; name: string; email: string };
  member: { id: string; displayName: string; role: string; color: string };
  household: { id: string; name: string; timezone: string };
  expiresAt: Date;
}

export async function createSession(params: {
  userId: string;
  householdId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: params.userId,
      householdId: params.householdId,
      ip: params.ip?.slice(0, 64) ?? null,
      userAgent: params.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

/** Valida o token e monta o contexto. Retorna null para sessão inválida/expirada/revogada. */
export async function resolveSession(token: string | undefined | null): Promise<SessionInfo | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: { select: { id: true, name: true, email: true } },
      household: { select: { id: true, name: true, timezone: true } },
    },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  const member = await prisma.householdMember.findFirst({
    where: { householdId: session.householdId, userId: session.userId, isActive: true },
    select: { id: true, displayName: true, role: true, color: true, canViewOthersPrivate: true },
  });
  if (!member) return null;

  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    // Sessão deslizante: renova a validade com uso.
    await prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000) },
      })
      .catch(() => undefined);
  }

  return {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    user: session.user,
    member: { id: member.id, displayName: member.displayName, role: member.role, color: member.color },
    household: session.household,
    ctx: {
      householdId: session.householdId,
      memberId: member.id,
      userId: session.userId,
      role: member.role,
      actorType: "USER",
      timezone: session.household.timezone,
      canViewOthersPrivate: member.canViewOthersPrivate,
    },
  };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.session.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllUserSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const res = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

export async function purgeExpiredSessions(): Promise<number> {
  const res = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } }] },
  });
  return res.count;
}
