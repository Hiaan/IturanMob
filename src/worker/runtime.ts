import type { Job, Worker } from "bullmq";
import { env } from "../server/env";
import { prisma } from "../server/db";
import { redis } from "../server/redis";
import { errorInfo, logger } from "../server/logger";
import {
  closeQueues,
  createWorker,
  getQueue,
  producerReady,
  QUEUE_NAMES,
  type InboundJobData,
  type MigrationJobData,
  type OutboundJobData,
  type PeriodicJobData,
} from "../server/jobs/queues";
import type { PeriodicTask } from "../server/jobs/periodic";
import { getConnectionManager } from "../server/whatsapp/connection-manager";
import { WORKER_HEARTBEAT_KEY } from "../server/whatsapp/keys";
import { makeOutboundProcessor } from "../server/whatsapp/outbound-consumer";
import { processInboundBullJob } from "../server/whatsapp/processor";
import { recoverStuckJobs } from "../server/whatsapp/recovery";

const HEARTBEAT_MS = 30_000;
const TASK_RELOAD_MS = 60_000;

/** Id do agendador (a BullMQ não aceita ":" em ids de job). */
export function schedulerId(taskName: string): string {
  return `task-${taskName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

async function heartbeat() {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Com o Redis fora do ar o comando ficaria pendente: limita a espera.
    await Promise.race([
      redis().set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), "EX", 120),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), 3000))),
    ]);
  } catch {
    // Redis indisponível: o health check mostrará o worker como degradado.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      logger.warn({ attempt, err: errorInfo(err).message }, "worker: aguardando o banco de dados");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export interface WorkerRuntime {
  stop(signal?: string): Promise<void>;
}

export async function startWorker(): Promise<WorkerRuntime> {
  const config = env();
  logger.info({ concurrency: config.WORKER_CONCURRENCY, defaultProvider: config.WHATSAPP_DEFAULT_PROVIDER }, "worker: iniciando");
  await waitForDatabase();
  if (!(await producerReady(5000))) logger.warn("worker: Redis indisponível no início — filas e QR Code ficarão inativos até reconectar");

  // 1) Conexões do WhatsApp
  const manager = getConnectionManager();
  await manager.start();

  // 2) Filas do WhatsApp
  const workers: Worker[] = [];
  const inbound = createWorker<InboundJobData>(QUEUE_NAMES.inbound, processInboundBullJob, { concurrency: config.WORKER_CONCURRENCY });
  inbound.on("failed", (job, err) => logger.warn({ jobId: job?.id, err: err.message.slice(0, 200) }, "worker: job de processamento falhou"));
  workers.push(inbound as unknown as Worker);
  // Envio: concorrência 1 (o limite de taxa por família é aplicado no consumidor).
  const outbound = createWorker<OutboundJobData>(QUEUE_NAMES.outbound, makeOutboundProcessor(manager), { concurrency: 1 });
  outbound.on("failed", (job, err) =>
    logger.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message.slice(0, 200) }, "worker: envio de mensagem falhou"),
  );
  workers.push(outbound as unknown as Worker);
  // Migração de planilha (leitura, prévia, importação): uma por vez, sem novas tentativas automáticas
  // (o estado fica no banco; a pessoa repete a etapa pela tela).
  const imports = createWorker<MigrationJobData>(
    QUEUE_NAMES.imports,
    async (job: Job<MigrationJobData>) => {
      const { runMigrationJob } = await import("../server/modules/migration/jobs");
      await runMigrationJob(job.data);
    },
    { concurrency: 1, lockDuration: 10 * 60_000 },
  );
  imports.on("failed", (job, err) => logger.warn({ jobId: job?.id, err: err.message.slice(0, 200) }, "worker: etapa da migração falhou"));
  workers.push(imports as unknown as Worker);

  // 3) Tarefas periódicas (jobs repetíveis)
  const tasks = new Map<string, PeriodicTask>();
  const periodicQueue = getQueue<PeriodicJobData>(QUEUE_NAMES.periodic);
  const loadTasks = async (): Promise<PeriodicTask[]> => {
    const { loadPeriodicTasks } = await import("../server/jobs/periodic");
    const list = await loadPeriodicTasks();
    tasks.clear();
    for (const t of list) tasks.set(t.name, t);
    return list;
  };

  let reloadTimer: NodeJS.Timeout | null = null;
  const scheduleTasks = async () => {
    try {
      const list = await loadTasks();
      const wanted = new Set(list.map((t) => schedulerId(t.name)));
      for (const t of list) {
        await periodicQueue.upsertJobScheduler(
          schedulerId(t.name),
          { every: Math.max(10, t.everySeconds) * 1000 },
          { name: t.name, data: { task: t.name }, opts: { removeOnComplete: 50, removeOnFail: 100 } },
        );
      }
      for (const s of await periodicQueue.getJobSchedulers()) {
        const id = s.id ?? s.key;
        if (id && !wanted.has(id)) await periodicQueue.removeJobScheduler(id);
      }
      logger.info({ tasks: list.map((t) => t.name) }, "worker: tarefas periódicas agendadas");
    } catch (err) {
      logger.error({ err: errorInfo(err) }, "worker: falha ao carregar/agendar tarefas periódicas — nova tentativa em 60 s");
      reloadTimer = setTimeout(() => void scheduleTasks(), TASK_RELOAD_MS);
    }
  };
  // Carrega as tarefas ANTES de começar a consumir a fila (jobs vencidos de execuções anteriores).
  if (await producerReady(2000)) await scheduleTasks();
  else {
    logger.warn("worker: Redis indisponível — as tarefas periódicas serão agendadas quando ele voltar");
    void scheduleTasks();
  }

  const periodic = createWorker<PeriodicJobData>(
    QUEUE_NAMES.periodic,
    async (job: Job<PeriodicJobData>) => {
      const name = job.data?.task ?? job.name;
      if (!tasks.has(name)) await loadTasks().catch(() => undefined);
      const task = tasks.get(name);
      if (!task) {
        logger.warn({ task: name }, "worker: tarefa periódica desconhecida");
        return;
      }
      const started = Date.now();
      try {
        const result = await task.run();
        logger.info({ task: name, ms: Date.now() - started, result: typeof result === "number" ? result : undefined }, "worker: tarefa periódica concluída");
      } catch (err) {
        logger.error({ task: name, ms: Date.now() - started, err: errorInfo(err) }, "worker: tarefa periódica falhou");
      }
    },
    { concurrency: 1 },
  );
  workers.push(periodic as unknown as Worker);

  // 4) Heartbeat e recuperação inicial
  await heartbeat();
  const hbTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  void recoverStuckJobs().catch((err) => logger.warn({ err: errorInfo(err).message }, "worker: recuperação inicial falhou"));

  logger.info("worker: em execução");

  return {
    async stop(signal?: string) {
      logger.info({ signal }, "worker: encerrando");
      clearInterval(hbTimer);
      if (reloadTimer) clearTimeout(reloadTimer);
      // Para de consumir (aguarda os jobs em andamento) antes de derrubar as conexões.
      await Promise.allSettled(workers.map((w) => w.close()));
      await manager.stop();
      await closeQueues();
      try {
        await redis().del(WORKER_HEARTBEAT_KEY);
        await redis().quit();
      } catch {
        // ignora
      }
      await prisma.$disconnect();
      logger.info("worker: encerrado");
    },
  };
}
