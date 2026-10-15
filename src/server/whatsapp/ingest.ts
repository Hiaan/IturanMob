import type { AttachmentKind, HouseholdMember, MessageStatus, MessageType, WhatsAppConnection } from "@prisma/client";
import { prisma } from "../db";
import { sha256Hex } from "../crypto";
import { publishEvent } from "../events";
import { errorInfo, logger } from "../logger";
import { deleteStoredFile, storeFile } from "../storage";
import { createPendingItem } from "../modules/pending/service";
import { getSettings } from "../modules/households/service";
import { hasBotPrefix, wasSentByBot } from "./bot-messages";
import { enqueueInboundJob } from "./inbound-queue";
import { normalizeE164, normalizeJid, phoneFromJid, phonesMatch, isLidJid, isPnJid } from "./phone";
import { MAX_MEDIA_BYTES, type NormalizedInboundMessage } from "./types";

/**
 * INGESTÃO — porta de entrada única das mensagens recebidas (todos os provedores).
 *
 * Regras de privacidade:
 * - Só o grupo autorizado (ou, na Cloud API, a conversa direta de um remetente autorizado) é processado.
 * - Mensagens de outros chats ou de remetentes não autorizados/sem consentimento são descartadas SEM
 *   persistir conteúdo — apenas um contador por motivo em log (sem texto, sem identificadores).
 */

export type IngestSkipReason =
  | "connection_not_found"
  | "chat_not_authorized"
  | "bot_message"
  | "sender_unknown"
  | "sender_not_authorized"
  | "sender_without_consent";

export interface IngestResult {
  accepted: boolean;
  reason?: IngestSkipReason;
  duplicate?: boolean;
  messageId?: string;
  jobId?: string | null;
  status?: MessageStatus;
  /** O job foi colocado na fila BullMQ agora (false: Redis fora — a recuperação reenfileira). */
  queued?: boolean;
}

export type IngestConnection = Pick<WhatsAppConnection, "id" | "householdId">;

/** Prefixo usado em statusDetail quando o mesmo arquivo (SHA-256) já foi recebido pela família. */
export const DUPLICATE_MEDIA_PREFIX = "Mídia repetida";

const PROCESSABLE_DOC_MIME = /^(application\/pdf|image\/)/i;

const discardCounters = new Map<IngestSkipReason, number>();

function discard(reason: IngestSkipReason): IngestResult {
  const total = (discardCounters.get(reason) ?? 0) + 1;
  discardCounters.set(reason, total);
  logger.debug({ reason, total }, "whatsapp: mensagem descartada (conteúdo não persistido)");
  return { accepted: false, reason };
}

/** Contadores de descarte por motivo (somente números). */
export function discardStats(): Record<string, number> {
  return Object.fromEntries(discardCounters);
}

/** Tipos com relevância financeira que geram processamento. */
export function isProcessableType(type: MessageType, opts: { hasText: boolean; hasMedia: boolean; mimeType?: string | null }): boolean {
  switch (type) {
    case "TEXT":
      return opts.hasText;
    case "AUDIO":
    case "IMAGE":
      return opts.hasMedia;
    case "DOCUMENT":
      return opts.hasMedia && PROCESSABLE_DOC_MIME.test(opts.mimeType ?? "");
    default:
      return false;
  }
}

function attachmentKind(type: MessageType): AttachmentKind {
  if (type === "AUDIO") return "AUDIO";
  if (type === "IMAGE") return "IMAGE";
  if (type === "DOCUMENT") return "DOCUMENT";
  return "OTHER";
}

type MemberLite = Pick<
  HouseholdMember,
  "id" | "whatsappPhone" | "whatsappJid" | "whatsappLid" | "whatsappAuthorized" | "whatsappConsentAt" | "isActive"
>;

interface SenderMatch {
  member: MemberLite;
  jid: string | null;
  lid: string | null;
  phone: string | null;
}

async function resolveSender(
  householdId: string,
  connectionPhone: string | null,
  msg: NormalizedInboundMessage,
): Promise<SenderMatch | { reason: IngestSkipReason }> {
  const members = await prisma.householdMember.findMany({
    where: { householdId, isActive: true },
    select: { id: true, whatsappPhone: true, whatsappJid: true, whatsappLid: true, whatsappAuthorized: true, whatsappConsentAt: true, isActive: true },
  });
  const rawIds = [msg.senderIds.jid, msg.senderIds.lid].map((v) => normalizeJid(v));
  const lid = rawIds.find((v) => isLidJid(v)) ?? null;
  const jid = rawIds.find((v) => isPnJid(v)) ?? null;
  const phone = normalizeE164(msg.senderIds.phone) ?? phoneFromJid(jid);

  let member: MemberLite | undefined;
  // Mensagens do próprio número conectado pertencem ao membro dono desse número.
  if (msg.fromMe && connectionPhone) member = members.find((m) => phonesMatch(m.whatsappPhone, connectionPhone));
  if (!member && lid) member = members.find((m) => m.whatsappLid === lid);
  if (!member && jid) member = members.find((m) => m.whatsappJid === jid);
  if (!member && phone) member = members.find((m) => phonesMatch(m.whatsappPhone, phone));
  if (!member) return { reason: "sender_unknown" };
  if (!member.whatsappAuthorized) return { reason: "sender_not_authorized" };
  if (!member.whatsappConsentAt) return { reason: "sender_without_consent" };
  return { member, jid, lid, phone };
}

/** Aprende JID/LID do membro quando confirmados pelo telefone cadastrado. */
async function learnSenderIds(match: SenderMatch, fromMe: boolean, connectionPhone: string | null): Promise<void> {
  const { member } = match;
  const verified =
    (match.phone && phonesMatch(member.whatsappPhone, match.phone)) || (fromMe && connectionPhone && phonesMatch(member.whatsappPhone, connectionPhone));
  const data: { whatsappJid?: string; whatsappLid?: string } = {};
  if (match.jid && member.whatsappJid !== match.jid && phonesMatch(member.whatsappPhone, phoneFromJid(match.jid))) data.whatsappJid = match.jid;
  // Sem verificação pelo telefone, só preenche um LID ainda desconhecido (nunca sobrescreve).
  if (match.lid && member.whatsappLid !== match.lid && (verified || member.whatsappLid === null)) data.whatsappLid = match.lid;
  if (!Object.keys(data).length) return;
  try {
    await prisma.householdMember.update({ where: { id: member.id }, data });
  } catch (err) {
    logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao registrar identificadores do membro");
  }
}

interface MediaOutcome {
  attachmentId: string | null;
  duplicateOf: { id: string; createdAt: Date } | null;
  error: string | null;
}

async function storeMedia(householdId: string, memberId: string, msg: NormalizedInboundMessage, retentionDays: number): Promise<MediaOutcome> {
  const media = msg.media!;
  try {
    if (media.sizeBytes && media.sizeBytes > MAX_MEDIA_BYTES) throw new Error("Arquivo acima do limite de 16 MB");
    const buf = await media.download(MAX_MEDIA_BYTES);
    if (buf.length === 0) throw new Error("Arquivo vazio");
    if (buf.length > MAX_MEDIA_BYTES) throw new Error("Arquivo acima do limite de 16 MB");
    const sha256 = sha256Hex(buf);
    const retentionUntil = new Date(Date.now() + Math.max(0, retentionDays) * 86_400_000);
    const existing = await prisma.attachment.findUnique({ where: { householdId_sha256: { householdId, sha256 } } });
    if (existing) {
      if (!existing.storageKey || existing.contentDeletedAt) {
        // O conteúdo anterior já foi apagado pela retenção: guarda novamente para permitir o processamento.
        const stored = await storeFile("media", buf);
        await prisma.attachment.update({
          where: { id: existing.id },
          data: { storageKey: stored.storageKey, contentDeletedAt: null, retentionUntil, sizeBytes: stored.sizeBytes },
        });
      }
      return { attachmentId: existing.id, duplicateOf: { id: existing.id, createdAt: existing.createdAt }, error: null };
    }
    const stored = await storeFile("media", buf);
    try {
      const att = await prisma.attachment.create({
        data: {
          householdId,
          kind: attachmentKind(msg.type),
          mimeType: (media.mimeType || "application/octet-stream").split(";")[0]!.trim().slice(0, 100),
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          storageKey: stored.storageKey,
          originalName: media.fileName?.slice(0, 200) ?? null,
          uploadedByMemberId: memberId,
          retentionUntil,
        },
      });
      return { attachmentId: att.id, duplicateOf: null, error: null };
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
      // Corrida: outro evento gravou o mesmo arquivo no mesmo instante.
      await deleteStoredFile(stored.storageKey).catch(() => undefined);
      const again = await prisma.attachment.findUniqueOrThrow({ where: { householdId_sha256: { householdId, sha256 } } });
      return { attachmentId: again.id, duplicateOf: { id: again.id, createdAt: again.createdAt }, error: null };
    }
  } catch (err) {
    return { attachmentId: null, duplicateOf: null, error: errorInfo(err).message.slice(0, 200) };
  }
}

/**
 * Registra uma mensagem recebida (idempotente por connectionId+externalId) e agenda o processamento.
 * Nunca registra o conteúdo em logs.
 */
export async function ingestMessage(connectionRef: IngestConnection, msg: NormalizedInboundMessage): Promise<IngestResult> {
  const conn = await prisma.whatsAppConnection.findUnique({
    where: { id: connectionRef.id },
    select: { id: true, householdId: true, provider: true, phoneNumber: true, processingEnabled: true },
  });
  if (!conn || conn.householdId !== connectionRef.householdId) return discard("connection_not_found");
  const householdId = conn.householdId;

  // 1) Chat autorizado
  let groupId: string | null = null;
  if (msg.isGroup) {
    const group = await prisma.whatsAppGroup.findUnique({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: msg.chatId } },
      select: { id: true, isAuthorized: true },
    });
    if (!group?.isAuthorized) return discard("chat_not_authorized");
    groupId = group.id;
  } else if (conn.provider !== "CLOUD_API" || msg.fromMe) {
    // Baileys/simulador: somente o grupo autorizado. Cloud API: conversa direta do remetente.
    return discard("chat_not_authorized");
  }

  // 2) Idempotência e mensagens do próprio bot
  const existing = await prisma.whatsAppMessage.findUnique({
    where: { connectionId_externalId: { connectionId: conn.id, externalId: msg.externalId } },
    select: { id: true, direction: true, status: true, jobs: { select: { id: true } } },
  });
  if (existing) {
    if (existing.direction === "OUTBOUND") return discard("bot_message");
    return { accepted: true, duplicate: true, messageId: existing.id, jobId: existing.jobs[0]?.id ?? null, status: existing.status };
  }
  const rawText = (msg.text ?? msg.caption ?? "").trim();
  if (msg.fromMe && (hasBotPrefix(rawText) || (await wasSentByBot(conn.id, msg.externalId)))) return discard("bot_message");

  // 3) Remetente autorizado com consentimento
  const sender = await resolveSender(householdId, conn.phoneNumber, msg);
  if ("reason" in sender) return discard(sender.reason);
  await learnSenderIds(sender, msg.fromMe, conn.phoneNumber);

  // 4) Relevância e mídia
  const processable = isProcessableType(msg.type, { hasText: rawText.length > 0, hasMedia: Boolean(msg.media), mimeType: msg.media?.mimeType });
  const keepText = msg.type !== "STICKER" && msg.type !== "REACTION";
  const settings = await getSettings(householdId);
  let media: MediaOutcome = { attachmentId: null, duplicateOf: null, error: null };
  if (processable && msg.media) media = await storeMedia(householdId, sender.member.id, msg, settings.mediaRetentionDays);

  let status: MessageStatus;
  const details: string[] = [];
  if (!processable) {
    status = "IGNORED";
    details.push(msg.type === "TEXT" ? "Mensagem vazia" : `Tipo de mensagem sem relevância financeira (${msg.type})`);
  } else if (media.error) {
    status = "FAILED";
    details.push(`Falha ao obter a mídia: ${media.error}`);
  } else if (!conn.processingEnabled) {
    status = "RECEIVED";
    details.push("Processamento pausado — a mensagem será processada quando for reativado");
  } else {
    status = "QUEUED";
  }
  if (media.duplicateOf) {
    details.unshift(`${DUPLICATE_MEDIA_PREFIX}: anexo ${media.duplicateOf.id} já recebido em ${media.duplicateOf.createdAt.toISOString()}`);
  }

  // 5) Persistência (mensagem + job) atômica
  let created: { messageId: string; job: { id: string; messageId: string; householdId: string; attempts: number; runAfter: Date } | null };
  try {
    created = await prisma.$transaction(async (tx) => {
      const message = await tx.whatsAppMessage.create({
        data: {
          householdId,
          connectionId: conn.id,
          groupId,
          externalId: msg.externalId,
          chatId: msg.chatId,
          direction: "INBOUND",
          senderExternalId: sender.jid ?? sender.lid ?? sender.phone ?? null,
          senderMemberId: sender.member.id,
          type: msg.type,
          text: keepText && rawText ? rawText : null,
          attachmentId: media.attachmentId,
          quotedExternalId: msg.quotedExternalId ?? null,
          sentAt: msg.sentAt,
          status,
          statusDetail: details.length ? details.join(" · ").slice(0, 500) : null,
          processedAt: status === "IGNORED" || status === "FAILED" ? new Date() : null,
        },
      });
      const job =
        status === "QUEUED"
          ? await tx.messageProcessingJob.create({ data: { householdId, messageId: message.id, kind: "PROCESS_MESSAGE" } })
          : null;
      await tx.whatsAppConnection.update({ where: { id: conn.id }, data: { lastMessageAt: new Date() } });
      return { messageId: message.id, job };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      // Evento repetido chegando em paralelo: a outra execução já gravou.
      const again = await prisma.whatsAppMessage.findUnique({
        where: { connectionId_externalId: { connectionId: conn.id, externalId: msg.externalId } },
        select: { id: true, status: true, jobs: { select: { id: true } } },
      });
      return { accepted: true, duplicate: true, messageId: again?.id, jobId: again?.jobs[0]?.id ?? null, status: again?.status };
    }
    throw err;
  }

  if (status === "FAILED") {
    await createPendingItem(prisma, {
      householdId,
      type: "PROCESSING_FAILED",
      title: "Mídia do WhatsApp não pôde ser obtida",
      description: "Não foi possível baixar o arquivo enviado no grupo. Peça para reenviar ou registre o lançamento manualmente.",
      messageId: created.messageId,
      dedupeKey: `failed:${created.messageId}`,
    });
    await publishEvent(householdId, "pending.changed");
  }

  let queued = false;
  if (created.job) {
    const res = await enqueueInboundJob(created.job);
    queued = res.ok;
    if (!res.ok) logger.warn({ jobId: created.job.id, reason: res.reason }, "whatsapp: job não enfileirado (fica PENDING para recuperação)");
  }
  await publishEvent(householdId, "whatsapp.message", created.messageId);
  logger.info({ messageId: created.messageId, type: msg.type, status, duplicateMedia: Boolean(media.duplicateOf) }, "whatsapp: mensagem registrada");
  return { accepted: true, messageId: created.messageId, jobId: created.job?.id ?? null, status, queued };
}
