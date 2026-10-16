import type { Notification, NotificationStatus, Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { formatDateBR, hourInTimezone, todayISO } from "@/lib/dates";
import { enqueueOutboundMessage, whatsappCanSend } from "../../whatsapp/outbound";
import { sendPushToMember } from "../push/service";
import { DIGEST_HOUR, isWithinQuietHours, minutesInTimezone, whatsappDeliveryWhere, WHATSAPP_HOURLY_LIMIT } from "./service";

const HOUR_MS = 3_600_000;
/** Notificações imediatas não enviadas em até 24 h deixam de ser enviadas (ficam no aplicativo). */
const STALE_AFTER_MS = 24 * HOUR_MS;
const DIGEST_MAX_LINES = 15;

export interface DispatchSummary {
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  expired: number;
  digests: number;
}

function digestItemIds(n: Pick<Notification, "data">): string[] {
  const data = n.data as Prisma.JsonObject | null;
  const ids = data && typeof data === "object" && !Array.isArray(data) ? data.digestItemIds : null;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

function isDigest(n: Pick<Notification, "data">): boolean {
  const data = n.data as Prisma.JsonObject | null;
  return Boolean(data && typeof data === "object" && !Array.isArray(data) && data.digest === true);
}

/** Atualiza o status final de uma notificação de WhatsApp (e dos itens incluídos no resumo, quando houver). */
async function finalize(n: Pick<Notification, "id" | "data">, status: Exclude<NotificationStatus, "PENDING">, error: string | null, now: Date) {
  await prisma.notification.update({
    where: { id: n.id },
    data: { status, error: error?.slice(0, 500) ?? null, sentAt: status === "SENT" ? now : null },
  });
  const items = digestItemIds(n);
  if (items.length) {
    await prisma.notification.updateMany({
      where: { id: { in: items }, status: "PENDING" },
      data: {
        status,
        sentAt: status === "SENT" ? now : null,
        error: status === "SENT" ? null : `Resumo diário não enviado: ${error ?? "motivo desconhecido"}`.slice(0, 500),
      },
    });
  }
}

/** Marca como SKIPPED as notificações imediatas que não puderam ser enviadas em 24 horas. */
async function expireStale(now: Date): Promise<number> {
  const stale = await prisma.notification.findMany({
    where: { ...whatsappDeliveryWhere("IMMEDIATE"), status: "PENDING", createdAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
    select: { id: true, data: true },
  });
  for (const n of stale) {
    await finalize(n, "SKIPPED", "Não enviada em até 24 horas (horário silencioso, limite de envio ou WhatsApp indisponível). Disponível no aplicativo.", now);
  }
  return stale.length;
}

/** Monta, uma vez por dia (a partir de DIGEST_HOUR no fuso da família), o resumo das notificações em DAILY_DIGEST. */
async function buildDailyDigests(now: Date): Promise<number> {
  const items = await prisma.notification.findMany({
    where: { ...whatsappDeliveryWhere("DIGEST"), status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: { id: true, householdId: true, title: true, body: true },
  });
  if (!items.length) return 0;
  const byHousehold = new Map<string, typeof items>();
  for (const item of items) byHousehold.set(item.householdId, [...(byHousehold.get(item.householdId) ?? []), item]);

  let created = 0;
  for (const [householdId, list] of byHousehold) {
    const household = await prisma.household.findUnique({ where: { id: householdId }, select: { timezone: true } });
    if (!household) continue;
    if (hourInTimezone(household.timezone, now) < DIGEST_HOUR) continue;
    const day = todayISO(household.timezone, now);
    const dedupeKey = `digest:${day}:wa`;
    const exists = await prisma.notification.findUnique({ where: { householdId_dedupeKey: { householdId, dedupeKey } }, select: { id: true } });
    if (exists) continue; // o resumo de hoje já foi montado; novos itens entram no de amanhã
    const lines = list.slice(0, DIGEST_MAX_LINES).map((i) => `• ${i.title}: ${i.body}`);
    if (list.length > DIGEST_MAX_LINES) lines.push(`… e mais ${list.length - DIGEST_MAX_LINES} no aplicativo.`);
    try {
      await prisma.notification.create({
        data: {
          householdId,
          type: "SYSTEM",
          channel: "WHATSAPP",
          status: "PENDING",
          title: `Resumo do dia (${formatDateBR(day)})`,
          body: lines.join("\n"),
          dedupeKey,
          data: { delivery: "IMMEDIATE", digest: true, digestItemIds: list.map((i) => i.id) },
        },
      });
      created++;
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }
  return created;
}

/**
 * Despacha notificações de WhatsApp pendentes para o grupo da família. Idempotente:
 * - fora do horário silencioso (preferências dos membros, fuso da família);
 * - no máximo WHATSAPP_HOURLY_LIMIT envios por hora por família (o excedente aguarda a próxima execução);
 * - WhatsApp indisponível → SKIPPED com motivo; falha no enfileiramento → FAILED com o erro.
 * Também monta o resumo diário (DAILY_DIGEST).
 */
/**
 * Push: envia as notificações PENDING do canal PUSH (uma por destinatário). Respeita o horário
 * silencioso do membro (fica para depois) e desiste após 24 h (a notificação segue no aplicativo).
 */
async function dispatchPush(now: Date, summary: DispatchSummary) {
  const pending = await prisma.notification.findMany({
    where: { channel: "PUSH", status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 300,
    include: { household: { select: { timezone: true } } },
  });
  for (const n of pending) {
    if (!n.recipientMemberId) {
      await finalize(n, "SKIPPED", "Sem destinatário.", now);
      continue;
    }
    if (n.createdAt.getTime() < now.getTime() - STALE_AFTER_MS) {
      await finalize(n, "SKIPPED", "Não enviada em até 24 horas. Disponível no aplicativo.", now);
      summary.expired++;
      continue;
    }
    const pref = await prisma.notificationPreference.findUnique({ where: { memberId_type: { memberId: n.recipientMemberId, type: n.type } }, select: { push: true, frequency: true, quietStart: true, quietEnd: true } });
    if (pref && (!pref.push || pref.frequency === "OFF")) {
      await finalize(n, "SKIPPED", "Push desativado nas preferências.", now);
      summary.skipped++;
      continue;
    }
    if (pref && isWithinQuietHours(minutesInTimezone(n.household.timezone, now), pref.quietStart, pref.quietEnd)) {
      summary.deferred++;
      continue;
    }
    try {
      const res = await sendPushToMember(n.recipientMemberId, { title: n.title, body: n.body, type: n.type, notificationId: n.id });
      if (res.sent) {
        await finalize(n, "SENT", null, now);
        summary.sent++;
      } else if (res.failed) {
        summary.failed++; // tenta de novo na próxima execução (até 24 h)
      } else {
        await finalize(n, "SKIPPED", "Nenhum aparelho com notificações ativas.", now);
        summary.skipped++;
      }
    } catch (err) {
      summary.failed++;
      logger.warn({ notificationId: n.id, err: errorInfo(err).name }, "push: falha no despacho");
    }
  }
}

export async function runNotificationDispatch(now: Date = new Date()): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, failed: 0, skipped: 0, deferred: 0, expired: 0, digests: 0 };
  summary.expired = await expireStale(now);
  summary.digests = await buildDailyDigests(now);
  await dispatchPush(now, summary);

  const pending = await prisma.notification.findMany({
    where: { ...whatsappDeliveryWhere("IMMEDIATE"), status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 500,
  });
  const byHousehold = new Map<string, Notification[]>();
  for (const n of pending) byHousehold.set(n.householdId, [...(byHousehold.get(n.householdId) ?? []), n]);

  for (const [householdId, list] of byHousehold) {
    try {
      const household = await prisma.household.findUnique({ where: { id: householdId }, select: { timezone: true } });
      if (!household) continue;

      if (!(await whatsappCanSend(householdId))) {
        for (const n of list) {
          await finalize(n, "SKIPPED", "O WhatsApp da família não está conectado ou não permite envio no momento. A notificação continua disponível no aplicativo.", now);
          summary.skipped++;
        }
        continue;
      }

      const sentLastHour = await prisma.notification.count({
        where: { householdId, ...whatsappDeliveryWhere("IMMEDIATE"), status: "SENT", sentAt: { gte: new Date(now.getTime() - HOUR_MS) } },
      });
      let budget = WHATSAPP_HOURLY_LIMIT - sentLastHour;

      const quietPrefs = await prisma.notificationPreference.findMany({
        where: {
          member: { householdId, isActive: true, userId: { not: null } },
          whatsapp: true,
          frequency: { not: "OFF" },
          quietStart: { not: null },
          quietEnd: { not: null },
        },
        select: { type: true, quietStart: true, quietEnd: true },
      });
      const minutes = minutesInTimezone(household.timezone, now);

      for (const n of list) {
        const windows = isDigest(n) ? quietPrefs : quietPrefs.filter((p) => p.type === n.type);
        if (windows.some((p) => isWithinQuietHours(minutes, p.quietStart, p.quietEnd))) {
          summary.deferred++;
          continue;
        }
        if (budget <= 0) {
          summary.deferred++;
          continue;
        }
        try {
          const result = await enqueueOutboundMessage({ householdId, text: `${n.title}\n${n.body}`, kind: "notification", dedupeKey: `notif:${n.id}` });
          if (result.queued) {
            await finalize(n, "SENT", null, now);
            summary.sent++;
            budget--;
          } else {
            await finalize(n, "FAILED", result.reason ?? "O envio não foi aceito pelo serviço de WhatsApp.", now);
            summary.failed++;
          }
        } catch (err) {
          await finalize(n, "FAILED", `Falha ao enfileirar o envio: ${errorInfo(err).message}`, now);
          summary.failed++;
        }
      }
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId }, "notifications: falha no despacho");
    }
  }
  return summary;
}
