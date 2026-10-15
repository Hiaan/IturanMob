import { redis } from "./redis";
import { RateLimitError } from "./errors";

/**
 * Rate limiting por janela fixa. Usa Redis (compartilhado entre instâncias);
 * se o Redis estiver indisponível, recorre a um contador em memória do processo.
 */
const memory = new Map<string, { count: number; resetAt: number }>();

async function hit(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> {
  if (process.env.NODE_ENV !== "test") {
    try {
      const r = redis();
      if (r.status === "ready") {
        const fullKey = `fa:rl:${key}`;
        const count = await r.incr(fullKey);
        if (count === 1) await r.expire(fullKey, windowSeconds);
        const ttl = await r.ttl(fullKey);
        return { count, ttl: ttl > 0 ? ttl : windowSeconds };
      }
    } catch {
      // cai para memória
    }
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { count: 1, ttl: windowSeconds };
  }
  entry.count++;
  return { count: entry.count, ttl: Math.ceil((entry.resetAt - now) / 1000) };
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const { count, ttl } = await hit(key, windowSeconds);
  if (count > limit) throw new RateLimitError(ttl);
}

export function resetMemoryRateLimits() {
  memory.clear();
}
