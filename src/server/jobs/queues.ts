import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import { newRedisConnection } from "../redis";
import { logger } from "../logger";

/**
 * Filas BullMQ. A fila é apenas o despachante: o estado durável fica no PostgreSQL
 * (MessageProcessingJob, WhatsAppMessage). Se o Redis cair, nada se perde — a recuperação
 * periódica reenfileira o que estiver pendente.
 */
export const QUEUE_NAMES = {
  inbound: "whatsapp-inbound",
  outbound: "whatsapp-outbound",
  periodic: "periodic",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface InboundJobData {
  /** Id do MessageProcessingJob. */
  jobId: string;
  messageId: string;
  householdId: string;
}

export type OutboundKind = "reply" | "notification" | "report";

export interface OutboundJobData {
  householdId: string;
  text: string;
  quotedExternalId: string | null;
  /** Hash do dedupeKey (ou aleatório) — identifica o envio de forma idempotente. */
  dedupeHash: string;
  kind: OutboundKind;
  createdAt: string;
}

export interface PeriodicJobData {
  task: string;
}

let prefix = "fa";

/** Prefixo das chaves BullMQ (os testes usam um prefixo exclusivo). Chame antes de criar filas. */
export function setQueuePrefix(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Prefixo de fila inválido");
  prefix = value;
}

export function queuePrefix(): string {
  return prefix;
}

const queues = new Map<string, Queue>();
let producerConnection: Redis | null = null;

function producer(): Redis {
  if (!producerConnection) producerConnection = newRedisConnection("queue-producer");
  return producerConnection;
}

export function getQueue<T = unknown>(name: QueueName): Queue<T> {
  const key = `${prefix}:${name}`;
  let q = queues.get(key);
  if (!q) {
    q = new Queue(name, { connection: producer(), prefix });
    q.on("error", (err) => logger.warn({ err: err.message, queue: name }, "fila: erro"));
    queues.set(key, q);
  }
  return q as unknown as Queue<T>;
}

export function createWorker<T>(name: QueueName, processor: Processor<T>, opts: Partial<Omit<WorkerOptions, "connection" | "prefix">> = {}): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    connection: newRedisConnection(`worker-${name}`),
    prefix,
    concurrency: 1,
    ...opts,
  });
  worker.on("error", (err) => logger.warn({ err: err.message, queue: name }, "worker: erro"));
  return worker;
}

function timeout<T>(ms: number, message: string): { promise: Promise<T>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, cancel: () => timer && clearTimeout(timer) };
}

/** Aguarda a conexão do produtor ficar pronta (falha rápido se o Redis estiver fora). */
export async function producerReady(timeoutMs = 2000): Promise<boolean> {
  const conn = producer();
  if (conn.status === "ready") return true;
  if (conn.status === "end" || conn.status === "close") return false;
  const t = timeout<boolean>(timeoutMs, "timeout");
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        conn.once("ready", () => resolve(true));
      }),
      t.promise,
    ]);
  } catch {
    return false;
  } finally {
    t.cancel();
  }
}

export type AddJobResult = { ok: true; id: string; existed: boolean } | { ok: false; reason: string };

/**
 * Adiciona um job com tempo limite. Com `jobId`, a BullMQ ignora duplicatas enquanto o job existir.
 * Nunca lança: retorna { ok: false, reason } se o Redis estiver indisponível.
 */
export async function addJob<T>(name: QueueName, jobName: string, data: T, opts: JobsOptions = {}, timeoutMs = 3000): Promise<AddJobResult> {
  try {
    if (!(await producerReady(timeoutMs))) return { ok: false, reason: "Fila indisponível (Redis fora do ar)" };
    const queue = getQueue<T>(name);
    if (opts.jobId) {
      const existing = await queue.getJob(opts.jobId);
      if (existing) return { ok: true, id: opts.jobId, existed: true };
    }
    const t = timeout<never>(timeoutMs, "Tempo esgotado ao enfileirar");
    try {
      const job = await Promise.race([queue.add(jobName as never, data as never, opts), t.promise]);
      return { ok: true, id: String(job.id ?? opts.jobId ?? ""), existed: false };
    } finally {
      t.cancel();
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message.slice(0, 200) };
  }
}

/** Fecha filas e a conexão do produtor (encerramento gracioso e testes). */
export async function closeQueues(): Promise<void> {
  const all = [...queues.values()];
  queues.clear();
  await Promise.allSettled(all.map((q) => q.close()));
  if (producerConnection) {
    const conn = producerConnection;
    producerConnection = null;
    try {
      await conn.quit();
    } catch {
      conn.disconnect();
    }
  }
}
