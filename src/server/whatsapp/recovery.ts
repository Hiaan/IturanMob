import { prisma } from "../db";
import { errorInfo, logger } from "../logger";
import { getQueue, producerReady, QUEUE_NAMES } from "../jobs/queues";
import { enqueueInboundJob, inboundBullJobId } from "./inbound-queue";
import { isProcessableType } from "./ingest";

/**
 * RECUPERAÇÃO — garante que nenhum job de processamento fique esquecido. Idempotente.
 * 1. RUNNING há mais de 10 min (worker caiu no meio) → volta a PENDING.
 * 2. PENDING com runAfter <= agora e ausente da fila BullMQ → reenfileira.
 * 3. Mensagens RECEIVED (processamento estava pausado) de conexões com processamento ativo → cria o job.
 * Retorna quantos jobs foram (re)enfileirados.
 */
export const STUCK_AFTER_MS = 10 * 60 * 1000;
const ACTIVE_STATES = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children"]);

/**
 * Cria jobs para mensagens RECEIVED (processamento estava pausado) de conexões com processamento ativo.
 * Retorna os jobs criados (ainda não enfileirados na BullMQ).
 */
export async function queueReceivedMessages(householdId?: string, now: Date = new Date()) {
  const received = await prisma.whatsAppMessage.findMany({
    where: {
      direction: "INBOUND",
      status: "RECEIVED",
      jobs: { none: {} },
      connection: { processingEnabled: true },
      ...(householdId ? { householdId } : {}),
    },
    select: { id: true, householdId: true, type: true, text: true, attachment: { select: { mimeType: true } } },
    orderBy: { sentAt: "asc" },
    take: 500,
  });
  const jobs: Array<{ id: string; messageId: string; householdId: string; attempts: number; runAfter: Date }> = [];
  for (const m of received) {
    const ok = isProcessableType(m.type, { hasText: Boolean(m.text?.trim()), hasMedia: Boolean(m.attachment), mimeType: m.attachment?.mimeType });
    const job = await prisma.$transaction(async (tx) => {
      if (!ok) {
        await tx.whatsAppMessage.update({ where: { id: m.id }, data: { status: "IGNORED", statusDetail: "Tipo de mensagem não processável", processedAt: now } });
        return null;
      }
      const j = await tx.messageProcessingJob.upsert({
        where: { messageId_kind: { messageId: m.id, kind: "PROCESS_MESSAGE" } },
        create: { householdId: m.householdId, messageId: m.id, kind: "PROCESS_MESSAGE", runAfter: now },
        update: {},
      });
      await tx.whatsAppMessage.update({ where: { id: m.id }, data: { status: "QUEUED", statusDetail: null } });
      return j;
    });
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function recoverStuckJobs(now: Date = new Date()): Promise<number> {
  // 1) Execuções interrompidas
  const stuck = await prisma.messageProcessingJob.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
    data: { status: "PENDING", runAfter: now, lastError: "Execução interrompida (recuperada automaticamente)" },
  });
  if (stuck.count) logger.warn({ count: stuck.count }, "whatsapp: jobs travados devolvidos à fila");

  // 3) Mensagens recebidas com o processamento pausado e que agora podem ser processadas
  await queueReceivedMessages(undefined, now);

  // 2) Pendentes vencidos fora da fila
  if (!(await producerReady())) {
    logger.warn("whatsapp: recuperação sem Redis — os jobs continuam PENDING no banco");
    return 0;
  }
  const due = await prisma.messageProcessingJob.findMany({
    where: { status: "PENDING", runAfter: { lte: now } },
    orderBy: { runAfter: "asc" },
    take: 500,
  });
  const queue = getQueue(QUEUE_NAMES.inbound);
  let requeued = 0;
  for (const job of due) {
    try {
      const bullId = inboundBullJobId(job);
      const existing = await queue.getJob(bullId);
      if (existing) {
        const state = await existing.getState();
        if (ACTIVE_STATES.has(state)) continue;
        // Resto de uma execução anterior (concluída/falha): remove para poder reenfileirar.
        await existing.remove().catch(() => undefined);
      }
      const res = await enqueueInboundJob(job);
      if (res.ok && !res.existed) requeued++;
    } catch (err) {
      logger.warn({ jobId: job.id, err: errorInfo(err).message }, "whatsapp: falha ao reenfileirar job");
    }
  }
  if (requeued) logger.info({ requeued }, "whatsapp: jobs reenfileirados pela recuperação");
  return requeued;
}
