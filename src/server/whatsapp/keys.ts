/** Chaves e canais Redis usados pela integração com o WhatsApp (sem conteúdo sensível nos nomes). */

export const WA_COMMANDS_CHANNEL = "fa:wa:commands";
export const WORKER_HEARTBEAT_KEY = "fa:worker:heartbeat";

/** QR Code atual (texto do QR, nunca registrado em logs). */
export const qrKey = (householdId: string) => `fa:wa:qr:${householdId}`;
export const QR_TTL_SECONDS = 60;

/** Mensagens enviadas pelo bot (para ignorar o "eco" das próprias mensagens). */
export const botSentKey = (connectionId: string, externalId: string) => `fa:wa:sent:${connectionId}:${externalId}`;
export const BOT_SENT_TTL_SECONDS = 7 * 24 * 3600;

/** Marca de idempotência de envio (após entrega bem-sucedida). */
export const outboundDoneKey = (hash: string) => `fa:wa:outdone:${hash}`;
export const OUTBOUND_DONE_TTL_SECONDS = 30 * 24 * 3600;

/** Limites de taxa de envio por família. */
export const outboundSecondKey = (householdId: string) => `fa:wa:rl:sec:${householdId}`;
export const outboundHourKey = (householdId: string, hourBucket: number) => `fa:wa:rl:hour:${householdId}:${hourBucket}`;
