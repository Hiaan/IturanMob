import type { Redis } from "ioredis";
import { publishEvent, type RealtimeEventType } from "../events";
import { redis } from "../redis";

/**
 * Acesso ao Redis que NUNCA trava o fluxo principal. O cliente compartilhado usa
 * `maxRetriesPerRequest: null`, então, com o Redis fora do ar, um comando ficaria pendente
 * indefinidamente. Aqui: se a conexão não estiver utilizável, devolve o valor padrão na hora;
 * caso contrário, limita a espera. Ingestão e processamento continuam pelo PostgreSQL.
 */

const USABLE = new Set(["ready", "connect", "connecting"]);

export function redisUsable(): boolean {
  try {
    return USABLE.has(redis().status);
  } catch {
    return false;
  }
}

export async function withRedis<T>(fn: (r: Redis) => Promise<T>, fallback: T, timeoutMs = 1500): Promise<T> {
  if (!redisUsable()) return fallback;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(redis()),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Evento de tempo real (melhor esforço, sem conteúdo sensível) que não bloqueia sem Redis. */
export async function emitEvent(householdId: string, type: RealtimeEventType, entityId?: string): Promise<void> {
  await withRedis(() => publishEvent(householdId, type, entityId), undefined, 1000);
}
