import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessageResult } from "@/server/ai/pipeline/types";

vi.mock("@/server/ai/pipeline/handle-message", () => ({
  handleInboundMessage: vi.fn(),
}));

import { handleInboundMessage } from "@/server/ai/pipeline/handle-message";
import { prisma } from "@/server/db";
import { redis } from "@/server/redis";
import { closeQueues, getQueue, QUEUE_NAMES, setQueuePrefix } from "@/server/jobs/queues";
import { ingestMessage } from "@/server/whatsapp/ingest";
import { reprocessMessage, retryAllFailed, runProcessingJob } from "@/server/whatsapp/processor";
import { recoverStuckJobs } from "@/server/whatsapp/recovery";
import { outboundDedupeHash, outboundJobId } from "@/server/whatsapp/outbound-impl";
import { createFamily, resetDatabase } from "./helpers";

const handler = vi.mocked(handleInboundMessage);
const GROUP = "120363000000000001@g.us";
let seq = 0;

async function setup(provider: "BAILEYS" | "SIMULATOR" = "BAILEYS") {
  const fam = await createFamily();
  await prisma.householdMember.update({
    where: { id: fam.wifeId },
    data: { whatsappPhone: "+5581999990002", whatsappAuthorized: true, whatsappConsentAt: new Date() },
  });
  const conn = await prisma.whatsAppConnection.create({ data: { householdId: fam.householdId, provider, status: "CONNECTED" } });
  await prisma.whatsAppGroup.create({ data: { householdId: fam.householdId, connectionId: conn.id, externalId: GROUP, name: "Finanças", isAuthorized: true } });
  const ingest = async (text = "gastei 30 na farmácia") => {
    seq++;
    const res = await ingestMessage(
      { id: conn.id, householdId: fam.householdId },
      {
        externalId: `P-${seq}-${randomBytes(3).toString("hex")}`,
        chatId: GROUP,
        isGroup: true,
        senderIds: { phone: "+5581999990002" },
        fromMe: false,
        sentAt: new Date(),
        type: "TEXT",
        text,
      },
    );
    return { messageId: res.messageId!, jobId: res.jobId! };
  };
  return { fam, conn, ingest };
}

function ok(partial: Partial<InboundMessageResult> = {}): InboundMessageResult {
  return { status: "PROCESSED", intent: "CREATE_TRANSACTIONS", replies: [], transactionIds: [], detail: "1 lançamento", ...partial };
}

async function makeDue(jobId: string) {
  await prisma.messageProcessingJob.update({ where: { id: jobId }, data: { runAfter: new Date(Date.now() - 1000) } });
}


// Limpeza das chaves Redis criadas pelos testes (mensagens do bot, limites de taxa, QR).
const seenConnections = new Set<string>();
const seenHouseholds = new Set<string>();
async function trackRedisOwners() {
  for (const c of await prisma.whatsAppConnection.findMany({ select: { id: true, householdId: true } })) {
    seenConnections.add(c.id);
    seenHouseholds.add(c.householdId);
  }
}
async function cleanupRedisKeys() {
  await trackRedisOwners();
  const r = redis();
  const patterns = [
    ...[...seenConnections].map((id) => `fa:wa:sent:${id}:*`),
    ...[...seenHouseholds].flatMap((h) => [`fa:wa:rl:*${h}*`, `fa:wa:qr:${h}`]),
  ];
  for (const pattern of patterns) {
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 1000);
      cursor = next;
      if (keys.length) await r.del(...keys);
    } while (cursor !== "0");
  }
}

describe("WhatsApp: processamento", () => {
  beforeAll(() => {
    setQueuePrefix(`fa-test-wa-proc-${randomBytes(4).toString("hex")}`);
  });

  beforeEach(async () => {
    await trackRedisOwners();
    await resetDatabase();
    handler.mockReset();
    await getQueue(QUEUE_NAMES.inbound).obliterate({ force: true });
    await getQueue(QUEUE_NAMES.outbound).obliterate({ force: true });
  });

  afterAll(async () => {
    await Promise.allSettled([getQueue(QUEUE_NAMES.inbound).obliterate({ force: true }), getQueue(QUEUE_NAMES.outbound).obliterate({ force: true })]);
    await closeQueues();
    await cleanupRedisKeys();
    await redis().quit();
  });

  it("sucesso: grava status/intenção e enfileira as respostas com dedupe por mensagem", async () => {
    const { fam, ingest } = await setup();
    const { messageId, jobId } = await ingest();
    handler.mockResolvedValueOnce(ok({ replies: ["Registrei R$ 30,00 em Farmácia.", "Saldo do orçamento: R$ 200,00"] }));
    const out = await runProcessingJob(jobId);
    expect(out).toMatchObject({ outcome: "SUCCEEDED", messageStatus: "PROCESSED", replies: 2 });
    expect(handler).toHaveBeenCalledWith(messageId);
    const message = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(message).toMatchObject({ status: "PROCESSED", intent: "CREATE_TRANSACTIONS", statusDetail: "1 lançamento" });
    expect(message.processedAt).not.toBeNull();
    const job = await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    const outbound = getQueue(QUEUE_NAMES.outbound);
    const reply0 = await outbound.getJob(outboundJobId(outboundDedupeHash(fam.householdId, `reply:${messageId}:0`)));
    expect(reply0?.data).toMatchObject({ kind: "reply", quotedExternalId: message.externalId, text: "Registrei R$ 30,00 em Farmácia." });
    expect(await outbound.getJob(outboundJobId(outboundDedupeHash(fam.householdId, `reply:${messageId}:1`)))).toBeTruthy();
    // rodar de novo não faz nada (idempotente)
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "SKIPPED" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("respostas desligadas nas configurações não são enviadas", async () => {
    const { fam, ingest } = await setup();
    await prisma.householdSettings.update({ where: { householdId: fam.householdId }, data: { whatsappReplies: false } });
    const { jobId } = await ingest();
    handler.mockResolvedValueOnce(ok({ replies: ["Ok"] }));
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "SUCCEEDED", replies: 0 });
    expect(await getQueue(QUEUE_NAMES.outbound).count()).toBe(0);
  });

  it("falha → novas tentativas com backoff → DEAD + mensagem FAILED + pendência PROCESSING_FAILED", async () => {
    const { fam, ingest } = await setup();
    const { messageId, jobId } = await ingest();
    handler.mockRejectedValue(new Error("provedor de IA indisponível"));
    const first = await runProcessingJob(jobId);
    expect(first).toMatchObject({ outcome: "RETRY_SCHEDULED", attempts: 1 });
    let job = await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("PENDING");
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(job.lastError).toContain("provedor de IA indisponível");
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: messageId } })).status).toBe("QUEUED");
    // a nova tentativa foi agendada na BullMQ com id próprio
    expect(await getQueue(QUEUE_NAMES.inbound).getJob(`${jobId}-r1`)).toBeTruthy();
    // ainda não venceu: não roda
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "SKIPPED" });

    // tentativa "retryable" também conta
    handler.mockResolvedValueOnce(ok({ status: "FAILED", retryable: true, detail: "timeout na transcrição" }));
    await makeDue(jobId);
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "RETRY_SCHEDULED", attempts: 2 });

    for (let i = 3; i < 5; i++) {
      await makeDue(jobId);
      expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "RETRY_SCHEDULED", attempts: i });
    }
    await makeDue(jobId);
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "DEAD", attempts: 5 });
    job = await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "DEAD", attempts: 5 });
    const message = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(message.status).toBe("FAILED");
    expect(message.statusDetail).toContain("5 tentativa");
    const pending = await prisma.pendingItem.findMany({ where: { householdId: fam.householdId, type: "PROCESSING_FAILED" } });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ messageId, dedupeKey: `failed:${messageId}`, status: "OPEN" });
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it("resultado FAILED não recuperável vira pendência visível", async () => {
    const { fam, ingest } = await setup();
    const { messageId, jobId } = await ingest();
    handler.mockResolvedValueOnce(ok({ status: "FAILED", intent: undefined, detail: "Não entendi a mensagem" }));
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "FAILED" });
    expect((await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("FAILED");
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, messageId, type: "PROCESSING_FAILED" } })).toBe(1);
  });

  it("reprocessMessage reseta o job, reenfileira e resolve a pendência ao concluir", async () => {
    const { fam, ingest } = await setup();
    const { messageId, jobId } = await ingest();
    await prisma.messageProcessingJob.update({ where: { id: jobId }, data: { attempts: 4 } });
    handler.mockRejectedValueOnce(new Error("falhou"));
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "DEAD" });

    const res = await reprocessMessage(fam.ctx, messageId);
    expect(res).toMatchObject({ messageId, jobId, queued: true });
    const job = await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 0, lastError: null });
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: messageId } })).status).toBe("QUEUED");
    expect(await getQueue(QUEUE_NAMES.inbound).getJob(jobId)).toBeTruthy();
    // chamar de novo é seguro
    await reprocessMessage(fam.ctx, messageId);
    expect(await prisma.messageProcessingJob.count({ where: { messageId } })).toBe(1);

    handler.mockResolvedValueOnce(ok());
    expect(await runProcessingJob(jobId)).toMatchObject({ outcome: "SUCCEEDED" });
    const pending = await prisma.pendingItem.findFirstOrThrow({ where: { householdId: fam.householdId, dedupeKey: `failed:${messageId}` } });
    expect(pending.status).toBe("RESOLVED");
    const audits = await prisma.auditLog.findMany({ where: { householdId: fam.householdId, entityType: "WhatsAppMessage", entityId: messageId } });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    // permissão: membro comum não reprocessa
    await expect(reprocessMessage(fam.wifeCtx, messageId)).rejects.toThrow(/permissão/);
  });

  it("retryAllFailed reprocessa as mensagens com falha", async () => {
    const { fam, ingest } = await setup();
    const a = await ingest("a 10");
    const b = await ingest("b 20");
    for (const j of [a, b]) {
      await prisma.messageProcessingJob.update({ where: { id: j.jobId }, data: { attempts: 4 } });
      handler.mockRejectedValueOnce(new Error("x"));
      await runProcessingJob(j.jobId);
    }
    const res = await retryAllFailed(fam.ctx);
    expect(res).toMatchObject({ total: 2, requeued: 2 });
    expect(await prisma.messageProcessingJob.count({ where: { householdId: fam.householdId, status: "PENDING" } })).toBe(2);
  });

  it("recoverStuckJobs devolve RUNNING travado e reenfileira PENDING ausente da fila (idempotente)", async () => {
    const { ingest } = await setup();
    const stuck = await ingest("travado");
    const lost = await ingest("perdido");
    const queue = getQueue(QUEUE_NAMES.inbound);
    await queue.obliterate({ force: true });
    await prisma.messageProcessingJob.update({
      where: { id: stuck.jobId },
      data: { status: "RUNNING", attempts: 1, startedAt: new Date(Date.now() - 11 * 60_000) },
    });
    // RUNNING recente não é tocado
    const fresh = await ingest("em execução");
    await prisma.messageProcessingJob.update({ where: { id: fresh.jobId }, data: { status: "RUNNING", attempts: 1, startedAt: new Date() } });

    const requeued = await recoverStuckJobs();
    expect(requeued).toBe(2);
    expect((await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: stuck.jobId } })).status).toBe("PENDING");
    expect((await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: fresh.jobId } })).status).toBe("RUNNING");
    expect(await queue.getJob(`${stuck.jobId}-r1`)).toBeTruthy();
    expect(await queue.getJob(lost.jobId)).toBeTruthy();
    expect(await recoverStuckJobs()).toBe(0);

    // o job recuperado roda normalmente
    handler.mockResolvedValueOnce(ok());
    expect(await runProcessingJob(stuck.jobId)).toMatchObject({ outcome: "SUCCEEDED" });
  });

  it("simulador em linha: respostas registradas como mensagens OUTBOUND simuladas", async () => {
    const { conn, ingest } = await setup("SIMULATOR");
    const { messageId, jobId } = await ingest();
    handler.mockResolvedValueOnce(ok({ replies: ["Registrei R$ 30,00."] }));
    expect(await runProcessingJob(jobId, { inlineSimulator: true })).toMatchObject({ outcome: "SUCCEEDED", replies: 1 });
    const outbound = await prisma.whatsAppMessage.findMany({ where: { connectionId: conn.id, direction: "OUTBOUND" } });
    expect(outbound).toHaveLength(1);
    const original = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: messageId } });
    expect(outbound[0]).toMatchObject({ status: "PROCESSED", text: "🤖 Registrei R$ 30,00.", quotedExternalId: original.externalId, chatId: GROUP });
    expect(outbound[0]!.externalId).toMatch(/^SIM-OUT-/);
  });
});
