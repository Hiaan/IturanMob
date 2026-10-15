import { randomUUID } from "node:crypto";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import type { WhatsAppConnection, WhatsAppMessage } from "@prisma/client";
import { prisma } from "../db";
import { redis } from "../redis";
import { emitEvent as publishEvent, withRedis } from "./redis-safe";
import { errorInfo, logger } from "../logger";
import type { OutboundJobData } from "../jobs/queues";
import { markSentByBot, withBotPrefix } from "./bot-messages";
import { OUTBOUND_DONE_TTL_SECONDS, outboundDoneKey, outboundHourKey, outboundSecondKey } from "./keys";
import type { WhatsAppProvider } from "./types";

/**
 * Consumidor da fila "whatsapp-outbound" (roda no worker).
 * - Destino SEMPRE derivado da configuração da família (grupo autorizado / membros autorizados).
 * - Registra cada envio como WhatsAppMessage OUTBOUND (QUEUED → PROCESSED ou FAILED), sem perder o registro.
 * - Limite de taxa conservador por família: 1 mensagem/segundo e 30/hora.
 */

export const OUTBOUND_MIN_INTERVAL_MS = 1000;
export const OUTBOUND_MAX_PER_HOUR = 30;

export interface ProviderRegistry {
  /** Provedor em execução para a família (pode estar desconectado). */
  getProvider(householdId: string): WhatsAppProvider | null;
}

interface Target {
  chatId: string;
  groupId: string | null;
  quoted: string | null;
}

async function resolveTargets(conn: WhatsAppConnection, quotedExternalId: string | null): Promise<Target[]> {
  if (conn.provider === "CLOUD_API") {
    const members = await prisma.householdMember.findMany({
      where: { householdId: conn.householdId, isActive: true, whatsappAuthorized: true, whatsappConsentAt: { not: null }, whatsappPhone: { not: null } },
      select: { id: true, whatsappPhone: true },
    });
    if (quotedExternalId) {
      const quoted = await prisma.whatsAppMessage.findUnique({
        where: { connectionId_externalId: { connectionId: conn.id, externalId: quotedExternalId } },
        select: { chatId: true, direction: true, senderMemberId: true },
      });
      // Resposta somente na conversa de um membro ainda autorizado.
      if (quoted && quoted.direction === "INBOUND" && members.some((m) => m.id === quoted.senderMemberId)) {
        return [{ chatId: quoted.chatId, groupId: null, quoted: quotedExternalId }];
      }
    }
    return members.map((m) => ({ chatId: m.whatsappPhone!.replace(/\D/g, ""), groupId: null, quoted: null }));
  }
  const group = await prisma.whatsAppGroup.findFirst({ where: { connectionId: conn.id, isAuthorized: true }, select: { id: true, externalId: true } });
  if (!group) return [];
  let quoted: string | null = null;
  if (quotedExternalId) {
    const q = await prisma.whatsAppMessage.findUnique({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: quotedExternalId } },
      select: { chatId: true },
    });
    if (q?.chatId === group.externalId) quoted = quotedExternalId;
  }
  return [{ chatId: group.externalId, groupId: group.id, quoted }];
}

/** Reserva uma vaga no limite de taxa. Retorna 0 se liberado ou o tempo (ms) até poder enviar. */
export async function reserveOutboundSlot(householdId: string, now = Date.now()): Promise<number> {
  const r = redis();
  const ok = await r.set(outboundSecondKey(householdId), "1", "PX", OUTBOUND_MIN_INTERVAL_MS, "NX");
  if (ok !== "OK") {
    const ttl = await r.pttl(outboundSecondKey(householdId));
    return Math.max(ttl, 200);
  }
  const bucket = Math.floor(now / 3_600_000);
  const hk = outboundHourKey(householdId, bucket);
  const count = await r.incr(hk);
  if (count === 1) await r.expire(hk, 3700);
  if (count > OUTBOUND_MAX_PER_HOUR) {
    await r.decr(hk);
    return (bucket + 1) * 3_600_000 - now + 1000;
  }
  return 0;
}

async function alreadyDelivered(hash: string): Promise<boolean> {
  return withRedis(async (r) => (await r.exists(outboundDoneKey(hash))) === 1, false);
}

async function markDelivered(hash: string, externalId: string): Promise<void> {
  // Melhor esforço: o registro OUTBOUND no banco também evita o reenvio.
  await withRedis((r) => r.set(outboundDoneKey(hash), externalId, "EX", OUTBOUND_DONE_TTL_SECONDS), null);
}

/** Remetente "estático" do simulador: registra a resposta como mensagem simulada (sem WhatsApp real). */
const simulatorSender: Pick<WhatsAppProvider, "isConnected" | "sendText"> = {
  isConnected: () => true,
  sendText: async () => ({ externalId: `SIM-OUT-${randomUUID()}` }),
};

function senderFor(conn: WhatsAppConnection, registry: ProviderRegistry | null): Pick<WhatsAppProvider, "isConnected" | "sendText"> | null {
  const running = registry?.getProvider(conn.householdId) ?? null;
  if (running && running.type === conn.provider) return running;
  if (conn.provider === "SIMULATOR") return simulatorSender;
  return null;
}

export interface DeliveryContext {
  /** Tentativas já feitas (0 na primeira). */
  attemptsMade: number;
  maxAttempts: number;
}

export type DeliveryResult = { sent: number; skipped: number; delayMs?: number };

/** Entrega um envio. Lança erro para que a BullMQ tente de novo; retorna delayMs quando limitado pela taxa. */
export async function deliverOutbound(data: OutboundJobData, ctx: DeliveryContext, registry: ProviderRegistry | null): Promise<DeliveryResult> {
  const conn = await prisma.whatsAppConnection.findUnique({ where: { householdId: data.householdId } });
  if (!conn) throw new UnrecoverableError("WhatsApp não configurado para a família");
  const targets = await resolveTargets(conn, data.quotedExternalId);
  const fullText = withBotPrefix(data.text);
  const attemptNo = ctx.attemptsMade + 1;
  const final = attemptNo >= ctx.maxAttempts;

  if (!targets.length) {
    await prisma.whatsAppMessage.upsert({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: `out-${data.dedupeHash}` } },
      create: {
        householdId: conn.householdId,
        connectionId: conn.id,
        externalId: `out-${data.dedupeHash}`,
        chatId: "-",
        direction: "OUTBOUND",
        type: "TEXT",
        text: fullText,
        sentAt: new Date(),
        status: "FAILED",
        statusDetail: "Não enviada: nenhum chat autorizado",
      },
      update: { status: "FAILED", statusDetail: "Não enviada: nenhum chat autorizado" },
    });
    await publishEvent(conn.householdId, "whatsapp.message");
    throw new UnrecoverableError("Nenhum chat autorizado para envio");
  }

  const sender = senderFor(conn, registry);
  let sent = 0;
  let skipped = 0;
  for (const [i, target] of targets.entries()) {
    const hash = targets.length > 1 ? `${data.dedupeHash}-${i}` : data.dedupeHash;
    const placeholder = `out-${hash}`;
    if (await alreadyDelivered(hash)) {
      skipped++;
      continue;
    }
    let row: WhatsAppMessage | null = await prisma.whatsAppMessage.findUnique({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: placeholder } },
    });
    if (row?.status === "PROCESSED") {
      skipped++;
      continue;
    }
    if (!row) {
      try {
        row = await prisma.whatsAppMessage.create({
          data: {
            householdId: conn.householdId,
            connectionId: conn.id,
            groupId: target.groupId,
            externalId: placeholder,
            chatId: target.chatId,
            direction: "OUTBOUND",
            type: "TEXT",
            text: fullText,
            quotedExternalId: target.quoted,
            sentAt: new Date(),
            status: "QUEUED",
            statusDetail: `Na fila (${data.kind})`,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
        row = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { connectionId_externalId: { connectionId: conn.id, externalId: placeholder } } });
      }
    }

    const wait = await reserveOutboundSlot(conn.householdId);
    if (wait > 0) {
      if (row.status !== "QUEUED") await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { status: "QUEUED", statusDetail: "Aguardando limite de envio" } });
      return { sent, skipped, delayMs: wait };
    }

    if (!sender || !sender.isConnected()) {
      await prisma.whatsAppMessage.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          statusDetail: final ? "Falha definitiva: WhatsApp desconectado" : `Não enviada: WhatsApp desconectado (tentativa ${attemptNo}/${ctx.maxAttempts})`,
        },
      });
      await publishEvent(conn.householdId, "whatsapp.message", row.id);
      throw new Error("WhatsApp desconectado");
    }

    try {
      const { externalId } = await sender.sendText(target.chatId, fullText, { quotedExternalId: target.quoted });
      await markSentByBot(conn.id, externalId);
      await markDelivered(hash, externalId);
      const done = { status: "PROCESSED" as const, processedAt: new Date(), sentAt: new Date(), statusDetail: `Enviada (${data.kind})` };
      try {
        await prisma.whatsAppMessage.update({ where: { id: row.id }, data: { ...done, externalId } });
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
        await prisma.whatsAppMessage.update({ where: { id: row.id }, data: done });
      }
      sent++;
      await publishEvent(conn.householdId, "whatsapp.message", row.id);
    } catch (err) {
      const msg = errorInfo(err).message.slice(0, 200);
      await prisma.whatsAppMessage.update({
        where: { id: row.id },
        data: { status: "FAILED", statusDetail: final ? `Falha definitiva no envio: ${msg}` : `Falha no envio (tentativa ${attemptNo}/${ctx.maxAttempts}): ${msg}` },
      });
      await publishEvent(conn.householdId, "whatsapp.message", row.id);
      throw err;
    }
  }
  return { sent, skipped };
}

/** Processador BullMQ (aplica o atraso do limite de taxa sem consumir tentativas). */
export function makeOutboundProcessor(registry: ProviderRegistry) {
  return async (job: Job<OutboundJobData>, token?: string) => {
    const res = await deliverOutbound(job.data, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 }, registry);
    if (res.delayMs && res.delayMs > 0) {
      await job.moveToDelayed(Date.now() + res.delayMs, token);
      throw new DelayedError();
    }
    if (res.sent) logger.info({ householdId: job.data.householdId, kind: job.data.kind, sent: res.sent }, "whatsapp: mensagem enviada");
    return res;
  };
}
