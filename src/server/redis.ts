import { Redis } from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

const globalForRedis = globalThis as unknown as { __redis?: Redis | null; __redisSub?: Redis | null };

function create(name: string): Redis {
  const client = new Redis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: `finance-ai:${name}`,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
  client.on("error", (err) => logger.warn({ err: err.message, client: name }, "redis: erro de conexão"));
  return client;
}

/** Cliente Redis compartilhado (comandos). */
export function redis(): Redis {
  if (!globalForRedis.__redis) globalForRedis.__redis = create("main");
  return globalForRedis.__redis;
}

/** Nova conexão dedicada (BullMQ e assinaturas pub/sub exigem conexões próprias). */
export function newRedisConnection(name: string): Redis {
  return create(name);
}

/** Verifica se o Redis responde (usado no health check). */
export async function redisHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await Promise.race([
      redis().ping(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return res === "PONG";
  } catch {
    return false;
  }
}
