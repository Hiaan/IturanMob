import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { redis } from "@/server/redis";
import { closeQueues, getQueue, QUEUE_NAMES, setQueuePrefix, type OutboundJobData } from "@/server/jobs/queues";
import { enqueueOutboundMessage, whatsappCanSend } from "@/server/whatsapp/outbound";
import { outboundDedupeHash, outboundJobId } from "@/server/whatsapp/outbound-impl";
import { deliverOutbound, reserveOutboundSlot, type ProviderRegistry } from "@/server/whatsapp/outbound-consumer";
import { ingestMessage } from "@/server/whatsapp/ingest";
import { outboundDoneKey, outboundHourKey, outboundSecondKey } from "@/server/whatsapp/keys";
import { PROVIDER_CAPABILITIES, type WhatsAppProvider } from "@/server/whatsapp/types";
import { createFamily, resetDatabase } from "./helpers";
import { storeFile, storedFileExists } from "@/server/storage";

const GROUP = "120363000000000001@g.us";
const cleanupKeys: string[] = [];

class FakeProvider implements WhatsAppProvider {
  readonly type = "BAILEYS" as const;
  readonly capabilities = PROVIDER_CAPABILITIES.BAILEYS;
  connected = true;
  sent: Array<{ chatId: string; text: string; quoted: string | null }> = [];
  async start() {}
  async stop() {}
  async logout() {}
  isConnected() {
    return this.connected;
  }
  async sendText(chatId: string, text: string, opts?: { quotedExternalId?: string | null }) {
    this.sent.push({ chatId, text, quoted: opts?.quotedExternalId ?? null });
    return { externalId: `WA-OUT-${randomBytes(6).toString("hex").toUpperCase()}` };
  }
  documents: Array<{ chatId: string; fileName: string; mimeType: string; caption: string; size: number }> = [];
  async sendDocument(chatId: string, doc: { buffer: Buffer; mimeType: string; fileName: string; caption: string }) {
    this.documents.push({ chatId, fileName: doc.fileName, mimeType: doc.mimeType, caption: doc.caption, size: doc.buffer.length });
    return { externalId: `WA-OUT-${randomBytes(6).toString("hex").toUpperCase()}` };
  }
  async listGroups() {
    return [];
  }
}

async function setup(opts: { authorizeGroup?: boolean; status?: "CONNECTED" | "DISCONNECTED" } = {}) {
  const fam = await createFamily();
  await prisma.householdMember.update({
    where: { id: fam.husbandId },
    data: { whatsappPhone: "+5581999990001", whatsappAuthorized: true, whatsappConsentAt: new Date() },
  });
  const conn = await prisma.whatsAppConnection.create({
    data: { householdId: fam.householdId, provider: "BAILEYS", status: opts.status ?? "CONNECTED", phoneNumber: "+5581999990001" },
  });
  const group = await prisma.whatsAppGroup.create({
    data: { householdId: fam.householdId, connectionId: conn.id, externalId: GROUP, name: "Finanças", isAuthorized: opts.authorizeGroup ?? true },
  });
  const provider = new FakeProvider();
  const registry: ProviderRegistry = { getProvider: (hh) => (hh === fam.householdId ? provider : null) };
  cleanupKeys.push(outboundSecondKey(fam.householdId), outboundHourKey(fam.householdId, Math.floor(Date.now() / 3_600_000)));
  return { fam, conn, group, provider, registry };
}

function jobData(householdId: string, dedupeKey: string, text = "Lembrete: fatura vence amanhã"): OutboundJobData {
  const dedupeHash = outboundDedupeHash(householdId, dedupeKey);
  cleanupKeys.push(outboundDoneKey(dedupeHash));
  return { householdId, text, quotedExternalId: null, dedupeHash, kind: "notification", createdAt: new Date().toISOString() };
}

async function freeRateLimit(householdId: string) {
  await redis().del(outboundSecondKey(householdId));
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

describe("WhatsApp: envio", () => {
  beforeAll(() => {
    setQueuePrefix(`fa-test-wa-out-${randomBytes(4).toString("hex")}`);
  });

  beforeEach(async () => {
    await trackRedisOwners();
    await resetDatabase();
    await getQueue(QUEUE_NAMES.outbound).obliterate({ force: true });
  });

  afterAll(async () => {
    await Promise.allSettled([getQueue(QUEUE_NAMES.inbound).obliterate({ force: true }), getQueue(QUEUE_NAMES.outbound).obliterate({ force: true })]);
    await closeQueues();
    if (cleanupKeys.length) await redis().del(...cleanupKeys);
    await cleanupRedisKeys();
    await redis().quit();
  });

  it("enqueueOutboundMessage deduplica pelo dedupeKey (um único job)", async () => {
    const { fam } = await setup();
    const input = { householdId: fam.householdId, text: "Fatura do cartão vence amanhã", kind: "notification" as const, dedupeKey: "bill:123:2026-10-16" };
    expect(await enqueueOutboundMessage(input)).toEqual({ queued: true });
    const again = await enqueueOutboundMessage(input);
    expect(again.queued).toBe(true);
    expect(again.reason).toMatch(/deduplicada/);
    const queue = getQueue<OutboundJobData>(QUEUE_NAMES.outbound);
    expect(await queue.count()).toBe(1);
    const job = await queue.getJob(outboundJobId(outboundDedupeHash(fam.householdId, input.dedupeKey)));
    expect(job?.data).toMatchObject({ householdId: fam.householdId, kind: "notification", text: input.text });
    expect(job?.opts.attempts).toBeGreaterThan(1);
  });

  it("sem grupo autorizado ou sem conexão não enfileira (e informa o motivo)", async () => {
    const { fam } = await setup({ authorizeGroup: false });
    expect(await enqueueOutboundMessage({ householdId: fam.householdId, text: "oi" })).toEqual({ queued: false, reason: "Nenhum grupo autorizado" });
    expect(await enqueueOutboundMessage({ householdId: "inexistente", text: "oi" })).toMatchObject({ queued: false });
    expect(await enqueueOutboundMessage({ householdId: fam.householdId, text: "   " })).toMatchObject({ queued: false, reason: "Mensagem vazia" });
    expect(await whatsappCanSend(fam.householdId)).toBe(false);
  });

  it("whatsappCanSend exige conexão CONNECTED + grupo autorizado", async () => {
    const a = await setup();
    expect(await whatsappCanSend(a.fam.householdId)).toBe(true);
    await prisma.whatsAppConnection.update({ where: { id: a.conn.id }, data: { status: "DISCONNECTED" } });
    expect(await whatsappCanSend(a.fam.householdId)).toBe(false);
  });

  it("consumidor entrega no grupo autorizado com prefixo, registra OUTBOUND e não reenvia o mesmo dedupe", async () => {
    const { fam, conn, group, provider, registry } = await setup();
    const data = jobData(fam.householdId, "report:weekly:2026-41");
    const res = await deliverOutbound(data, { attemptsMade: 0, maxAttempts: 6 }, registry);
    expect(res).toMatchObject({ sent: 1, skipped: 0 });
    expect(provider.sent).toEqual([{ chatId: GROUP, text: "🤖 Lembrete: fatura vence amanhã", quoted: null }]);
    const rows = await prisma.whatsAppMessage.findMany({ where: { connectionId: conn.id, direction: "OUTBOUND" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PROCESSED", groupId: group.id, chatId: GROUP, type: "TEXT", text: "🤖 Lembrete: fatura vence amanhã" });
    expect(rows[0]!.externalId).toMatch(/^WA-OUT-/);

    // mesmo envio de novo (ex.: job repetido) → nada é reenviado
    await freeRateLimit(fam.householdId);
    expect(await deliverOutbound(data, { attemptsMade: 0, maxAttempts: 6 }, registry)).toMatchObject({ sent: 0, skipped: 1 });
    expect(provider.sent).toHaveLength(1);

    // o "eco" da mensagem do bot (fromMe, sem prefixo) é ignorado pela ingestão
    const echo = await ingestMessage(
      { id: conn.id, householdId: fam.householdId },
      { externalId: rows[0]!.externalId, chatId: GROUP, isGroup: true, senderIds: {}, fromMe: true, sentAt: new Date(), type: "TEXT", text: "Lembrete" },
    );
    expect(echo).toMatchObject({ accepted: false, reason: "bot_message" });
  });

  it("arquivo (relatório): envia como documento com legenda, registra sem o conteúdo e apaga o arquivo", async () => {
    const { fam, conn, provider, registry } = await setup();
    const stored = await storeFile("reports", Buffer.from("%PDF-1.4 relatorio"));
    const data = { ...jobData(fam.householdId, "reply-doc:x:0", "📊 Relatório — outubro de 2026"), kind: "report" as const, document: { storageKey: stored.storageKey, mimeType: "application/pdf", fileName: "relatorio-mensal-2026-10.pdf" } };
    expect(await deliverOutbound(data, { attemptsMade: 0, maxAttempts: 6 }, registry)).toMatchObject({ sent: 1 });
    expect(provider.sent).toEqual([]);
    expect(provider.documents).toEqual([{ chatId: GROUP, fileName: "relatorio-mensal-2026-10.pdf", mimeType: "application/pdf", caption: "🤖 📊 Relatório — outubro de 2026", size: 18 }]);
    const row = await prisma.whatsAppMessage.findFirstOrThrow({ where: { connectionId: conn.id, direction: "OUTBOUND" } });
    expect(row).toMatchObject({ type: "DOCUMENT", status: "PROCESSED", text: "🤖 📊 Relatório — outubro de 2026\n📎 relatorio-mensal-2026-10.pdf" });
    expect(await storedFileExists(stored.storageKey)).toBe(false);
  });

  it("resposta cita a mensagem original do grupo autorizado", async () => {
    const { fam, conn, provider, registry } = await setup();
    await prisma.whatsAppMessage.create({
      data: { householdId: fam.householdId, connectionId: conn.id, externalId: "ORIG-1", chatId: GROUP, type: "TEXT", text: "gastei 10", sentAt: new Date(), status: "PROCESSED" },
    });
    const data = { ...jobData(fam.householdId, "reply:m1:0", "Registrei R$ 10,00."), kind: "reply" as const, quotedExternalId: "ORIG-1" };
    await deliverOutbound(data, { attemptsMade: 0, maxAttempts: 6 }, registry);
    expect(provider.sent[0]).toMatchObject({ chatId: GROUP, quoted: "ORIG-1" });
  });

  it("WhatsApp desconectado: registra a falha (sem perder o registro) e lança para nova tentativa", async () => {
    const { fam, conn, provider, registry } = await setup();
    provider.connected = false;
    const data = jobData(fam.householdId, "notif:x");
    await expect(deliverOutbound(data, { attemptsMade: 0, maxAttempts: 6 }, registry)).rejects.toThrow(/desconectado/);
    let row = await prisma.whatsAppMessage.findFirstOrThrow({ where: { connectionId: conn.id, direction: "OUTBOUND" } });
    expect(row.status).toBe("FAILED");
    expect(row.statusDetail).toMatch(/tentativa 1\/6/);

    // reconectou: a nova tentativa reaproveita o mesmo registro
    provider.connected = true;
    await freeRateLimit(fam.householdId);
    await deliverOutbound(data, { attemptsMade: 1, maxAttempts: 6 }, registry);
    row = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(row.status).toBe("PROCESSED");
    expect(await prisma.whatsAppMessage.count({ where: { connectionId: conn.id, direction: "OUTBOUND" } })).toBe(1);
  });

  it("limite de taxa: no máximo 1 mensagem por segundo por família", async () => {
    const { fam, provider, registry } = await setup();
    expect(await reserveOutboundSlot(fam.householdId)).toBe(0);
    expect(await reserveOutboundSlot(fam.householdId)).toBeGreaterThan(0);
    await freeRateLimit(fam.householdId);
    await deliverOutbound(jobData(fam.householdId, "a"), { attemptsMade: 0, maxAttempts: 6 }, registry);
    const limited = await deliverOutbound(jobData(fam.householdId, "b"), { attemptsMade: 0, maxAttempts: 6 }, registry);
    expect(limited.delayMs).toBeGreaterThan(0);
    expect(provider.sent).toHaveLength(1);
  });
});
