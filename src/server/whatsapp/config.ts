import type { Prisma, WhatsAppConnection, WhatsAppProviderType } from "@prisma/client";
import { prisma, type Db } from "../db";
import { env } from "../env";

/**
 * Configuração NÃO secreta da conexão (coluna `config`). Também guarda pedidos pendentes
 * (logout, reconexão, sincronização de grupos) para que o worker os execute mesmo se a
 * mensagem de pub/sub se perder — o banco é a fonte da verdade.
 */
export interface ConnectionConfig {
  /** Cloud API: phone-number-id (sobrepõe WHATSAPP_CLOUD_PHONE_NUMBER_ID). */
  phoneNumberId?: string;
  logoutRequestedAt?: string;
  reconnectRequestedAt?: string;
  groupSyncRequestedAt?: string;
}

const KEYS: Array<keyof ConnectionConfig> = ["phoneNumberId", "logoutRequestedAt", "reconnectRequestedAt", "groupSyncRequestedAt"];

export function readConfig(value: Prisma.JsonValue | null | undefined): ConnectionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const out: ConnectionConfig = {};
  for (const k of KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.length <= 200) out[k] = v;
  }
  return out;
}

/** Aplica um patch (null remove a chave) e retorna o novo objeto. */
export function mergeConfig(current: ConnectionConfig, patch: { [K in keyof ConnectionConfig]?: string | null }): ConnectionConfig {
  const next: ConnectionConfig = { ...current };
  for (const k of KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next;
}

export function defaultProvider(): WhatsAppProviderType {
  const p = env().WHATSAPP_DEFAULT_PROVIDER;
  if (p === "SIMULATOR" && !env().WHATSAPP_ENABLE_SIMULATOR) return "BAILEYS";
  return p;
}

/** Garante que a família tenha um registro de conexão (criado desconectado). */
export async function ensureConnection(householdId: string, db: Db = prisma): Promise<WhatsAppConnection> {
  const existing = await db.whatsAppConnection.findUnique({ where: { householdId } });
  if (existing) return existing;
  try {
    return await db.whatsAppConnection.create({ data: { householdId, provider: defaultProvider() } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return db.whatsAppConnection.findUniqueOrThrow({ where: { householdId } });
    throw err;
  }
}

/** Atualiza chaves da configuração com leitura+escrita na mesma transação. */
export async function patchConnectionConfig(
  connectionId: string,
  patch: { [K in keyof ConnectionConfig]?: string | null },
  onlyIf?: { [K in keyof ConnectionConfig]?: string },
): Promise<ConnectionConfig> {
  return prisma.$transaction(async (tx) => {
    const conn = await tx.whatsAppConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { config: true } });
    const current = readConfig(conn.config);
    // Só limpa um pedido se ele ainda for o mesmo que foi lido (evita apagar um pedido novo).
    const effective: { [K in keyof ConnectionConfig]?: string | null } = {};
    for (const [k, v] of Object.entries(patch) as Array<[keyof ConnectionConfig, string | null | undefined]>) {
      const expected = onlyIf?.[k];
      if (expected !== undefined && current[k] !== expected) continue;
      effective[k] = v ?? null;
    }
    const next = mergeConfig(current, effective);
    await tx.whatsAppConnection.update({ where: { id: connectionId }, data: { config: next as Prisma.InputJsonValue } });
    return next;
  });
}
