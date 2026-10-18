import { z } from "zod";
import type { MemberRole, NotificationType } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { hashPassword, hashToken, passwordPolicyError, randomToken } from "../../crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../errors";
import { seedDefaultCategories } from "../categories/seed";
import { audit } from "../audit/service";
import { env } from "../../env";
import { normalizePhoneInput } from "@/lib/phone";

export const MEMBER_COLORS = ["#0f766e", "#1d4ed8", "#be185d", "#7c3aed", "#c2410c", "#0369a1", "#4d7c0f"];

const DEFAULT_NOTIFICATION_PREFS: Array<{ type: NotificationType; inApp: boolean; whatsapp: boolean }> = [
  { type: "TRANSACTION_CREATED", inApp: false, whatsapp: false },
  { type: "INCOME_CREATED", inApp: false, whatsapp: false },
  { type: "CONFIRMATION_REQUIRED", inApp: true, whatsapp: true },
  { type: "BUDGET_THRESHOLD", inApp: true, whatsapp: true },
  { type: "BILL_DUE", inApp: true, whatsapp: true },
  { type: "STATEMENT_AVAILABLE", inApp: true, whatsapp: false },
  { type: "WEEKLY_REPORT", inApp: true, whatsapp: false },
  { type: "MONTHLY_REPORT", inApp: true, whatsapp: false },
  { type: "WHATSAPP_CONNECTION_FAILED", inApp: true, whatsapp: false },
];

export async function seedNotificationPreferences(db: Db, memberId: string) {
  for (const pref of DEFAULT_NOTIFICATION_PREFS) {
    await db.notificationPreference.upsert({
      where: { memberId_type: { memberId, type: pref.type } },
      update: {},
      create: { memberId, type: pref.type, inApp: pref.inApp, whatsapp: pref.whatsapp },
    });
  }
}

export const registerSchema = z.object({
  householdName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  relation: z.string().trim().max(40).optional(),
  timezone: z.string().max(64).optional(),
});

export async function isFirstRun(): Promise<boolean> {
  // Contas de demonstração (seed opcional, domínio reservado .invalid) não contam: não bloqueiam o primeiro cadastro real.
  return (await prisma.user.count({ where: { NOT: { email: { endsWith: "@demo.invalid" } } } })) === 0;
}

export async function registrationOpen(): Promise<boolean> {
  return env().ALLOW_REGISTRATION || (await isFirstRun());
}

/** Cria uma nova família com o usuário proprietário e os dados iniciais (categorias, preferências). */
export async function registerHousehold(input: z.infer<typeof registerSchema>) {
  const data = registerSchema.parse(input);
  const pwError = passwordPolicyError(data.password);
  if (pwError) throw new ValidationError(pwError, { field: "password" });
  if (!(await registrationOpen())) throw new ForbiddenError("O cadastro público está desativado. Peça um convite.");
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new ConflictError("Já existe uma conta com este e-mail.");
  const passwordHash = await hashPassword(data.password);
  const tz = data.timezone && isValidTimezone(data.timezone) ? data.timezone : env().DEFAULT_TIMEZONE;

  return withTransaction(async (db) => {
    const user = await db.user.create({ data: { email: data.email, name: data.name, passwordHash } });
    const household = await db.household.create({ data: { name: data.householdName, timezone: tz } });
    await db.householdSettings.create({ data: { householdId: household.id } });
    const member = await db.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        displayName: data.name,
        relation: data.relation ?? null,
        role: "OWNER",
        color: MEMBER_COLORS[0]!,
      },
    });
    await seedDefaultCategories(db, household.id);
    await seedNotificationPreferences(db, member.id);
    await db.reportSchedule.createMany({
      data: [
        { householdId: household.id, type: "WEEKLY", dayOfWeek: 1, hour: 8 },
        { householdId: household.id, type: "MONTHLY", dayOfMonth: 1, hour: 8 },
      ],
    });
    await db.auditLog.create({
      data: {
        householdId: household.id,
        actorType: "USER",
        actorMemberId: member.id,
        action: "CREATE",
        entityType: "Household",
        entityId: household.id,
      },
    });
    return { user, household, member };
  });
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Família e configurações
// -----------------------------------------------------------------------------

export async function getHousehold(ctx: ServiceContext) {
  const household = await prisma.household.findUnique({
    where: { id: ctx.householdId },
    include: { settings: true },
  });
  if (!household) throw new NotFoundError("Família");
  if (!household.settings) {
    household.settings = await prisma.householdSettings.create({ data: { householdId: household.id } });
  }
  return household;
}

export const householdUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  timezone: z.string().max(64).refine(isValidTimezone, "Fuso horário inválido").optional(),
});

export const settingsUpdateSchema = z
  .object({
    defaultRegime: z.enum(["ACCRUAL", "CASH"]),
    confidenceHigh: z.number().min(0.5).max(1),
    confidenceMedium: z.number().min(0.1).max(1),
    budgetAlertThresholds: z.array(z.number().int().min(1).max(200)).max(8),
    mediaRetentionDays: z.number().int().min(0).max(3650),
    transcriptRetentionDays: z.number().int().min(0).max(3650),
    aiExternalAllowed: z.boolean(),
    aiAudioAllowed: z.boolean(),
    aiImageAllowed: z.boolean(),
    duplicateWindowHours: z.number().int().min(1).max(24 * 30),
    whatsappReplies: z.boolean(),
    whatsappAnswerQueries: z.boolean(),
    /** Recorte padrão (painel, relatórios, orçamentos, assistente): Pessoal, Empresa ou Tudo. */
    defaultReportScope: z.enum(["PERSONAL", "BUSINESS", "ALL"]),
    /** Grupo do WhatsApp sem natureza + mensagem sem indicação: perguntar PF/Empresa ou usar o padrão. */
    whatsappUnassignedNature: z.enum(["ASK", "FAMILY_DEFAULT"]),
  })
  .partial();

export async function updateHousehold(ctx: ServiceContext, input: z.infer<typeof householdUpdateSchema>) {
  assertCan(ctx, "settings:manage");
  const data = householdUpdateSchema.parse(input);
  const before = await getHousehold(ctx);
  const updated = await prisma.household.update({ where: { id: ctx.householdId }, data });
  await audit(ctx, {
    action: "SETTINGS_CHANGE",
    entityType: "Household",
    entityId: ctx.householdId,
    before: { name: before.name, timezone: before.timezone },
    after: { name: updated.name, timezone: updated.timezone },
  });
  return updated;
}

export async function updateSettings(ctx: ServiceContext, input: z.infer<typeof settingsUpdateSchema>) {
  assertCan(ctx, "settings:manage");
  const data = settingsUpdateSchema.parse(input);
  const current = (await getHousehold(ctx)).settings!;
  const high = data.confidenceHigh ?? current.confidenceHigh;
  const medium = data.confidenceMedium ?? current.confidenceMedium;
  if (medium > high) throw new ValidationError("A confiança média não pode ser maior que a confiança alta.");
  if (data.budgetAlertThresholds) {
    data.budgetAlertThresholds = [...new Set(data.budgetAlertThresholds)].sort((a, b) => a - b);
  }
  if (data.aiExternalAllowed === false) {
    data.aiAudioAllowed = false;
    data.aiImageAllowed = false;
  }
  const updated = await prisma.householdSettings.update({ where: { householdId: ctx.householdId }, data });
  await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "HouseholdSettings", entityId: ctx.householdId, before: current, after: updated });
  return updated;
}

export async function getSettings(householdId: string, db: Db = prisma) {
  const settings = await db.householdSettings.findUnique({ where: { householdId } });
  return settings ?? db.householdSettings.create({ data: { householdId } });
}

// -----------------------------------------------------------------------------
// Membros
// -----------------------------------------------------------------------------

export async function listMembers(ctx: ServiceContext) {
  const members = await prisma.householdMember.findMany({
    where: { householdId: ctx.householdId },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    include: { user: { select: { email: true, lastLoginAt: true } } },
  });
  return members.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    relation: m.relation,
    role: m.role,
    color: m.color,
    isActive: m.isActive,
    hasLogin: Boolean(m.userId),
    email: m.user?.email ?? null,
    lastLoginAt: m.user?.lastLoginAt ?? null,
    canViewOthersPrivate: m.canViewOthersPrivate,
    whatsappPhone: m.whatsappPhone,
    whatsappAuthorized: m.whatsappAuthorized,
    whatsappConsentAt: m.whatsappConsentAt,
    isMe: m.id === ctx.memberId,
  }));
}

export const memberCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  relation: z.string().trim().max(40).optional().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

/** Cria um membro sem login (ex.: filho/dependente) para atribuição de despesas. */
export async function createDependentMember(ctx: ServiceContext, input: z.infer<typeof memberCreateSchema>) {
  assertCan(ctx, "members:manage");
  const data = memberCreateSchema.parse(input);
  const count = await prisma.householdMember.count({ where: { householdId: ctx.householdId } });
  const member = await prisma.householdMember.create({
    data: {
      householdId: ctx.householdId,
      displayName: data.displayName,
      relation: data.relation ?? null,
      role: "VIEWER",
      color: data.color ?? MEMBER_COLORS[count % MEMBER_COLORS.length]!,
    },
  });
  await audit(ctx, { action: "CREATE", entityType: "HouseholdMember", entityId: member.id, after: { displayName: member.displayName } });
  return member;
}

export const memberUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    relation: z.string().trim().max(40).nullable(),
    role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    canViewOthersPrivate: z.boolean(),
    whatsappPhone: z
      .string()
      .trim()
      .refine((v) => normalizePhoneInput(v) !== null, "Informe DDD + número, ex.: (81) 99999-9999. Para números de fora do Brasil, comece com + e o DDI.")
      .nullable(),
    whatsappAuthorized: z.boolean(),
    whatsappConsent: z.boolean(),
    isActive: z.boolean(),
  })
  .partial();

/** Telefone do membro em E.164; números brasileiros sem DDI recebem +55 (ver normalizePhoneInput). */
export function normalizePhone(phone: string): string {
  const normalized = normalizePhoneInput(phone);
  if (!normalized) throw new ValidationError("Informe DDD + número, ex.: (81) 99999-9999. Para números de fora do Brasil, comece com + e o DDI.", { field: "whatsappPhone" });
  return normalized;
}

export async function updateMember(ctx: ServiceContext, memberId: string, input: z.infer<typeof memberUpdateSchema>) {
  const data = memberUpdateSchema.parse(input);
  const isSelf = memberId === ctx.memberId;
  const touchesAdminFields =
    data.role !== undefined || data.canViewOthersPrivate !== undefined || data.isActive !== undefined || data.whatsappAuthorized !== undefined;
  if (!isSelf || touchesAdminFields) assertCan(ctx, "members:manage");
  const member = await prisma.householdMember.findFirst({ where: { id: memberId, householdId: ctx.householdId } });
  if (!member) throw new NotFoundError("Membro");
  if (data.role && data.role !== member.role) {
    if (member.role === "OWNER" || data.role === "OWNER") {
      if (ctx.role !== "OWNER") throw new ForbiddenError("Apenas o proprietário pode transferir a propriedade.");
    }
    if (member.role === "OWNER" && data.role !== "OWNER") {
      const owners = await prisma.householdMember.count({ where: { householdId: ctx.householdId, role: "OWNER", isActive: true } });
      if (owners <= 1) throw new ValidationError("A família precisa de pelo menos um proprietário.");
    }
  }
  if (data.isActive === false && member.role === "OWNER") throw new ValidationError("Não é possível desativar o proprietário.");
  // O consentimento só pode ser dado pelo próprio participante (ou por quem administra um dependente sem login).
  if (data.whatsappConsent !== undefined && !isSelf && member.userId) {
    throw new ForbiddenError("O consentimento para processamento de mensagens deve ser dado pelo próprio participante.");
  }
  const { whatsappConsent, ...rest } = data;
  const updated = await prisma.householdMember.update({
    where: { id: memberId },
    data: {
      ...rest,
      whatsappPhone: rest.whatsappPhone === undefined ? undefined : rest.whatsappPhone ? normalizePhone(rest.whatsappPhone) : null,
      ...(rest.whatsappPhone !== undefined && rest.whatsappPhone !== member.whatsappPhone ? { whatsappJid: null, whatsappLid: null } : {}),
      ...(whatsappConsent === undefined ? {} : { whatsappConsentAt: whatsappConsent ? new Date() : null }),
    },
  });
  await audit(ctx, {
    action: "UPDATE",
    entityType: "HouseholdMember",
    entityId: memberId,
    before: { ...member, whatsappJid: undefined, whatsappLid: undefined },
    after: { ...updated, whatsappJid: undefined, whatsappLid: undefined },
  });
  return updated;
}

// -----------------------------------------------------------------------------
// Convites
// -----------------------------------------------------------------------------

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
  memberId: z.string().optional().nullable(),
});

export async function createInvitation(ctx: ServiceContext, input: z.infer<typeof inviteSchema>) {
  assertCan(ctx, "members:manage");
  const data = inviteSchema.parse(input);
  if (data.memberId) {
    const m = await prisma.householdMember.findFirst({ where: { id: data.memberId, householdId: ctx.householdId, userId: null } });
    if (!m) throw new ValidationError("Membro inválido para vinculação.");
  }
  const token = randomToken(24);
  const invitation = await prisma.invitation.create({
    data: {
      householdId: ctx.householdId,
      email: data.email,
      role: data.role as MemberRole,
      memberId: data.memberId ?? null,
      tokenHash: hashToken(token),
      invitedById: ctx.memberId ?? "system",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  await audit(ctx, { action: "CREATE", entityType: "Invitation", entityId: invitation.id, after: { email: data.email, role: data.role } });
  return { invitation, url: `${env().APP_URL}/convite/${token}` };
}

export async function listInvitations(ctx: ServiceContext) {
  return prisma.invitation.findMany({
    where: { householdId: ctx.householdId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
}

export async function revokeInvitation(ctx: ServiceContext, id: string) {
  assertCan(ctx, "members:manage");
  const res = await prisma.invitation.updateMany({ where: { id, householdId: ctx.householdId }, data: { revokedAt: new Date() } });
  if (!res.count) throw new NotFoundError("Convite");
}

export async function getInvitationByToken(token: string) {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { household: { select: { name: true } } } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) return null;
  return inv;
}

export const acceptInviteSchema = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(1).max(200),
  relation: z.string().trim().max(40).optional(),
});

export async function acceptInvitation(input: z.infer<typeof acceptInviteSchema>) {
  const data = acceptInviteSchema.parse(input);
  const inv = await getInvitationByToken(data.token);
  if (!inv) throw new NotFoundError("Convite");
  const pwError = passwordPolicyError(data.password);
  if (pwError) throw new ValidationError(pwError, { field: "password" });
  const exists = await prisma.user.findUnique({ where: { email: inv.email } });
  if (exists) throw new ConflictError("Já existe uma conta com este e-mail. Faça login para continuar.");
  const passwordHash = await hashPassword(data.password);
  return withTransaction(async (db) => {
    const user = await db.user.create({ data: { email: inv.email, name: data.name, passwordHash } });
    let memberId: string;
    if (inv.memberId) {
      const m = await db.householdMember.update({
        where: { id: inv.memberId },
        data: { userId: user.id, role: inv.role, displayName: data.name, relation: data.relation ?? undefined },
      });
      memberId = m.id;
    } else {
      const count = await db.householdMember.count({ where: { householdId: inv.householdId } });
      const m = await db.householdMember.create({
        data: {
          householdId: inv.householdId,
          userId: user.id,
          displayName: data.name,
          relation: data.relation ?? null,
          role: inv.role,
          color: MEMBER_COLORS[count % MEMBER_COLORS.length]!,
        },
      });
      memberId = m.id;
    }
    await seedNotificationPreferences(db, memberId);
    await db.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
    await db.auditLog.create({
      data: { householdId: inv.householdId, actorType: "USER", actorMemberId: memberId, action: "CREATE", entityType: "HouseholdMember", entityId: memberId, metadata: { via: "invitation" } },
    });
    return { user, householdId: inv.householdId, memberId };
  });
}
