import { randomUUID } from "node:crypto";
import type { WhatsAppConnection } from "@prisma/client";
import type { OutboundMessageInput } from "./outbound";
import { prisma } from "../db";
import { sha256Hex } from "../crypto";
import { redis } from "../redis";
import { addJob, QUEUE_NAMES, type OutboundJobData } from "../jobs/queues";
import { outboundDoneKey } from "./keys";
import { PROVIDER_CAPABILITIES } from "./types";

/**
 * Envio de mensagens (lado produtor). Pode ser chamado de qualquer processo (API ou worker):
 * apenas grava na fila BullMQ "whatsapp-outbound". O worker consome e entrega pelo provedor ativo,
 * SEMPRE no chat autorizado da família (grupo autorizado; na Cloud API, a conversa dos membros autorizados).
 */

export const OUTBOUND_MAX_TEXT = 4000;
export const OUTBOUND_JOB_ATTEMPTS = 6;

/** Hash estável do dedupeKey (por família) — vira o jobId da BullMQ (sem ":"). */
export function outboundDedupeHash(householdId: string, dedupeKey: string | null | undefined): string {
  return dedupeKey ? sha256Hex(`${householdId}|${dedupeKey}`).slice(0, 40) : randomUUID().replace(/-/g, "");
}

export function outboundJobId(hash: string): string {
  return `out-${hash}`;
}

/** Existe um destino autorizado para envio? (sem considerar o estado da conexão) */
export async function hasSendTarget(conn: Pick<WhatsAppConnection, "id" | "householdId" | "provider">): Promise<boolean> {
  if (conn.provider === "CLOUD_API") {
    const members = await prisma.householdMember.count({
      where: { householdId: conn.householdId, isActive: true, whatsappAuthorized: true, whatsappConsentAt: { not: null }, whatsappPhone: { not: null } },
    });
    return members > 0;
  }
  const group = await prisma.whatsAppGroup.findFirst({ where: { connectionId: conn.id, isAuthorized: true }, select: { id: true } });
  return Boolean(group);
}

function truncate(text: string): string {
  return text.length > OUTBOUND_MAX_TEXT ? `${text.slice(0, OUTBOUND_MAX_TEXT - 1)}…` : text;
}

export async function enqueueOutboundMessage(input: OutboundMessageInput): Promise<{ queued: boolean; reason?: string }> {
  const text = input.text?.trim();
  if (!text) return { queued: false, reason: "Mensagem vazia" };
  const conn = await prisma.whatsAppConnection.findUnique({
    where: { householdId: input.householdId },
    select: { id: true, householdId: true, provider: true },
  });
  if (!conn) return { queued: false, reason: "WhatsApp não configurado" };
  if (!PROVIDER_CAPABILITIES[conn.provider].sendMessages) return { queued: false, reason: "O provedor atual não permite envio de mensagens" };
  if (!(await hasSendTarget(conn))) {
    return {
      queued: false,
      reason: conn.provider === "CLOUD_API" ? "Nenhum membro autorizado e com consentimento para receber mensagens" : "Nenhum grupo autorizado",
    };
  }
  const dedupeHash = outboundDedupeHash(input.householdId, input.dedupeKey);
  if (input.dedupeKey) {
    try {
      const r = redis();
      if (r.status === "ready" && (await r.exists(outboundDoneKey(dedupeHash))) === 1) {
        return { queued: true, reason: "Mensagem já enviada anteriormente (deduplicada)" };
      }
    } catch {
      // segue: a BullMQ e o consumidor também deduplicam
    }
  }
  const data: OutboundJobData = {
    householdId: input.householdId,
    text: truncate(text),
    quotedExternalId: input.quotedExternalId ?? null,
    dedupeHash,
    kind: input.kind ?? "notification",
    createdAt: new Date().toISOString(),
  };
  const res = await addJob(QUEUE_NAMES.outbound, data.kind, data, {
    jobId: outboundJobId(dedupeHash),
    attempts: OUTBOUND_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    // Mantém o histórico para que um novo pedido com o mesmo dedupeKey seja ignorado.
    removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  });
  if (!res.ok) return { queued: false, reason: res.reason };
  return res.existed ? { queued: true, reason: "Mensagem já estava na fila (deduplicada)" } : { queued: true };
}

/** Pode enviar agora? Conexão CONNECTED + destino autorizado + provedor com envio. */
export async function whatsappCanSend(householdId: string): Promise<boolean> {
  const conn = await prisma.whatsAppConnection.findUnique({
    where: { householdId },
    select: { id: true, householdId: true, provider: true, status: true },
  });
  if (!conn || conn.status !== "CONNECTED") return false;
  if (!PROVIDER_CAPABILITIES[conn.provider].sendMessages) return false;
  return hasSendTarget(conn);
}
