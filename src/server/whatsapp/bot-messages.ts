import { prisma } from "../db";
import { env } from "../env";
import { withRedis } from "./redis-safe";
import { BOT_SENT_TTL_SECONDS, botSentKey } from "./keys";

/**
 * Rastreamento das mensagens enviadas pelo próprio bot. Como o número conectado pode ser de um
 * dos cônjuges, mensagens "fromMe" são processadas como desse membro — EXCETO as do bot, que
 * são reconhecidas por: (1) externalId registrado no envio (memória + Redis + banco) e
 * (2) texto iniciando com WHATSAPP_BOT_PREFIX.
 */

const MAX_MEMORY = 2000;
const recent = new Map<string, number>();

function memKey(connectionId: string, externalId: string) {
  return `${connectionId}|${externalId}`;
}

export function botPrefix(): string {
  return env().WHATSAPP_BOT_PREFIX;
}

/** Aplica o prefixo do bot ao texto (sem duplicar). */
export function withBotPrefix(text: string): string {
  const prefix = botPrefix();
  const trimmed = text.trim();
  if (!prefix) return trimmed;
  return trimmed.startsWith(prefix) ? trimmed : `${prefix} ${trimmed}`;
}

export function hasBotPrefix(text: string | null | undefined): boolean {
  const prefix = botPrefix();
  if (!prefix || !text) return false;
  return text.trimStart().startsWith(prefix);
}

/** Registra um externalId enviado pelo bot (memória imediatamente; Redis como melhor esforço). */
export async function markSentByBot(connectionId: string, externalId: string): Promise<void> {
  recent.set(memKey(connectionId, externalId), Date.now());
  if (recent.size > MAX_MEMORY) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
  // Melhor esforço: o banco (WhatsAppMessage OUTBOUND) e o prefixo continuam valendo sem Redis.
  await withRedis((r) => r.set(botSentKey(connectionId, externalId), "1", "EX", BOT_SENT_TTL_SECONDS), null);
}

export async function wasSentByBot(connectionId: string, externalId: string): Promise<boolean> {
  if (recent.has(memKey(connectionId, externalId))) return true;
  const outbound = await prisma.whatsAppMessage.findUnique({
    where: { connectionId_externalId: { connectionId, externalId } },
    select: { direction: true },
  });
  if (outbound?.direction === "OUTBOUND") return true;
  return withRedis(async (r) => (await r.exists(botSentKey(connectionId, externalId))) === 1, false);
}
