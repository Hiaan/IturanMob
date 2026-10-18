import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { redis } from "@/server/redis";
import { closeQueues, setQueuePrefix } from "@/server/jobs/queues";
import { ingestMessage } from "@/server/whatsapp/ingest";
import { enqueueOutboundMessage } from "@/server/whatsapp/outbound";
import { getWhatsAppStatus } from "@/server/whatsapp/service";
import { createFamily, resetDatabase } from "./helpers";

/**
 * Redis fora do ar: a ingestão continua gravando no PostgreSQL (job PENDING para a recuperação),
 * o envio responde { queued:false } e o status da integração continua disponível — sem travar.
 */
describe("WhatsApp: Redis indisponível", () => {
  beforeAll(() => {
    // Porta sem servidor: nenhuma conexão Redis deste arquivo funciona.
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    resetEnvCache();
    setQueuePrefix("fa-test-wa-redis-down");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeQueues().catch(() => undefined);
    redis().disconnect();
  });

  it("ingestão grava mensagem + job PENDING e não trava; envio e status degradam com elegância", async () => {
    const fam = await createFamily();
    await prisma.householdMember.update({
      where: { id: fam.wifeId },
      data: { whatsappPhone: "+5581999990002", whatsappAuthorized: true, whatsappConsentAt: new Date() },
    });
    const conn = await prisma.whatsAppConnection.create({ data: { householdId: fam.householdId, provider: "BAILEYS", status: "CONNECTED" } });
    await prisma.whatsAppGroup.create({ data: { householdId: fam.householdId, connectionId: conn.id, externalId: "g@g.us", name: "Finanças", isAuthorized: true, defaultNature: "PERSONAL" } });

    const started = Date.now();
    const res = await ingestMessage(
      { id: conn.id, householdId: fam.householdId },
      { externalId: "OFFLINE-1", chatId: "g@g.us", isGroup: true, senderIds: { phone: "+5581999990002" }, fromMe: false, sentAt: new Date(), type: "TEXT", text: "gastei 9 de pão" },
    );
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(res).toMatchObject({ accepted: true, status: "QUEUED", queued: false });
    const job = await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: res.jobId! } });
    expect(job.status).toBe("PENDING");

    const out = await enqueueOutboundMessage({ householdId: fam.householdId, text: "teste", dedupeKey: "x" });
    expect(out.queued).toBe(false);
    expect(out.reason).toMatch(/Redis|indisponível|Tempo/);

    const status = await getWhatsAppStatus(fam.ctx);
    expect(status).toMatchObject({ qrAvailable: false, worker: { online: false } });
    expect(status.stats7d.byStatus.QUEUED).toBe(1);
  }, 40_000);
});
