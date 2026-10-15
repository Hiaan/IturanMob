import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { redis } from "@/server/redis";
import { closeQueues, getQueue, QUEUE_NAMES, setQueuePrefix } from "@/server/jobs/queues";
import { ingestMessage } from "@/server/whatsapp/ingest";
import { markSentByBot } from "@/server/whatsapp/bot-messages";
import { queueReceivedMessages } from "@/server/whatsapp/recovery";
import type { NormalizedInboundMessage } from "@/server/whatsapp/types";
import { createFamily, resetDatabase } from "./helpers";

const GROUP = "120363000000000001@g.us";
const OTHER_GROUP = "120363000000000002@g.us";
const HUSBAND = "+5581999990001";
const WIFE = "+5581999990002";

let storageDir: string;
let seq = 0;

async function setup(opts: { processingEnabled?: boolean } = {}) {
  const fam = await createFamily();
  const consent = new Date();
  await prisma.householdMember.update({ where: { id: fam.husbandId }, data: { whatsappPhone: HUSBAND, whatsappAuthorized: true, whatsappConsentAt: consent } });
  await prisma.householdMember.update({ where: { id: fam.wifeId }, data: { whatsappPhone: WIFE, whatsappAuthorized: true, whatsappConsentAt: consent } });
  const conn = await prisma.whatsAppConnection.create({
    data: { householdId: fam.householdId, provider: "BAILEYS", status: "CONNECTED", phoneNumber: HUSBAND, processingEnabled: opts.processingEnabled ?? true },
  });
  const group = await prisma.whatsAppGroup.create({
    data: { householdId: fam.householdId, connectionId: conn.id, externalId: GROUP, name: "Finanças da Família", isAuthorized: true, authorizedAt: new Date() },
  });
  await prisma.whatsAppGroup.create({ data: { householdId: fam.householdId, connectionId: conn.id, externalId: OTHER_GROUP, name: "Amigos" } });
  return { fam, conn, group, ref: { id: conn.id, householdId: fam.householdId } };
}

function msg(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  seq++;
  return {
    externalId: `MSG-${seq}-${randomBytes(3).toString("hex")}`,
    chatId: GROUP,
    isGroup: true,
    senderIds: { jid: "5581999990002@s.whatsapp.net", phone: WIFE },
    fromMe: false,
    sentAt: new Date(),
    type: "TEXT",
    text: "gastei 58 reais no mercado",
    ...overrides,
  };
}

function image(content: Buffer, overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return msg({
    type: "IMAGE",
    text: null,
    caption: "comprovante",
    media: { mimeType: "image/jpeg", sizeBytes: content.length, download: async () => content },
    ...overrides,
  });
}

async function counts(householdId: string) {
  const [messages, jobs] = await Promise.all([
    prisma.whatsAppMessage.count({ where: { householdId } }),
    prisma.messageProcessingJob.count({ where: { householdId } }),
  ]);
  return { messages, jobs };
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

describe("WhatsApp: ingestão", () => {
  beforeAll(async () => {
    setQueuePrefix(`fa-test-wa-ingest-${randomBytes(4).toString("hex")}`);
    storageDir = await mkdtemp(path.join(os.tmpdir(), "fa-wa-ingest-"));
    process.env.STORAGE_DIR = storageDir;
    resetEnvCache();
  });

  beforeEach(async () => {
    await trackRedisOwners();
    await resetDatabase();
  });

  afterAll(async () => {
    await Promise.allSettled([getQueue(QUEUE_NAMES.inbound).obliterate({ force: true }), getQueue(QUEUE_NAMES.outbound).obliterate({ force: true })]);
    await closeQueues();
    await cleanupRedisKeys();
    await redis().quit();
    await rm(storageDir, { recursive: true, force: true });
  });

  it("mensagem de grupo não autorizado é descartada sem persistir nada", async () => {
    const { fam, ref } = await setup();
    const res = await ingestMessage(ref, msg({ chatId: OTHER_GROUP }));
    expect(res).toMatchObject({ accepted: false, reason: "chat_not_authorized" });
    const res2 = await ingestMessage(ref, msg({ chatId: "999@g.us" }));
    expect(res2.accepted).toBe(false);
    // conversa direta (fora de grupo) também não é processada no Baileys
    const res3 = await ingestMessage(ref, msg({ chatId: "5581999990002@s.whatsapp.net", isGroup: false }));
    expect(res3).toMatchObject({ accepted: false, reason: "chat_not_authorized" });
    expect(await counts(fam.householdId)).toEqual({ messages: 0, jobs: 0 });
    expect(await prisma.attachment.count({ where: { householdId: fam.householdId } })).toBe(0);
  });

  it("remetente desconhecido, não autorizado ou sem consentimento é descartado", async () => {
    const { fam, ref } = await setup();
    const unknown = await ingestMessage(ref, msg({ senderIds: { jid: "5511988887777@s.whatsapp.net", phone: "+5511988887777" } }));
    expect(unknown).toMatchObject({ accepted: false, reason: "sender_unknown" });

    await prisma.householdMember.update({ where: { id: fam.wifeId }, data: { whatsappAuthorized: false } });
    expect(await ingestMessage(ref, msg())).toMatchObject({ accepted: false, reason: "sender_not_authorized" });

    await prisma.householdMember.update({ where: { id: fam.wifeId }, data: { whatsappAuthorized: true, whatsappConsentAt: null } });
    expect(await ingestMessage(ref, msg())).toMatchObject({ accepted: false, reason: "sender_without_consent" });

    // mídia de remetente sem consentimento nem é baixada
    let downloaded = false;
    const media = image(Buffer.from("x"), { media: { mimeType: "image/jpeg", download: async () => ((downloaded = true), Buffer.from("x")) } });
    expect((await ingestMessage(ref, media)).accepted).toBe(false);
    expect(downloaded).toBe(false);
    expect(await counts(fam.householdId)).toEqual({ messages: 0, jobs: 0 });
  });

  it("mensagem autorizada cria mensagem + job e enfileira na BullMQ com jobId = id do job", async () => {
    const { fam, ref, group } = await setup();
    const m = msg();
    const res = await ingestMessage(ref, m);
    expect(res).toMatchObject({ accepted: true, status: "QUEUED", queued: true });
    const stored = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: res.messageId! } });
    expect(stored).toMatchObject({ senderMemberId: fam.wifeId, groupId: group.id, direction: "INBOUND", type: "TEXT", text: m.text, status: "QUEUED" });
    const job = await prisma.messageProcessingJob.findUniqueOrThrow({ where: { id: res.jobId! } });
    expect(job).toMatchObject({ status: "PENDING", kind: "PROCESS_MESSAGE", attempts: 0 });
    const bull = await getQueue(QUEUE_NAMES.inbound).getJob(job.id);
    expect(bull?.data).toMatchObject({ jobId: job.id, messageId: stored.id });
    const conn = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: ref.id } });
    expect(conn.lastMessageAt).not.toBeNull();
  });

  it("evento repetido não duplica mensagem nem job", async () => {
    const { fam, ref } = await setup();
    const m = msg();
    const first = await ingestMessage(ref, m);
    const second = await ingestMessage(ref, { ...m });
    const [third, fourth] = await Promise.all([ingestMessage(ref, { ...m }), ingestMessage(ref, { ...m })]);
    expect(second).toMatchObject({ accepted: true, duplicate: true, messageId: first.messageId, jobId: first.jobId });
    expect(third.messageId).toBe(first.messageId);
    expect(fourth.messageId).toBe(first.messageId);
    expect(await counts(fam.householdId)).toEqual({ messages: 1, jobs: 1 });
  });

  it("mensagens do próprio bot são ignoradas; fromMe do cônjuge dono do número é processada", async () => {
    const { fam, ref } = await setup();
    // prefixo do bot
    const withPrefix = await ingestMessage(ref, msg({ fromMe: true, text: "🤖 Registrei R$ 58,00 em Mercado", senderIds: { lid: "111@lid" } }));
    expect(withPrefix).toMatchObject({ accepted: false, reason: "bot_message" });
    // externalId registrado no envio
    const sent = msg({ fromMe: true, text: "texto sem prefixo", senderIds: { lid: "111@lid" } });
    await markSentByBot(ref.id, sent.externalId);
    expect(await ingestMessage(ref, sent)).toMatchObject({ accepted: false, reason: "bot_message" });
    // mensagem OUTBOUND já registrada com o mesmo externalId
    await prisma.whatsAppMessage.create({
      data: { householdId: fam.householdId, connectionId: ref.id, externalId: "BOT-OUT-1", chatId: GROUP, direction: "OUTBOUND", type: "TEXT", text: "🤖 ok", sentAt: new Date(), status: "PROCESSED" },
    });
    expect(await ingestMessage(ref, msg({ externalId: "BOT-OUT-1", fromMe: true, text: "ok" }))).toMatchObject({ accepted: false, reason: "bot_message" });

    // mensagem fromMe legítima: o número conectado é do marido → processada como dele (mesmo só com LID)
    const own = await ingestMessage(ref, msg({ fromMe: true, text: "paguei a luz 180", senderIds: { lid: "111@lid" } }));
    expect(own.accepted).toBe(true);
    const stored = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: own.messageId! } });
    expect(stored.senderMemberId).toBe(fam.husbandId);
    expect(await prisma.whatsAppMessage.count({ where: { householdId: fam.householdId, direction: "INBOUND" } })).toBe(1);
  });

  it("aprende LID/JID do membro e passa a reconhecer mensagens só com LID", async () => {
    const { fam, ref } = await setup();
    // número antigo sem o nono dígito no WhatsApp + LID
    const first = await ingestMessage(ref, msg({ senderIds: { jid: "558199990002@s.whatsapp.net", lid: "987654321@lid" } }));
    expect(first.accepted).toBe(true);
    const wife = await prisma.householdMember.findUniqueOrThrow({ where: { id: fam.wifeId } });
    expect(wife.whatsappLid).toBe("987654321@lid");
    expect(wife.whatsappJid).toBe("558199990002@s.whatsapp.net");
    const onlyLid = await ingestMessage(ref, msg({ senderIds: { lid: "987654321@lid" } }));
    expect(onlyLid.accepted).toBe(true);
    const stored = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: onlyLid.messageId! } });
    expect(stored.senderMemberId).toBe(fam.wifeId);
  });

  it("tipos sem relevância ficam IGNORED sem job", async () => {
    const { fam, ref } = await setup();
    const sticker = await ingestMessage(ref, msg({ type: "STICKER", text: null }));
    const reaction = await ingestMessage(ref, msg({ type: "REACTION", text: "👍" }));
    const empty = await ingestMessage(ref, msg({ text: "   " }));
    for (const r of [sticker, reaction, empty]) expect(r).toMatchObject({ accepted: true, status: "IGNORED", jobId: null });
    const stored = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: reaction.messageId! } });
    expect(stored.text).toBeNull();
    expect(await counts(fam.householdId)).toEqual({ messages: 3, jobs: 0 });
  });

  it("mídia: grava Attachment criptografado, reutiliza o mesmo SHA-256 e marca comprovante repetido", async () => {
    const { fam, ref } = await setup();
    const content = Buffer.from(`imagem-de-comprovante-${randomBytes(8).toString("hex")}`);
    const first = await ingestMessage(ref, image(content));
    expect(first).toMatchObject({ accepted: true, status: "QUEUED" });
    const m1 = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: first.messageId! }, include: { attachment: true } });
    expect(m1.attachment).toMatchObject({ kind: "IMAGE", mimeType: "image/jpeg", sizeBytes: content.length, uploadedByMemberId: fam.wifeId });
    expect(m1.text).toBe("comprovante");
    const days = (m1.attachment!.retentionUntil!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);

    const second = await ingestMessage(ref, image(content, { senderIds: { jid: "5581999990001@s.whatsapp.net" } }));
    const m2 = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: second.messageId! } });
    expect(m2.attachmentId).toBe(m1.attachmentId);
    expect(m2.statusDetail).toMatch(/^Mídia repetida: anexo /);
    expect(await prisma.attachment.count({ where: { householdId: fam.householdId } })).toBe(1);
    expect(await prisma.messageProcessingJob.count({ where: { householdId: fam.householdId } })).toBe(2);
  });

  it("retenção 0: retentionUntil = agora; mídia acima de 16 MB ou falha no download vira FAILED + pendência", async () => {
    const { fam, ref } = await setup();
    await prisma.householdSettings.update({ where: { householdId: fam.householdId }, data: { mediaRetentionDays: 0 } });
    const ok = await ingestMessage(ref, image(Buffer.from("conteudo-retencao-zero")));
    const att = await prisma.attachment.findFirstOrThrow({ where: { householdId: fam.householdId } });
    expect(Math.abs(att.retentionUntil!.getTime() - Date.now())).toBeLessThan(10_000);
    expect(ok.status).toBe("QUEUED");

    const big = await ingestMessage(ref, image(Buffer.from("x"), { media: { mimeType: "image/jpeg", sizeBytes: 17 * 1024 * 1024, download: async () => Buffer.alloc(1) } }));
    expect(big.status).toBe("FAILED");
    const broken = await ingestMessage(ref, msg({ type: "AUDIO", text: null, media: { mimeType: "audio/ogg", download: async () => Promise.reject(new Error("timeout")) } }));
    expect(broken.status).toBe("FAILED");
    const pendings = await prisma.pendingItem.findMany({ where: { householdId: fam.householdId, type: "PROCESSING_FAILED" } });
    expect(pendings.map((p) => p.dedupeKey).sort()).toEqual([`failed:${big.messageId}`, `failed:${broken.messageId}`].sort());
    expect(await prisma.messageProcessingJob.count({ where: { householdId: fam.householdId } })).toBe(1);
  });

  it("processamento desligado guarda como RECEIVED e processa ao religar", async () => {
    const { fam, ref } = await setup({ processingEnabled: false });
    const res = await ingestMessage(ref, msg());
    expect(res).toMatchObject({ accepted: true, status: "RECEIVED", jobId: null });
    expect(await queueReceivedMessages(fam.householdId)).toHaveLength(0);
    await prisma.whatsAppConnection.update({ where: { id: ref.id }, data: { processingEnabled: true } });
    const jobs = await queueReceivedMessages(fam.householdId);
    expect(jobs).toHaveLength(1);
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: res.messageId! } })).status).toBe("QUEUED");
    // idempotente
    expect(await queueReceivedMessages(fam.householdId)).toHaveLength(0);
  });
});
