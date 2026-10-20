import { z } from "zod";
import { notificationUrl } from "@/lib/notification-meta";
import type { NotificationType } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { env } from "../../env";
import { decryptStringSafe, encryptString } from "../../crypto";
import { errorInfo, logger } from "../../logger";
import { NotFoundError, ValidationError } from "../../errors";

/**
 * Web Push: inscrição por aparelho e envio das notificações já geradas pelo sistema.
 * As chaves VAPID vêm do ambiente (geradas no servidor); sem elas, o push fica desativado.
 * O conteúdo vai criptografado de ponta a ponta até o aparelho (padrão Web Push); o serviço de push
 * do navegador (Apple/Google/Mozilla) não consegue lê-lo.
 */

export function pushConfig(): { enabled: boolean; publicKey: string | null; reason: string | null } {
  const e = env();
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY || !e.VAPID_SUBJECT) {
    return { enabled: false, publicKey: null, reason: "Notificações push não configuradas no servidor (chaves VAPID ausentes)." };
  }
  return { enabled: true, publicKey: e.VAPID_PUBLIC_KEY, reason: null };
}

const ALLOWED_PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chromium\.org)$/;

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine((u) => {
      try {
        const url = new URL(u);
        return url.protocol === "https:" && ALLOWED_PUSH_HOSTS.test(url.hostname);
      } catch {
        return false;
      }
    }, "Serviço de push não reconhecido."),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
  deviceLabel: z.string().trim().max(80).nullish(),
});

export async function listPushDevices(ctx: ServiceContext) {
  if (!ctx.memberId) return [];
  const subs = await prisma.pushSubscription.findMany({ where: { memberId: ctx.memberId }, orderBy: { createdAt: "asc" } });
  return subs.map((s) => ({ id: s.id, deviceLabel: s.deviceLabel, createdAt: s.createdAt.toISOString(), lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null, endpointHost: new URL(s.endpoint).hostname }));
}

/** Registra (ou atualiza) a inscrição deste aparelho para o membro logado. */
export async function subscribePush(ctx: ServiceContext, raw: z.input<typeof pushSubscriptionSchema>) {
  if (!ctx.memberId) throw new ValidationError("Somente membros podem ativar notificações.");
  if (!pushConfig().enabled) throw new ValidationError(pushConfig().reason!);
  const input = pushSubscriptionSchema.parse(raw);
  const data = {
    householdId: ctx.householdId,
    memberId: ctx.memberId,
    userId: ctx.userId,
    p256dh: encryptString(input.keys.p256dh),
    auth: encryptString(input.keys.auth),
    deviceLabel: input.deviceLabel ?? null,
    failureCount: 0,
  };
  // O mesmo aparelho pode trocar de pessoa (logout/login): a inscrição passa para quem está logado.
  const sub = await prisma.pushSubscription.upsert({ where: { endpoint: input.endpoint }, create: { ...data, endpoint: input.endpoint }, update: data });
  return { id: sub.id };
}

export async function unsubscribePush(ctx: ServiceContext, input: { endpoint?: string; id?: string }) {
  const where = input.id ? { id: input.id, memberId: ctx.memberId ?? "" } : { endpoint: input.endpoint ?? "", memberId: ctx.memberId ?? "" };
  const res = await prisma.pushSubscription.deleteMany({ where });
  if (input.id && !res.count) throw new NotFoundError("Aparelho");
  return { removed: res.count };
}

// -----------------------------------------------------------------------------
// Envio
// -----------------------------------------------------------------------------



export interface PushMessage {
  title: string;
  body: string;
  type: NotificationType | "TEST";
  notificationId?: string;
  /** `data` da notificação (destino específico em `data.url`). */
  data?: unknown;
}

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<{ statusCode: number }>;

let senderOverride: Sender | null = null;
/** Testes: substitui o envio real (rede) por um dublê. */
export function setPushSenderForTests(sender: Sender | null) {
  senderOverride = sender;
}

async function realSender(): Promise<Sender> {
  const webpush = (await import("web-push")).default;
  const e = env();
  webpush.setVapidDetails(e.VAPID_SUBJECT!, e.VAPID_PUBLIC_KEY!, e.VAPID_PRIVATE_KEY!);
  return (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 24 * 3600, urgency: "normal" });
}

/** Envia para todos os aparelhos do membro. Inscrições expiradas (404/410) são removidas. */
export async function sendPushToMember(memberId: string, msg: PushMessage): Promise<{ sent: number; failed: number; removed: number }> {
  const result = { sent: 0, failed: 0, removed: 0 };
  if (!pushConfig().enabled && !senderOverride) return result;
  const subs = await prisma.pushSubscription.findMany({ where: { memberId } });
  if (!subs.length) return result;
  const send = senderOverride ?? (await realSender());
  const payload = JSON.stringify({
    title: msg.title.slice(0, 120),
    body: msg.body.slice(0, 400),
    url: msg.type === "TEST" ? "/configuracoes" : notificationUrl(msg.type, msg.data),
    tag: msg.type,
    notificationId: msg.notificationId ?? null,
  });
  for (const s of subs) {
    const p256dh = decryptStringSafe(s.p256dh);
    const auth = decryptStringSafe(s.auth);
    if (!p256dh || !auth) {
      await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
      result.removed++;
      continue;
    }
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh, auth } }, payload);
      await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSuccessAt: new Date(), failureCount: 0 } });
      result.sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        result.removed++;
      } else {
        result.failed++;
        const updated = await prisma.pushSubscription.update({ where: { id: s.id }, data: { failureCount: { increment: 1 } } }).catch(() => null);
        // Aparelho que falha sempre (ex.: chave inválida) deixa de receber depois de 10 tentativas.
        if (updated && updated.failureCount >= 10) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        logger.warn({ memberId, status, err: errorInfo(err).name }, "push: falha no envio");
      }
    }
  }
  return result;
}

export async function sendTestPush(ctx: ServiceContext) {
  if (!ctx.memberId) throw new ValidationError("Somente membros recebem notificações.");
  if (!pushConfig().enabled && !senderOverride) throw new ValidationError(pushConfig().reason!);
  const res = await sendPushToMember(ctx.memberId, { title: "Finanças", body: "Notificações ativadas neste aparelho. ✅", type: "TEST" });
  if (!res.sent) {
    throw new ValidationError(
      res.failed
        ? "O serviço de push não aceitou o envio agora. Tente de novo em alguns minutos; se continuar, desative e ative as notificações neste aparelho."
        : res.removed
          ? "A inscrição deste aparelho expirou. Ative as notificações de novo."
          : "Nenhum aparelho com notificações ativadas.",
    );
  }
  return res;
}
