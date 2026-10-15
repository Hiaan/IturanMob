import { addJob, QUEUE_NAMES, type AddJobResult, type InboundJobData } from "../jobs/queues";

/**
 * Id do job na BullMQ para um MessageProcessingJob. Cada nova tentativa usa um id próprio
 * (o job anterior ainda está ativo quando a nova tentativa é agendada).
 */
export function inboundBullJobId(job: { id: string; attempts: number }): string {
  return job.attempts > 0 ? `${job.id}-r${job.attempts}` : job.id;
}

/** Enfileira o processamento. Falhas (Redis fora) não lançam: o registro fica PENDING para a recuperação. */
export async function enqueueInboundJob(job: { id: string; messageId: string; householdId: string; attempts: number; runAfter: Date }): Promise<AddJobResult> {
  const delay = Math.max(0, job.runAfter.getTime() - Date.now());
  const data: InboundJobData = { jobId: job.id, messageId: job.messageId, householdId: job.householdId };
  return addJob(QUEUE_NAMES.inbound, "process-message", data, {
    jobId: inboundBullJobId(job),
    delay,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  });
}
