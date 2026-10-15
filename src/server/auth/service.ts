import { z } from "zod";
import { prisma } from "../db";
import { hashPassword, passwordPolicyError, verifyPassword } from "../crypto";
import { UnauthorizedError, ValidationError } from "../errors";
import { enforceRateLimit } from "../rate-limit";
import { env } from "../env";
import { createSession, revokeAllUserSessions } from "./session";
import type { ServiceContext } from "./context";
import { audit } from "../modules/audit/service";

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

const LOCK_AFTER_FAILURES = 8;
const LOCK_MINUTES = 15;
// Hash fictício para equalizar o tempo de resposta quando o usuário não existe.
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$7fJ2kq3m7Zl1lQ1mJ6p0cB8v9mXq3S2Tq0l3jYb8m5N4mQmS3o0WcFq5sY2x7m2b3jYb8m5N4mQmS3o0WcFq5Q==";

export async function login(input: z.infer<typeof loginSchema>, meta: { ip?: string | null; userAgent?: string | null }) {
  const data = loginSchema.parse(input);
  await enforceRateLimit(`login:ip:${meta.ip ?? "unknown"}`, env().RATE_LIMIT_LOGIN_PER_15MIN * 3, 15 * 60);
  await enforceRateLimit(`login:email:${data.email}`, env().RATE_LIMIT_LOGIN_PER_15MIN, 15 * 60);

  const user = await prisma.user.findUnique({ where: { email: data.email } });
  if (!user) {
    await verifyPassword(data.password, DUMMY_HASH).catch(() => false);
    throw new UnauthorizedError("E-mail ou senha incorretos.");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new UnauthorizedError("Conta temporariamente bloqueada por excesso de tentativas. Tente novamente mais tarde.");
  }
  const ok = await verifyPassword(data.password, user.passwordHash);
  const member = await prisma.householdMember.findFirst({
    where: { userId: user.id, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!ok) {
    const failures = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failures,
        lockedUntil: failures >= LOCK_AFTER_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    if (member) {
      await prisma.auditLog.create({
        data: { householdId: member.householdId, actorType: "USER", actorMemberId: member.id, action: "LOGIN_FAILED", entityType: "User", entityId: user.id, ip: meta.ip ?? null },
      });
    }
    throw new UnauthorizedError("E-mail ou senha incorretos.");
  }
  if (!member) throw new UnauthorizedError("Seu acesso a esta família foi desativado.");

  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const session = await createSession({ userId: user.id, householdId: member.householdId, ip: meta.ip, userAgent: meta.userAgent });
  await prisma.auditLog.create({
    data: { householdId: member.householdId, actorType: "USER", actorMemberId: member.id, action: "LOGIN", entityType: "User", entityId: user.id, ip: meta.ip ?? null },
  });
  return { ...session, user: { id: user.id, name: user.name, email: user.email } };
}

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

export async function changePassword(ctx: ServiceContext, sessionId: string, input: z.infer<typeof changePasswordSchema>) {
  const data = changePasswordSchema.parse(input);
  if (!ctx.userId) throw new UnauthorizedError();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (!(await verifyPassword(data.currentPassword, user.passwordHash))) {
    throw new ValidationError("A senha atual está incorreta.", { field: "currentPassword" });
  }
  const pwError = passwordPolicyError(data.newPassword);
  if (pwError) throw new ValidationError(pwError, { field: "newPassword" });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(data.newPassword) } });
  const revoked = await revokeAllUserSessions(user.id, sessionId);
  await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "User", entityId: user.id, metadata: { passwordChanged: true, sessionsRevoked: revoked } });
  return { sessionsRevoked: revoked };
}

export async function listUserSessions(ctx: ServiceContext, currentSessionId: string) {
  if (!ctx.userId) return [];
  const sessions = await prisma.session.findMany({
    where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true },
  });
  return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
}

export async function revokeUserSession(ctx: ServiceContext, sessionId: string) {
  if (!ctx.userId) throw new UnauthorizedError();
  await prisma.session.updateMany({ where: { id: sessionId, userId: ctx.userId }, data: { revokedAt: new Date() } });
}
