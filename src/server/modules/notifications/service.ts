import { z } from "zod";
import { Prisma, type NotificationFrequency, type NotificationPreference, type NotificationType } from "@prisma/client";
import { prisma, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/labels";
import { audit } from "../audit/service";
import { seedNotificationPreferences } from "../households/service";

/**
 * CONTRATO — emissão de notificações.
 * Respeita preferências por membro (canal, frequência, horário silencioso) e deduplica por `dedupeKey`.
 * Mensagens devem ser informativas e neutras (sem linguagem alarmista ou julgamentos).
 */
export interface NotifyInput {
  householdId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  /** Evita notificações repetidas para o mesmo evento. */
  dedupeKey?: string;
  /** Destinatários; padrão = membros ativos com login. */
  recipientMemberIds?: string[];
}

export const NOTIFICATION_TYPES = [
  "TRANSACTION_CREATED",
  "INCOME_CREATED",
  "CONFIRMATION_REQUIRED",
  "BUDGET_THRESHOLD",
  "BILL_DUE",
  "STATEMENT_AVAILABLE",
  "WEEKLY_REPORT",
  "MONTHLY_REPORT",
  "WHATSAPP_CONNECTION_FAILED",
  "SYSTEM",
  "INCOME_GOAL",
  "GOAL_PROGRESS",
  "BILL_OVERDUE",
  "STATEMENT_DUE",
  "CASH_SHORTFALL",
  "SUBSCRIPTION_FOUND",
  "BANK_SYNC",
  "APPOINTMENT_REMINDER",
  "MORNING_SUMMARY",
] as const satisfies readonly NotificationType[];

export const NOTIFICATION_FREQUENCIES = ["IMMEDIATE", "DAILY_DIGEST", "OFF"] as const satisfies readonly NotificationFrequency[];

/** Máximo de notificações imediatas no grupo do WhatsApp por família, por hora. */
export const WHATSAPP_HOURLY_LIMIT = 6;

/** Hora local (fuso da família) a partir da qual o resumo diário é montado. */
export const DIGEST_HOUR = 19;

/**
 * Marcador opcional em `data`: `{ inAppOnly: true }` impede o envio ao grupo do WhatsApp
 * (ex.: eventos de contas/cartões privados, que não devem ser expostos ao grupo compartilhado).
 */
export const IN_APP_ONLY_FLAG = "inAppOnly";

/** Forma de entrega das notificações de WhatsApp (gravada em `data.delivery`). */
export type WhatsAppDelivery = "IMMEDIATE" | "DIGEST";

const HOUR_MS = 3_600_000;

type PrefShape = Pick<NotificationPreference, "memberId" | "type" | "inApp" | "whatsapp" | "email" | "push" | "frequency" | "quietStart" | "quietEnd">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function isInAppOnly(data: unknown): boolean {
  return isPlainObject(data) && data[IN_APP_ONLY_FLAG] === true;
}

/** Filtro Prisma para notificações de WhatsApp por forma de entrega. */
export function whatsappDeliveryWhere(delivery: WhatsAppDelivery): Prisma.NotificationWhereInput {
  return { channel: "WHATSAPP", data: { path: ["delivery"], equals: delivery } };
}

// -----------------------------------------------------------------------------
// Preferências
// -----------------------------------------------------------------------------

/** Garante que o membro tenha uma preferência para cada tipo de notificação (padrões do cadastro). */
export async function ensureMemberPreferences(db: Db, memberId: string): Promise<void> {
  try {
    await seedNotificationPreferences(db, memberId);
    await db.notificationPreference.upsert({
      where: { memberId_type: { memberId, type: "SYSTEM" } },
      update: {},
      create: { memberId, type: "SYSTEM", inApp: true, whatsapp: false },
    });
  } catch (err) {
    // Criação concorrente das mesmas preferências: o resultado final é o mesmo.
    if (!isUniqueViolation(err)) throw err;
  }
}

async function loadPreferences(memberIds: string[], type: NotificationType): Promise<Map<string, PrefShape>> {
  let rows = await prisma.notificationPreference.findMany({ where: { memberId: { in: memberIds }, type } });
  const missing = memberIds.filter((id) => !rows.some((r) => r.memberId === id));
  if (missing.length) {
    for (const id of missing) await ensureMemberPreferences(prisma, id);
    rows = await prisma.notificationPreference.findMany({ where: { memberId: { in: memberIds }, type } });
  }
  const map = new Map<string, PrefShape>();
  for (const id of memberIds) {
    const row = rows.find((r) => r.memberId === id);
    map.set(id, row ?? { memberId: id, type, inApp: true, whatsapp: false, email: false, push: true, frequency: "IMMEDIATE", quietStart: null, quietEnd: null });
  }
  return map;
}

async function resolveRecipients(householdId: string, ids: string[] | undefined): Promise<string[]> {
  if (ids && ids.length === 0) return [];
  const members = await prisma.householdMember.findMany({
    where: { householdId, isActive: true, userId: { not: null }, ...(ids ? { id: { in: [...new Set(ids)] } } : {}) },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return members.map((m) => m.id);
}

// -----------------------------------------------------------------------------
// Emissão
// -----------------------------------------------------------------------------

/**
 * Emite uma notificação conforme as preferências dos destinatários.
 *
 * - IN_APP: uma notificação por destinatário (status SENT).
 * - WHATSAPP: UMA notificação por evento (sem destinatário, status PENDING), pois o grupo é
 *   compartilhado; somente se algum destinatário quer WhatsApp. Frequência DAILY_DIGEST de todos
 *   os interessados → entra no resumo diário. Acima de {@link WHATSAPP_HOURLY_LIMIT} por hora →
 *   SKIPPED (continua disponível no aplicativo).
 * - Frequência OFF desativa o tipo para o membro.
 * - `dedupeKey` gera chaves derivadas por canal/destinatário (`<chave>:in:<membro>`, `<chave>:wa`).
 */
export async function notify(input: NotifyInput): Promise<{ created: number }> {
  const recipients = await resolveRecipients(input.householdId, input.recipientMemberIds);
  if (!recipients.length) return { created: 0 };
  const prefs = await loadPreferences(recipients, input.type);
  const now = new Date();
  const title = input.title.trim().slice(0, 200);
  const body = input.body.trim().slice(0, 2000);
  let created = 0;

  const inAppRecipients = recipients.filter((id) => {
    const p = prefs.get(id)!;
    return p.frequency !== "OFF" && p.inApp;
  });
  if (inAppRecipients.length) {
    const res = await prisma.notification.createMany({
      data: inAppRecipients.map((memberId) => ({
        householdId: input.householdId,
        recipientMemberId: memberId,
        type: input.type,
        channel: "IN_APP" as const,
        status: "SENT" as const,
        sentAt: now,
        title,
        body,
        data: input.data ?? undefined,
        dedupeKey: input.dedupeKey ? `${input.dedupeKey}:in:${memberId}` : null,
      })),
      skipDuplicates: true,
    });
    created += res.count;
  }

  // Push: uma notificação por destinatário com aparelho inscrito (enviada pelo despachante, que
  // respeita o horário silencioso). Resumo diário não vira push.
  const pushRecipients = recipients.filter((id) => {
    const p = prefs.get(id)!;
    return p.frequency === "IMMEDIATE" && p.push;
  });
  if (pushRecipients.length) {
    const withDevices = await prisma.pushSubscription.findMany({ where: { memberId: { in: pushRecipients } }, select: { memberId: true }, distinct: ["memberId"] });
    if (withDevices.length) {
      const res = await prisma.notification.createMany({
        data: withDevices.map(({ memberId }) => ({
          householdId: input.householdId,
          recipientMemberId: memberId,
          type: input.type,
          channel: "PUSH" as const,
          status: "PENDING" as const,
          title,
          body,
          data: input.data ?? undefined,
          dedupeKey: input.dedupeKey ? `${input.dedupeKey}:push:${memberId}` : null,
        })),
        skipDuplicates: true,
      });
      created += res.count;
    }
  }

  const whatsappPrefs = recipients.map((id) => prefs.get(id)!).filter((p) => p.frequency !== "OFF" && p.whatsapp);
  if (whatsappPrefs.length && !isInAppOnly(input.data)) {
    const key = input.dedupeKey ? `${input.dedupeKey}:wa` : null;
    const already = key ? await prisma.notification.findUnique({ where: { householdId_dedupeKey: { householdId: input.householdId, dedupeKey: key } }, select: { id: true } }) : null;
    if (!already) {
      const delivery: WhatsAppDelivery = whatsappPrefs.some((p) => p.frequency === "IMMEDIATE") ? "IMMEDIATE" : "DIGEST";
      let status: "PENDING" | "SKIPPED" = "PENDING";
      let error: string | null = null;
      if (delivery === "IMMEDIATE") {
        const lastHour = await prisma.notification.count({
          where: {
            householdId: input.householdId,
            ...whatsappDeliveryWhere("IMMEDIATE"),
            status: { in: ["PENDING", "SENT"] },
            createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
          },
        });
        if (lastHour >= WHATSAPP_HOURLY_LIMIT) {
          status = "SKIPPED";
          error = `Limite de ${WHATSAPP_HOURLY_LIMIT} mensagens por hora no grupo atingido. A notificação continua disponível no aplicativo.`;
        }
      }
      const data: Prisma.InputJsonObject = {
        ...(isPlainObject(input.data) ? (input.data as Prisma.InputJsonObject) : input.data !== undefined ? { payload: input.data } : {}),
        delivery,
      };
      try {
        await prisma.notification.create({
          data: {
            householdId: input.householdId,
            recipientMemberId: null,
            type: input.type,
            channel: "WHATSAPP",
            status,
            error,
            title,
            body,
            data,
            dedupeKey: key,
          },
        });
        created++;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  if (created) await publishEvent(input.householdId, "notification.created");
  return { created };
}

// -----------------------------------------------------------------------------
// Caixa de entrada (in-app)
// -----------------------------------------------------------------------------

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  typeLabel: string;
  title: string;
  body: string;
  data: Prisma.JsonValue | null;
  readAt: string | null;
  createdAt: string;
  shared: boolean;
}

function inboxWhere(ctx: ServiceContext): Prisma.NotificationWhereInput {
  return { householdId: ctx.householdId, channel: "IN_APP", OR: [{ recipientMemberId: ctx.memberId }, { recipientMemberId: null }] };
}

function toDTO(n: { id: string; type: NotificationType; title: string; body: string; data: Prisma.JsonValue | null; readAt: Date | null; createdAt: Date; recipientMemberId: string | null }): NotificationDTO {
  return {
    id: n.id,
    type: n.type,
    typeLabel: NOTIFICATION_TYPE_LABELS[n.type],
    title: n.title,
    body: n.body,
    data: n.data,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
    shared: n.recipientMemberId === null,
  };
}

export const notificationListSchema = z.object({
  unreadOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(64).optional(),
});

/** Notificações do membro (e as da família sem destinatário), mais recentes primeiro. */
export async function listForMember(ctx: ServiceContext, params: z.input<typeof notificationListSchema> = {}) {
  const f = notificationListSchema.parse(params);
  const limit = f.limit ?? 30;
  if (!ctx.memberId) return { items: [] as NotificationDTO[], nextCursor: null as string | null, unreadCount: 0 };
  const where: Prisma.NotificationWhereInput = { AND: [inboxWhere(ctx), f.unreadOnly ? { readAt: null } : {}] };
  const rows = await prisma.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  return {
    items: rows.slice(0, limit).map(toDTO),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    unreadCount: await unreadCount(ctx),
  };
}

export async function unreadCount(ctx: ServiceContext): Promise<number> {
  if (!ctx.memberId) return 0;
  return prisma.notification.count({ where: { AND: [inboxWhere(ctx), { readAt: null }] } });
}

export async function markRead(ctx: ServiceContext, id: string): Promise<NotificationDTO> {
  const n = ctx.memberId ? await prisma.notification.findFirst({ where: { AND: [inboxWhere(ctx), { id }] } }) : null;
  if (!n) throw new NotFoundError("Notificação");
  if (n.readAt) return toDTO(n);
  return toDTO(await prisma.notification.update({ where: { id }, data: { readAt: new Date() } }));
}

export async function markAllRead(ctx: ServiceContext): Promise<{ updated: number }> {
  if (!ctx.memberId) return { updated: 0 };
  const res = await prisma.notification.updateMany({ where: { AND: [inboxWhere(ctx), { readAt: null }] }, data: { readAt: new Date() } });
  return { updated: res.count };
}

// -----------------------------------------------------------------------------
// Preferências do membro
// -----------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato HH:mm");

export const preferenceItemSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  inApp: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  frequency: z.enum(NOTIFICATION_FREQUENCIES).optional(),
  quietStart: hhmm.nullish(),
  quietEnd: hhmm.nullish(),
});
export type PreferenceItemInput = z.input<typeof preferenceItemSchema>;

export const preferencesUpdateSchema = z.object({
  items: z.array(preferenceItemSchema).min(1).max(NOTIFICATION_TYPES.length * 2),
});

export interface PreferenceDTO {
  type: NotificationType;
  label: string;
  inApp: boolean;
  whatsapp: boolean;
  email: boolean;
  push: boolean;
  frequency: NotificationFrequency;
  quietStart: string | null;
  quietEnd: string | null;
}

function requireMember(ctx: ServiceContext): string {
  if (!ctx.memberId) throw new ValidationError("Preferências de notificação são definidas por membro.");
  return ctx.memberId;
}

export async function getPreferences(ctx: ServiceContext): Promise<PreferenceDTO[]> {
  const memberId = requireMember(ctx);
  await ensureMemberPreferences(prisma, memberId);
  const rows = await prisma.notificationPreference.findMany({ where: { memberId } });
  return NOTIFICATION_TYPES.map((type) => {
    const r = rows.find((x) => x.type === type);
    return {
      type,
      label: NOTIFICATION_TYPE_LABELS[type],
      inApp: r?.inApp ?? true,
      whatsapp: r?.whatsapp ?? false,
      email: r?.email ?? false,
      push: r?.push ?? true,
      frequency: r?.frequency ?? "IMMEDIATE",
      quietStart: r?.quietStart ?? null,
      quietEnd: r?.quietEnd ?? null,
    };
  });
}

/** Atualiza as preferências do próprio membro (somente os campos informados). */
export async function updatePreferences(ctx: ServiceContext, rawItems: PreferenceItemInput[]): Promise<PreferenceDTO[]> {
  const memberId = requireMember(ctx);
  const items = z.array(preferenceItemSchema).min(1).parse(rawItems);
  const before = await getPreferences(ctx);
  for (const item of items) {
    const current = before.find((p) => p.type === item.type)!;
    const quietStart = item.quietStart !== undefined ? item.quietStart : current.quietStart;
    const quietEnd = item.quietEnd !== undefined ? item.quietEnd : current.quietEnd;
    if (Boolean(quietStart) !== Boolean(quietEnd)) {
      throw new ValidationError("Informe o início e o fim do horário silencioso.", { field: "quietStart", type: item.type });
    }
    const data = {
      inApp: item.inApp ?? current.inApp,
      whatsapp: item.whatsapp ?? current.whatsapp,
      email: item.email ?? current.email,
      push: item.push ?? current.push,
      frequency: item.frequency ?? current.frequency,
      quietStart: quietStart ?? null,
      quietEnd: quietEnd ?? null,
    };
    await prisma.notificationPreference.upsert({
      where: { memberId_type: { memberId, type: item.type } },
      update: data,
      create: { memberId, type: item.type, ...data },
    });
  }
  const after = await getPreferences(ctx);
  await audit(ctx, {
    action: "SETTINGS_CHANGE",
    entityType: "NotificationPreference",
    entityId: memberId,
    before: before.filter((b) => items.some((i) => i.type === b.type)),
    after: after.filter((a) => items.some((i) => i.type === a.type)),
  });
  return after;
}

export const popupPreferenceSchema = z.object({ inAppPopups: z.boolean() });

/** "Mostrar pop-ups no app": notificações novas aparecem como aviso na tela com o app aberto (padrão ligado). */
export async function getPopupPreference(ctx: ServiceContext): Promise<{ inAppPopups: boolean }> {
  const memberId = requireMember(ctx);
  const member = await prisma.householdMember.findUnique({ where: { id: memberId }, select: { inAppPopups: true } });
  return { inAppPopups: member?.inAppPopups ?? true };
}

export async function setPopupPreference(ctx: ServiceContext, raw: z.input<typeof popupPreferenceSchema>): Promise<{ inAppPopups: boolean }> {
  const memberId = requireMember(ctx);
  const { inAppPopups } = popupPreferenceSchema.parse(raw);
  const before = await getPopupPreference(ctx);
  if (before.inAppPopups !== inAppPopups) {
    await prisma.householdMember.update({ where: { id: memberId }, data: { inAppPopups } });
    await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "HouseholdMember", entityId: memberId, before, after: { inAppPopups } });
  }
  return { inAppPopups };
}

// -----------------------------------------------------------------------------
// Horário silencioso
// -----------------------------------------------------------------------------

function parseHHMM(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutos desde a meia-noite no fuso informado. */
export function minutesInTimezone(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** Verifica se o instante (em minutos locais) está dentro da janela [início, fim) — aceita janelas que cruzam a meia-noite. */
export function isWithinQuietHours(nowMinutes: number, quietStart: string | null | undefined, quietEnd: string | null | undefined): boolean {
  const start = parseHHMM(quietStart);
  const end = parseHHMM(quietEnd);
  if (start === null || end === null || start === end) return false;
  return start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end;
}
