import { randomUUID } from "node:crypto";
import { prisma } from "../../db";
import { publishEvent } from "../../events";
import { markSentByBot, withBotPrefix } from "../bot-messages";

/**
 * SIMULADOR — registra uma resposta do bot como mensagem OUTBOUND simulada (visível na UI).
 * Usado quando o worker não está em execução (processamento em linha). Nada é enviado a um
 * WhatsApp real.
 */
export async function recordSimulatorReply(householdId: string, text: string, quotedExternalId: string | null): Promise<string | null> {
  const conn = await prisma.whatsAppConnection.findUnique({ where: { householdId }, select: { id: true, provider: true } });
  if (!conn || conn.provider !== "SIMULATOR") return null;
  const group = await prisma.whatsAppGroup.findFirst({ where: { connectionId: conn.id, isAuthorized: true }, select: { id: true, externalId: true } });
  if (!group) return null;
  const externalId = `SIM-OUT-${randomUUID()}`;
  await markSentByBot(conn.id, externalId);
  const row = await prisma.whatsAppMessage.create({
    data: {
      householdId,
      connectionId: conn.id,
      groupId: group.id,
      externalId,
      chatId: group.externalId,
      direction: "OUTBOUND",
      type: "TEXT",
      text: withBotPrefix(text),
      quotedExternalId,
      sentAt: new Date(),
      status: "PROCESSED",
      processedAt: new Date(),
      statusDetail: "Resposta simulada (simulador — nenhum envio real)",
    },
  });
  await publishEvent(householdId, "whatsapp.message", row.id);
  return row.id;
}
