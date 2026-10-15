import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap } from "baileys";
import { prisma } from "../../db";
import { decryptString, encryptString } from "../../crypto";
import { logger } from "../../logger";

/**
 * Estado de autenticação do Baileys persistido no PostgreSQL (WhatsAppAuthState), CRIPTOGRAFADO
 * com AES-256-GCM (encryptString). Adaptação do `useMultiFileAuthState` do Baileys: cada "arquivo"
 * vira uma linha (connectionId, key) e o JSON é serializado com BufferJSON antes de criptografar.
 * O conteúdo nunca é registrado em logs.
 */

export const CREDS_KEY = "creds";

export function serializeAuthValue(value: unknown): string {
  return encryptString(JSON.stringify(value, BufferJSON.replacer));
}

export function deserializeAuthValue<T>(stored: string): T {
  return JSON.parse(decryptString(stored), BufferJSON.reviver) as T;
}

function keyName(type: string, id: string): string {
  return `${type}-${id}`;
}

export interface DatabaseAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Apaga todas as credenciais (logout). */
  clear: () => Promise<void>;
}

export async function clearAuthState(connectionId: string): Promise<number> {
  const res = await prisma.whatsAppAuthState.deleteMany({ where: { connectionId } });
  return res.count;
}

export async function hasStoredCreds(connectionId: string): Promise<boolean> {
  const row = await prisma.whatsAppAuthState.findUnique({ where: { connectionId_key: { connectionId, key: CREDS_KEY } }, select: { id: true } });
  return Boolean(row);
}

export async function useDatabaseAuthState(connectionId: string): Promise<DatabaseAuthState> {
  const readKey = async <T>(key: string): Promise<T | null> => {
    const row = await prisma.whatsAppAuthState.findUnique({ where: { connectionId_key: { connectionId, key } } });
    if (!row) return null;
    try {
      return deserializeAuthValue<T>(row.value);
    } catch {
      logger.warn({ connectionId }, "whatsapp: credencial ilegível (ENCRYPTION_KEY alterada?) — será necessário ler o QR Code novamente");
      return null;
    }
  };

  const writeKey = async (key: string, value: unknown) => {
    const encrypted = serializeAuthValue(value);
    await prisma.whatsAppAuthState.upsert({
      where: { connectionId_key: { connectionId, key } },
      create: { connectionId, key, value: encrypted },
      update: { value: encrypted },
    });
  };

  const creds: AuthenticationCreds = (await readKey<AuthenticationCreds>(CREDS_KEY)) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          if (!ids.length) return data;
          const rows = await prisma.whatsAppAuthState.findMany({
            where: { connectionId, key: { in: ids.map((id) => keyName(type, id)) } },
            select: { key: true, value: true },
          });
          const byKey = new Map(rows.map((r) => [r.key, r.value]));
          for (const id of ids) {
            const raw = byKey.get(keyName(type, id));
            if (!raw) continue;
            try {
              let value = deserializeAuthValue<unknown>(raw);
              if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
              data[id] = value as SignalDataTypeMap[T];
            } catch {
              logger.warn({ connectionId, type }, "whatsapp: chave de sinal ilegível ignorada");
            }
          }
          return data;
        },
        set: async (data: SignalDataSet) => {
          const upserts: Array<{ key: string; value: string }> = [];
          const deletes: string[] = [];
          for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
            const entries = data[category];
            if (!entries) continue;
            for (const id of Object.keys(entries)) {
              const value = entries[id];
              const key = keyName(category, id);
              if (value) upserts.push({ key, value: serializeAuthValue(value) });
              else deletes.push(key);
            }
          }
          if (!upserts.length && !deletes.length) return;
          await prisma.$transaction([
            ...upserts.map((u) =>
              prisma.whatsAppAuthState.upsert({
                where: { connectionId_key: { connectionId, key: u.key } },
                create: { connectionId, key: u.key, value: u.value },
                update: { value: u.value },
              }),
            ),
            ...(deletes.length ? [prisma.whatsAppAuthState.deleteMany({ where: { connectionId, key: { in: deletes } } })] : []),
          ]);
        },
        clear: async () => {
          await prisma.whatsAppAuthState.deleteMany({ where: { connectionId, key: { not: CREDS_KEY } } });
        },
      },
    },
    saveCreds: () => writeKey(CREDS_KEY, creds),
    clear: async () => {
      await clearAuthState(connectionId);
    },
  };
}
