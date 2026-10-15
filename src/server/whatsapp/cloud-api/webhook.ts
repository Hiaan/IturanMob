import type { WhatsAppConnection } from "@prisma/client";
import { prisma } from "../../db";
import { env } from "../../env";
import { logger } from "../../logger";
import { readConfig } from "../config";
import { ingestMessage } from "../ingest";
import { cloudConfig, parseCloudWebhook } from "./provider";

/**
 * Webhook da Cloud API: identifica a família de destino e passa cada mensagem pelo MESMO ingest
 * (que persiste/enfileira rapidamente). Família alvo: WHATSAPP_CLOUD_HOUSEHOLD_ID ou a única
 * conexão com provedor CLOUD_API (havendo várias, casa pelo phone-number-id configurado).
 */

async function resolveConnection(phoneNumberId: string | null): Promise<WhatsAppConnection | null> {
  const fixed = env().WHATSAPP_CLOUD_HOUSEHOLD_ID;
  if (fixed) {
    const conn = await prisma.whatsAppConnection.findUnique({ where: { householdId: fixed } });
    return conn?.provider === "CLOUD_API" ? conn : null;
  }
  const conns = await prisma.whatsAppConnection.findMany({ where: { provider: "CLOUD_API" } });
  if (conns.length === 1) return conns[0]!;
  if (!phoneNumberId) return null;
  return conns.find((c) => (readConfig(c.config).phoneNumberId ?? env().WHATSAPP_CLOUD_PHONE_NUMBER_ID) === phoneNumberId) ?? null;
}

export interface CloudWebhookResult {
  received: number;
  accepted: number;
  skipped: number;
}

export async function handleCloudWebhook(payload: unknown): Promise<CloudWebhookResult> {
  const preview = parseCloudWebhook(payload, null);
  const result: CloudWebhookResult = { received: preview.length, accepted: 0, skipped: 0 };
  if (!preview.length) return result;

  const byNumber = new Map<string | null, WhatsAppConnection | null>();
  for (const item of preview) {
    if (!byNumber.has(item.phoneNumberId)) byNumber.set(item.phoneNumberId, await resolveConnection(item.phoneNumberId));
  }
  for (const [phoneNumberId, conn] of byNumber) {
    if (!conn) {
      result.skipped += preview.filter((p) => p.phoneNumberId === phoneNumberId).length;
      logger.warn("whatsapp: webhook da Cloud API sem família de destino (mensagens descartadas)");
      continue;
    }
    const cfg = cloudConfig(readConfig(conn.config));
    // Eventos de outro número do mesmo aplicativo não pertencem a esta família.
    if (cfg && phoneNumberId && cfg.phoneNumberId !== phoneNumberId) {
      result.skipped += preview.filter((p) => p.phoneNumberId === phoneNumberId).length;
      continue;
    }
    const messages = parseCloudWebhook(payload, cfg).filter((p) => p.phoneNumberId === phoneNumberId);
    for (const { message } of messages) {
      const res = await ingestMessage({ id: conn.id, householdId: conn.householdId }, message);
      if (res.accepted) result.accepted++;
      else result.skipped++;
    }
  }
  return result;
}
