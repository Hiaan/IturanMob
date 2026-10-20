import type { Job } from "bullmq";
import type { MessageProcessingJob } from "@prisma/client";
import { prisma } from "../db";
import { emitEvent as publishEvent } from "./redis-safe";
import { errorInfo, logger } from "../logger";
import type { ServiceContext } from "../auth/context";
import { assertCan } from "../auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { audit } from "../modules/audit/service";
import { createPendingItem, resolvePendingWhere } from "../modules/pending/service";
import { getSettings } from "../modules/households/service";
import { handleInboundMessage } from "../ai/pipeline/handle-message";
import type { InboundMessageResult, ReplyDocument } from "../ai/pipeline/types";
import type { InboundJobData } from "../jobs/queues";
import { enqueueOutboundMessage } from "./outbound";
import { enqueueInboundJob } from "./inbound-queue";
import { isProcessableType } from "./ingest";
import { recordSimulatorReply } from "./simulator/record";
import { deleteStoredFile } from "../storage";

/**
 * PROCESSAMENTO — consumidor da fila "whatsapp-inbound".
 * O registro durável é o MessageProcessingJob (a BullMQ só despacha). Cada execução:
 * PENDING → RUNNING (claim atômico, attempts++) → motor de IA → SUCCEEDED/FAILED, ou nova tentativa
 * com backoff exponencial (runAfter), ou DEAD após maxAttempts (+ PendingItem PROCESSING_FAILED).
 */

export const STUCK_RUNNING_MS = 10 * 60 * 1000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function processingBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export interface ProcessOptions {
  /** Modo do simulador sem worker: as respostas são registradas direto como mensagens simuladas. */
  inlineSimulator?: boolean;
}

export type ProcessOutcome =
  | { outcome: "SKIPPED"; reason: string }
  | { outcome: "SUCCEEDED" | "FAILED"; messageStatus: InboundMessageResult["status"]; replies: number }
  | { outcome: "RETRY_SCHEDULED"; attempts: number; runAfter: Date }
  | { outcome: "DEAD"; attempts: number };

async function markDead(job: Pick<MessageProcessingJob, "id" | "messageId" | "householdId">, attempts: number, error: string): Promise<ProcessOutcome> {
  const message = await prisma.whatsAppMessage.findUnique({ where: { id: job.messageId }, select: { attachmentId: true } });
  await prisma.$transaction([
    prisma.messageProcessingJob.update({ where: { id: job.id }, data: { status: "DEAD", lastError: error, finishedAt: new Date() } }),
    prisma.whatsAppMessage.update({
      where: { id: job.messageId },
      data: { status: "FAILED", statusDetail: `Falha após ${attempts} tentativa(s): ${error}`.slice(0, 500), processedAt: new Date() },
    }),
  ]);
  await createPendingItem(prisma, {
    householdId: job.householdId,
    type: "PROCESSING_FAILED",
    title: "Mensagem do WhatsApp não processada",
    description: `Não foi possível processar a mensagem após ${attempts} tentativa(s). Reprocesse pela tela do WhatsApp ou registre o lançamento manualmente.`,
    messageId: job.messageId,
    attachmentId: message?.attachmentId ?? null,
    dedupeKey: `failed:${job.messageId}`,
  });
  await publishEvent(job.householdId, "pending.changed");
  await publishEvent(job.householdId, "whatsapp.message", job.messageId);
  logger.warn({ jobId: job.id, attempts }, "whatsapp: processamento esgotou as tentativas (DEAD)");
  return { outcome: "DEAD", attempts };
}

async function deliverReplies(
  householdId: string,
  messageId: string,
  quotedExternalId: string,
  replies: string[],
  opts: ProcessOptions,
  documents: ReplyDocument[] = [],
): Promise<number> {
  const settings = await getSettings(householdId);
  if (!settings.whatsappReplies) {
    for (const doc of documents) await deleteStoredFile(doc.storageKey).catch(() => undefined);
    return 0;
  }
  let count = 0;
  for (const [i, reply] of replies.entries()) {
    if (!reply?.trim()) continue;
    if (opts.inlineSimulator) {
      await recordSimulatorReply(householdId, reply, quotedExternalId);
      count++;
      continue;
    }
    const res = await enqueueOutboundMessage({ householdId, text: reply, kind: "reply", quotedExternalId, dedupeKey: `reply:${messageId}:${i}` });
    if (res.queued) count++;
    else logger.warn({ messageId, reason: res.reason }, "whatsapp: resposta não enfileirada");
  }
  for (const [i, doc] of documents.entries()) {
    if (opts.inlineSimulator) {
      await recordSimulatorReply(householdId, `${doc.caption}\n📎 ${doc.fileName}`, quotedExternalId);
      await deleteStoredFile(doc.storageKey).catch(() => undefined);
      count++;
      continue;
    }
    const res = await enqueueOutboundMessage({
      householdId,
      text: doc.caption,
      kind: "report",
      quotedExternalId,
      dedupeKey: `reply-doc:${messageId}:${i}`,
      document: { storageKey: doc.storageKey, mimeType: doc.mimeType, fileName: doc.fileName },
    });
    if (res.queued) count++;
    else logger.warn({ messageId, reason: res.reason }, "whatsapp: arquivo não enfileirado");
  }
  return count;
}

/**
 * Serializa o processamento por família dentro do processo (mensagens da mesma família na ordem de
 * chegada — ex.: uma correção não pode ser interpretada antes do lançamento que ela corrige).
 * Famílias diferentes são processadas em paralelo (WORKER_CONCURRENCY).
 */
const householdLocks = new Map<string, Promise<unknown>>();

async function withHouseholdLock<T>(householdId: string, fn: () => Promise<T>): Promise<T> {
  const previous = householdLocks.get(householdId) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  const settled = current.catch(() => undefined);
  householdLocks.set(householdId, settled);
  try {
    return await current;
  } finally {
    if (householdLocks.get(householdId) === settled) householdLocks.delete(householdId);
  }
}

/** Executa um MessageProcessingJob. Idempotente: só roda se o job estiver PENDING (claim atômico). */
export async function runProcessingJob(jobId: string, opts: ProcessOptions = {}): Promise<ProcessOutcome> {
  const head = await prisma.messageProcessingJob.findUnique({ where: { id: jobId }, select: { householdId: true } });
  if (!head) return { outcome: "SKIPPED", reason: "job inexistente" };
  return withHouseholdLock(head.householdId, () => runLocked(jobId, opts));
}

async function runLocked(jobId: string, opts: ProcessOptions): Promise<ProcessOutcome> {
  const job = await prisma.messageProcessingJob.findUnique({ where: { id: jobId } });
  if (!job) return { outcome: "SKIPPED", reason: "job inexistente" };
  if (job.status !== "PENDING") return { outcome: "SKIPPED", reason: `status ${job.status}` };
  if (job.runAfter.getTime() > Date.now() + 5000) return { outcome: "SKIPPED", reason: "agendado para depois" };
  if (job.attempts >= job.maxAttempts) return markDead(job, job.attempts, job.lastError ?? "Tentativas esgotadas");

  const startedAt = new Date();
  const claimed = await prisma.messageProcessingJob.updateMany({
    where: { id: job.id, status: "PENDING", attempts: job.attempts },
    data: { status: "RUNNING", startedAt, finishedAt: null, attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return { outcome: "SKIPPED", reason: "já em execução" };
  const attempts = job.attempts + 1;

  const message = await prisma.whatsAppMessage.update({
    where: { id: job.messageId },
    data: { status: "PROCESSING" },
    select: { id: true, externalId: true, statusDetail: true },
  });
  await publishEvent(job.householdId, "whatsapp.message", job.messageId);

  let result: InboundMessageResult | null = null;
  let error: string | null = null;
  try {
    result = await handleInboundMessage(job.messageId);
  } catch (err) {
    const info = errorInfo(err);
    error = info.message.slice(0, 300) || info.name;
    logger.warn({ jobId: job.id, attempt: attempts, err: info.name, code: info.code }, "whatsapp: erro no processamento");
  }

  if (error !== null || !result || result.retryable) {
    const reason = (error ?? result?.detail ?? "Erro temporário no processamento").slice(0, 300);
    if (attempts >= job.maxAttempts) return markDead(job, attempts, reason);
    const runAfter = new Date(Date.now() + processingBackoffMs(attempts));
    await prisma.$transaction([
      prisma.messageProcessingJob.update({ where: { id: job.id }, data: { status: "PENDING", runAfter, lastError: reason, finishedAt: new Date() } }),
      prisma.whatsAppMessage.update({
        where: { id: job.messageId },
        data: { status: "QUEUED", statusDetail: `Nova tentativa (${attempts}/${job.maxAttempts}) agendada: ${reason}`.slice(0, 500) },
      }),
    ]);
    const res = await enqueueInboundJob({ id: job.id, messageId: job.messageId, householdId: job.householdId, attempts, runAfter });
    if (!res.ok) logger.warn({ jobId: job.id, reason: res.reason }, "whatsapp: nova tentativa não enfileirada (recuperação fará)");
    await publishEvent(job.householdId, "whatsapp.message", job.messageId);
    return { outcome: "RETRY_SCHEDULED", attempts, runAfter };
  }

  const finishedAt = new Date();
  const failed = result.status === "FAILED";
  await prisma.$transaction([
    prisma.whatsAppMessage.update({
      where: { id: job.messageId },
      data: {
        status: result.status,
        intent: result.intent?.slice(0, 60) ?? null,
        statusDetail: (result.detail ?? message.statusDetail ?? null)?.slice(0, 500) ?? null,
        processedAt: finishedAt,
      },
    }),
    prisma.messageProcessingJob.update({
      where: { id: job.id },
      data: { status: failed ? "FAILED" : "SUCCEEDED", finishedAt, lastError: failed ? (result.detail ?? "Falha no processamento").slice(0, 300) : null },
    }),
  ]);
  if (failed) {
    // Nada some em silêncio: a falha vira pendência visível.
    await createPendingItem(prisma, {
      householdId: job.householdId,
      type: "PROCESSING_FAILED",
      title: "Mensagem do WhatsApp não processada",
      description: (result.detail ?? "O motor não conseguiu interpretar a mensagem. Reprocesse ou registre manualmente.").slice(0, 500),
      messageId: job.messageId,
      dedupeKey: `failed:${job.messageId}`,
    });
    await publishEvent(job.householdId, "pending.changed");
  } else {
    let resolved = await resolvePendingWhere(
      prisma,
      { householdId: job.householdId, dedupeKey: `failed:${job.messageId}` },
      "Mensagem processada com sucesso",
      null,
    );
    if (result.status === "PROCESSED") {
      // Pendência de esclarecimento de uma tentativa anterior (ex.: "Áudio não transcrito")
      // deixa de valer quando o reprocessamento conclui a mensagem.
      resolved += await resolvePendingWhere(
        prisma,
        { householdId: job.householdId, dedupeKey: `msg:CLARIFICATION:${job.messageId}`, createdAt: { lt: startedAt } },
        "Mensagem reprocessada com sucesso",
        null,
      );
    }
    if (resolved) await publishEvent(job.householdId, "pending.changed");
  }

  const replies = await deliverReplies(job.householdId, job.messageId, message.externalId, result.replies ?? [], opts, result.documents ?? []);
  await publishEvent(job.householdId, "whatsapp.message", job.messageId);
  logger.info({ jobId: job.id, status: result.status, intent: result.intent, transactions: result.transactionIds?.length ?? 0, replies }, "whatsapp: mensagem processada");
  return { outcome: failed ? "FAILED" : "SUCCEEDED", messageStatus: result.status, replies };
}

/** Processador BullMQ da fila "whatsapp-inbound". */
export async function processInboundBullJob(job: Job<InboundJobData>): Promise<ProcessOutcome> {
  return runProcessingJob(job.data.jobId);
}

/** Reseta o job e reenfileira. Idempotente (o motor não duplica lançamentos). */
export async function reprocessMessage(ctx: ServiceContext, messageId: string, opts: { skipAudit?: boolean } = {}) {
  assertCan(ctx, "integrations:manage");
  const msg = await prisma.whatsAppMessage.findFirst({
    where: { id: messageId, householdId: ctx.householdId },
    include: { attachment: { select: { id: true, storageKey: true, contentDeletedAt: true, mimeType: true } }, jobs: true },
  });
  if (!msg) throw new NotFoundError("Mensagem");
  if (msg.direction !== "INBOUND") throw new ValidationError("Apenas mensagens recebidas podem ser reprocessadas.");
  const hasMedia = Boolean(msg.attachment);
  if (!isProcessableType(msg.type, { hasText: Boolean(msg.text?.trim()), hasMedia, mimeType: msg.attachment?.mimeType })) {
    if ((msg.type === "AUDIO" || msg.type === "IMAGE" || msg.type === "DOCUMENT") && !hasMedia) {
      throw new ValidationError("A mídia desta mensagem não foi obtida; peça para reenviar o arquivo.");
    }
    throw new ValidationError("Este tipo de mensagem não é processado.");
  }
  if (msg.attachment && (!msg.attachment.storageKey || msg.attachment.contentDeletedAt)) {
    throw new ValidationError("O arquivo original já foi apagado pela política de retenção de mídias.");
  }
  const existing = msg.jobs.find((j) => j.kind === "PROCESS_MESSAGE");
  if (existing?.status === "RUNNING" && existing.startedAt && Date.now() - existing.startedAt.getTime() < STUCK_RUNNING_MS) {
    throw new ConflictError("A mensagem já está sendo processada.");
  }
  const now = new Date();
  const reset = { status: "PENDING" as const, attempts: 0, runAfter: now, lastError: null, startedAt: null, finishedAt: null };
  const job = await prisma.$transaction(async (tx) => {
    const j = await tx.messageProcessingJob.upsert({
      where: { messageId_kind: { messageId: msg.id, kind: "PROCESS_MESSAGE" } },
      create: { householdId: ctx.householdId, messageId: msg.id, kind: "PROCESS_MESSAGE", runAfter: now },
      update: reset,
    });
    await tx.whatsAppMessage.update({ where: { id: msg.id }, data: { status: "QUEUED", statusDetail: "Reprocessamento solicitado", processedAt: null } });
    return j;
  });
  if (!opts.skipAudit) {
    await audit(ctx, { action: "UPDATE", entityType: "WhatsAppMessage", entityId: msg.id, metadata: { operation: "reprocess", previousStatus: msg.status } });
  }
  const res = await enqueueInboundJob(job);
  await publishEvent(ctx.householdId, "whatsapp.message", msg.id);
  return { messageId: msg.id, jobId: job.id, queued: res.ok };
}

/** Reprocessa todas as mensagens com falha da família. */
export async function retryAllFailed(ctx: ServiceContext) {
  assertCan(ctx, "integrations:manage");
  const failed = await prisma.whatsAppMessage.findMany({
    where: { householdId: ctx.householdId, direction: "INBOUND", status: "FAILED" },
    select: { id: true },
    orderBy: { sentAt: "asc" },
    take: 500,
  });
  let requeued = 0;
  const skipped: Array<{ messageId: string; reason: string }> = [];
  for (const m of failed) {
    try {
      await reprocessMessage(ctx, m.id, { skipAudit: true });
      requeued++;
    } catch (err) {
      skipped.push({ messageId: m.id, reason: (err as Error).message });
    }
  }
  if (requeued) {
    await audit(ctx, { action: "UPDATE", entityType: "WhatsAppMessage", metadata: { operation: "retry-failed", requeued, skipped: skipped.length } });
  }
  return { total: failed.length, requeued, skipped };
}
