import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { hashToken, randomToken } from "../../crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "../../errors";
import { env } from "../../env";
import { audit } from "../audit/service";

/**
 * Convite para criar uma NOVA família (outra conta, dados totalmente separados) sem abrir o cadastro
 * público (ALLOW_REGISTRATION continua false). Só o administrador da instância gera; o link vale
 * 7 dias e serve para UM cadastro. O token só aparece uma vez (no banco fica o hash).
 */

export const INVITE_TTL_DAYS = 7;
/** Convites ativos ao mesmo tempo (evita links soltos demais). */
const MAX_ACTIVE = 10;

function adminEmails(): string[] {
  return env()
    .INSTANCE_ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Administrador da instância: os e-mails de INSTANCE_ADMIN_EMAILS; sem a variável, o proprietário
 * (OWNER ativo) da primeira família criada (contas de demonstração não contam).
 */
export async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return false;
  const emails = adminEmails();
  if (emails.length) return emails.includes(user.email.toLowerCase());
  const first = await prisma.household.findFirst({
    where: { members: { some: { role: "OWNER", user: { NOT: { email: { endsWith: "@demo.invalid" } } } } } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!first) return false;
  return Boolean(await prisma.householdMember.findFirst({ where: { householdId: first.id, userId, role: "OWNER", isActive: true }, select: { id: true } }));
}

async function assertInstanceAdmin(ctx: ServiceContext) {
  if (!(await isInstanceAdmin(ctx.userId))) throw new ForbiddenError("Só o administrador desta instalação pode convidar uma nova família.");
}

export const householdInviteSchema = z.object({
  /** Só para você lembrar para quem é ("Família do Ícaro"). */
  label: z.string().trim().max(80).nullish(),
});

type InviteRow = Prisma.HouseholdInviteGetPayload<object>;

function status(i: InviteRow, now = new Date()): "ACTIVE" | "USED" | "EXPIRED" | "REVOKED" {
  if (i.usedAt) return "USED";
  if (i.revokedAt) return "REVOKED";
  if (i.expiresAt <= now) return "EXPIRED";
  return "ACTIVE";
}

async function dto(rows: InviteRow[]) {
  const ids = rows.map((r) => r.createdHouseholdId).filter((x): x is string => Boolean(x));
  const households = ids.length ? await prisma.household.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = new Map(households.map((h) => [h.id, h.name]));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    status: status(r),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt,
    revokedAt: r.revokedAt,
    /** Nome da família criada com o convite (só o nome; nenhum dado dela). */
    createdHouseholdName: r.createdHouseholdId ? (names.get(r.createdHouseholdId) ?? null) : null,
  }));
}

/** Gera o link de uso único. O token só é devolvido aqui (não dá para recuperar depois). */
export async function createHouseholdInvite(ctx: ServiceContext, input: z.input<typeof householdInviteSchema> = {}) {
  await assertInstanceAdmin(ctx);
  const data = householdInviteSchema.parse(input);
  const now = new Date();
  const active = await prisma.householdInvite.count({ where: { usedAt: null, revokedAt: null, expiresAt: { gt: now } } });
  if (active >= MAX_ACTIVE) throw new ValidationError(`Já há ${MAX_ACTIVE} convites ativos. Revogue algum antes de gerar outro.`);
  const token = randomToken(32);
  const row = await prisma.householdInvite.create({
    data: {
      tokenHash: hashToken(token),
      label: data.label || null,
      createdByUserId: ctx.userId!,
      createdFromHouseholdId: ctx.householdId,
      expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000),
    },
  });
  await audit(ctx, { action: "CREATE", entityType: "HouseholdInvite", entityId: row.id, after: { label: row.label, expiresAt: row.expiresAt } });
  const [item] = await dto([row]);
  return { ...item!, url: `${env().APP_URL}/cadastro?convite=${encodeURIComponent(token)}` };
}

/** Lista para a tela (quem não é administrador recebe `canInvite: false` e nenhuma linha). */
export async function listHouseholdInvites(ctx: ServiceContext) {
  if (!(await isInstanceAdmin(ctx.userId))) return { canInvite: false, ttlDays: INVITE_TTL_DAYS, items: [] };
  const rows = await prisma.householdInvite.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return { canInvite: true, ttlDays: INVITE_TTL_DAYS, items: await dto(rows) };
}

export async function revokeHouseholdInvite(ctx: ServiceContext, id: string) {
  await assertInstanceAdmin(ctx);
  const row = await prisma.householdInvite.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("Convite");
  if (row.usedAt) throw new ValidationError("Este convite já foi usado: a família criada com ele continua existindo.");
  if (!row.revokedAt) {
    await prisma.householdInvite.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(ctx, { action: "UPDATE", entityType: "HouseholdInvite", entityId: id, before: { revokedAt: null }, after: { revokedAt: new Date() } });
  }
  const [item] = await dto([(await prisma.householdInvite.findUnique({ where: { id } }))!]);
  return item!;
}

/** Situação pública do convite (para a tela de cadastro). Não revela quem convidou. */
export async function householdInviteStatus(token: string | null | undefined): Promise<{ valid: boolean; reason: "INVALID" | "USED" | "EXPIRED" | "REVOKED" | null; expiresAt: Date | null }> {
  if (!token || token.length < 20 || token.length > 200) return { valid: false, reason: "INVALID", expiresAt: null };
  const row = await prisma.householdInvite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return { valid: false, reason: "INVALID", expiresAt: null };
  const s = status(row);
  return { valid: s === "ACTIVE", reason: s === "ACTIVE" ? null : s, expiresAt: row.expiresAt };
}

/**
 * Consome o convite dentro da transação do cadastro: só uma família pode ser criada com ele, mesmo
 * com dois cadastros ao mesmo tempo (o UPDATE condicional só acerta uma vez).
 */
export async function claimHouseholdInvite(db: Prisma.TransactionClient, token: string): Promise<string> {
  const now = new Date();
  const tokenHash = hashToken(token);
  const res = await db.householdInvite.updateMany({ where: { tokenHash, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (res.count !== 1) throw new ForbiddenError("Convite inválido, expirado ou já usado. Peça um novo link a quem enviou o convite.");
  const row = await db.householdInvite.findUniqueOrThrow({ where: { tokenHash }, select: { id: true } });
  return row.id;
}
