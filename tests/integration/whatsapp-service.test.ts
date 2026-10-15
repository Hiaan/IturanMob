import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessageResult } from "@/server/ai/pipeline/types";

vi.mock("@/server/ai/pipeline/handle-message", () => ({ handleInboundMessage: vi.fn() }));
vi.mock("@/server/whatsapp/commands", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/whatsapp/commands")>();
  return { ...original, workerStatus: vi.fn(async () => ({ online: false, lastHeartbeat: null })) };
});

import { NextRequest } from "next/server";
import { handleInboundMessage } from "@/server/ai/pipeline/handle-message";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { redis } from "@/server/redis";
import { closeQueues, getQueue, QUEUE_NAMES, setQueuePrefix } from "@/server/jobs/queues";
import { ConnectionManager } from "@/server/whatsapp/connection-manager";
import { handleCloudWebhook } from "@/server/whatsapp/cloud-api/webhook";
import {
  getQrCode,
  getWhatsAppStatus,
  listWhatsAppMessages,
  requestConnect,
  requestDisconnect,
  requestGroupSync,
  requestLogout,
  setGroupAuthorization,
  simulateInbound,
  updateWhatsAppSettings,
} from "@/server/whatsapp/service";
import { SIMULATOR_GROUP_ID } from "@/server/whatsapp/simulator/provider";
import { qrKey } from "@/server/whatsapp/keys";
import { SIMULATOR_NOTICE } from "@/server/whatsapp/types";
import { createFamily, resetDatabase } from "./helpers";

const handler = vi.mocked(handleInboundMessage);
const APP_SECRET = "segredo-do-app-de-teste";

function ok(partial: Partial<InboundMessageResult> = {}): InboundMessageResult {
  return { status: "PROCESSED", intent: "CREATE_TRANSACTIONS", replies: [], transactionIds: [], ...partial };
}

async function familyWithMembers() {
  const fam = await createFamily();
  await prisma.householdMember.update({
    where: { id: fam.husbandId },
    data: { whatsappPhone: "+5581999990001", whatsappAuthorized: true, whatsappConsentAt: new Date() },
  });
  await prisma.householdMember.update({ where: { id: fam.wifeId }, data: { whatsappPhone: "+5581999990002", whatsappAuthorized: true } });
  return fam;
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

describe("WhatsApp: serviço, simulador, gerenciador e webhook", () => {
  let storageDir: string;

  beforeAll(async () => {
    setQueuePrefix(`fa-test-wa-svc-${randomBytes(4).toString("hex")}`);
    storageDir = await mkdtemp(path.join(os.tmpdir(), "fa-wa-svc-"));
    process.env.STORAGE_DIR = storageDir;
    process.env.WHATSAPP_CLOUD_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_CLOUD_VERIFY_TOKEN = "token-de-verificacao";
    resetEnvCache();
  });

  beforeEach(async () => {
    await trackRedisOwners();
    await resetDatabase();
    handler.mockReset();
  });

  afterAll(async () => {
    delete process.env.WHATSAPP_CLOUD_APP_SECRET;
    delete process.env.WHATSAPP_CLOUD_VERIFY_TOKEN;
    resetEnvCache();
    await Promise.allSettled([getQueue(QUEUE_NAMES.inbound).obliterate({ force: true }), getQueue(QUEUE_NAMES.outbound).obliterate({ force: true })]);
    await closeQueues();
    await cleanupRedisKeys();
    await redis().quit();
    await rm(storageDir, { recursive: true, force: true });
  });

  it("status completo e auditoria de conectar/desconectar", async () => {
    const fam = await familyWithMembers();
    const status = await getWhatsAppStatus(fam.ctx);
    expect(status).toMatchObject({ provider: "SIMULATOR", status: "DISCONNECTED", processingEnabled: true, canSend: false, riskWarning: null });
    expect(status.simulator?.notice).toBe(SIMULATOR_NOTICE);
    expect(status.stats7d.total).toBe(0);
    expect(status.members.find((m) => m.id === fam.husbandId)).toMatchObject({ ready: true, hasConsent: true });
    expect(status.members.find((m) => m.id === fam.wifeId)).toMatchObject({ ready: false, hasConsent: false });
    expect(status.availableProviders.map((p) => p.type)).toEqual(["CLOUD_API", "BAILEYS", "SIMULATOR"]);

    const res = await requestConnect(fam.ctx);
    expect(res).toMatchObject({ ok: true, workerOnline: false });
    expect((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { householdId: fam.householdId } })).desiredConnected).toBe(true);
    await requestDisconnect(fam.ctx);
    expect((await prisma.whatsAppConnection.findUniqueOrThrow({ where: { householdId: fam.householdId } })).desiredConnected).toBe(false);
    const actions = (await prisma.auditLog.findMany({ where: { householdId: fam.householdId, entityType: "WhatsAppConnection" }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["CONNECT", "DISCONNECT"]);
    await expect(requestConnect(fam.wifeCtx)).rejects.toThrow(/permissão/);

    await updateWhatsAppSettings(fam.ctx, { provider: "BAILEYS" });
    const baileys = await getWhatsAppStatus(fam.ctx);
    expect(baileys.riskWarning).toMatch(/NÃO oficial/);
    expect(baileys.official).toBe(false);
  });

  it("no máximo UM grupo autorizado por família (com auditoria)", async () => {
    const fam = await familyWithMembers();
    await updateWhatsAppSettings(fam.ctx, { provider: "BAILEYS" });
    const conn = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { householdId: fam.householdId } });
    const a = await prisma.whatsAppGroup.create({ data: { householdId: fam.householdId, connectionId: conn.id, externalId: "a@g.us", name: "A" } });
    const b = await prisma.whatsAppGroup.create({ data: { householdId: fam.householdId, connectionId: conn.id, externalId: "b@g.us", name: "B" } });
    await setGroupAuthorization(fam.ctx, a.id, true);
    const res = await setGroupAuthorization(fam.ctx, b.id, true);
    expect(res).toMatchObject({ isAuthorized: true, revokedGroupId: a.id });
    const authorized = await prisma.whatsAppGroup.findMany({ where: { householdId: fam.householdId, isAuthorized: true } });
    expect(authorized.map((g) => g.id)).toEqual([b.id]);
    expect(authorized[0]!.authorizedById).toBe(fam.husbandId);
    await Promise.all([setGroupAuthorization(fam.ctx, a.id, true), setGroupAuthorization(fam.ctx, b.id, true)]);
    expect(await prisma.whatsAppGroup.count({ where: { householdId: fam.householdId, isAuthorized: true } })).toBe(1);
    await setGroupAuthorization(fam.ctx, b.id, false);
    await setGroupAuthorization(fam.ctx, a.id, false);
    expect(await prisma.whatsAppGroup.count({ where: { householdId: fam.householdId, isAuthorized: true } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, entityType: "WhatsAppGroup", action: "SETTINGS_CHANGE" } })).toBe(6);
    // grupo de outra família não é acessível
    const other = await createFamily("Outra");
    await expect(setGroupAuthorization(other.ctx, a.id, true)).rejects.toThrow(/não encontrado/);
  });

  it("simulador sem worker: mesmo ingest + processamento em linha; respostas registradas como OUTBOUND", async () => {
    const fam = await familyWithMembers();
    // grupo do simulador ainda não autorizado → descartado sem persistir
    const denied = await simulateInbound(fam.ctx, { memberId: fam.husbandId, text: "gastei 40 de uber" });
    expect(denied).toMatchObject({ accepted: false, reason: "chat_not_authorized", notice: SIMULATOR_NOTICE });
    expect(await prisma.whatsAppMessage.count({ where: { householdId: fam.householdId } })).toBe(0);

    await requestGroupSync(fam.ctx);
    const group = await prisma.whatsAppGroup.findFirstOrThrow({ where: { householdId: fam.householdId, externalId: SIMULATOR_GROUP_ID } });
    await setGroupAuthorization(fam.ctx, group.id, true);

    handler.mockResolvedValueOnce(ok({ replies: ["Registrei R$ 40,00 em Transporte."] }));
    const res = await simulateInbound(fam.ctx, { memberId: fam.husbandId, text: "gastei 40 de uber" });
    expect(res).toMatchObject({ accepted: true, mode: "inline", outcome: { outcome: "SUCCEEDED", replies: 1 } });
    const page = await listWhatsAppMessages(fam.wifeCtx, {});
    expect(page.scope?.groupId).toBe(group.id);
    expect(page.items.map((m) => [m.direction, m.status])).toEqual([
      ["OUTBOUND", "PROCESSED"],
      ["INBOUND", "PROCESSED"],
    ]);
    expect(page.items[0]!.text).toBe("🤖 Registrei R$ 40,00 em Transporte.");
    expect(page.items[1]!.sender?.id).toBe(fam.husbandId);

    // a esposa não deu consentimento → ignorada
    const wife = await simulateInbound(fam.ctx, { memberId: fam.wifeId, text: "gastei 10" });
    expect(wife).toMatchObject({ accepted: false, reason: "sender_without_consent" });

    // áudio (base64) passa pelo mesmo fluxo e vira Attachment
    handler.mockResolvedValueOnce(ok({ status: "NEEDS_CLARIFICATION", intent: "CREATE_TRANSACTIONS", replies: ["Qual foi a forma de pagamento?"] }));
    const audio = await simulateInbound(fam.ctx, { memberId: fam.husbandId, audioBase64: Buffer.from(`audio-${randomBytes(4).toString("hex")}`).toString("base64"), mimeType: "audio/ogg" });
    expect(audio).toMatchObject({ accepted: true, status: "QUEUED", outcome: { messageStatus: "NEEDS_CLARIFICATION" } });
    const stored = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: audio.messageId! }, include: { attachment: true } });
    expect(stored.type).toBe("AUDIO");
    expect(stored.attachment?.kind).toBe("AUDIO");

    // fora do simulador a simulação é recusada
    await updateWhatsAppSettings(fam.ctx, { provider: "BAILEYS" });
    await expect(simulateInbound(fam.ctx, { memberId: fam.husbandId, text: "x" })).rejects.toThrow(/Simulador/);
  });

  it("gerenciador de conexões converge o simulador: conecta, sincroniza grupos, desconecta e faz logout", async () => {
    const fam = await familyWithMembers();
    await requestConnect(fam.ctx);
    const manager = new ConnectionManager({ subscribe: false, reconcileIntervalMs: 3_600_000 });
    await manager.reconcileAll();
    await new Promise((r) => setTimeout(r, 300));
    let conn = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { householdId: fam.householdId } });
    expect(conn).toMatchObject({ status: "CONNECTED", displayName: SIMULATOR_NOTICE, phoneNumber: null });
    expect(conn.lastConnectedAt).not.toBeNull();
    expect(manager.getProvider(fam.householdId)?.isConnected()).toBe(true);
    expect(await prisma.whatsAppGroup.count({ where: { connectionId: conn.id, externalId: SIMULATOR_GROUP_ID } })).toBe(1);

    await requestDisconnect(fam.ctx);
    await manager.reconcile(fam.householdId);
    conn = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { householdId: fam.householdId } });
    expect(conn.status).toBe("DISCONNECTED");
    expect(manager.getProvider(fam.householdId)).toBeNull();

    await requestConnect(fam.ctx);
    await manager.reconcile(fam.householdId);
    // com o worker "offline" (mock), o logout é aplicado direto no banco; o gerenciador para o provedor
    await requestLogout(fam.ctx);
    await manager.reconcile(fam.householdId);
    conn = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { householdId: fam.householdId } });
    expect(conn).toMatchObject({ status: "LOGGED_OUT", desiredConnected: false });
    expect(manager.getProvider(fam.householdId)).toBeNull();

    const events = (await prisma.whatsAppConnectionEvent.findMany({ where: { connectionId: conn.id }, orderBy: { createdAt: "asc" } })).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["CONNECTED", "DISCONNECTED", "LOGGED_OUT"]));
    await manager.stop();
  });

  it("QR Code: 404 sem QR pendente; data URL gerada no servidor quando há QR no Redis", async () => {
    const fam = await familyWithMembers();
    await expect(getQrCode(fam.ctx)).rejects.toThrow(/QR Code/);
    await redis().set(qrKey(fam.householdId), "2@QRDETESTE,abc,def,ghi", "EX", 30);
    const qr = await getQrCode(fam.ctx);
    expect(qr.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qr.expiresInSeconds).toBeGreaterThan(0);
    expect((await getWhatsAppStatus(fam.ctx)).qrAvailable).toBe(true);
    await expect(getQrCode(fam.wifeCtx)).rejects.toThrow(/permissão/);
    await redis().del(qrKey(fam.householdId));
  });

  it("religar o processamento enfileira as mensagens recebidas enquanto estava pausado", async () => {
    const fam = await familyWithMembers();
    await requestGroupSync(fam.ctx);
    const group = await prisma.whatsAppGroup.findFirstOrThrow({ where: { householdId: fam.householdId } });
    await setGroupAuthorization(fam.ctx, group.id, true);
    await updateWhatsAppSettings(fam.ctx, { processingEnabled: false });
    const paused = await simulateInbound(fam.ctx, { memberId: fam.husbandId, text: "gastei 15 de café" });
    expect(paused).toMatchObject({ accepted: true, status: "RECEIVED", mode: null });
    expect(handler).not.toHaveBeenCalled();
    const res = await updateWhatsAppSettings(fam.ctx, { processingEnabled: true });
    expect(res.requeued).toBe(1);
    expect((await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: paused.messageId! } })).status).toBe("QUEUED");
    expect(await prisma.auditLog.count({ where: { householdId: fam.householdId, entityType: "WhatsAppConnection", action: "SETTINGS_CHANGE" } })).toBe(2);
  });

  it("gerenciador registra ERROR quando o provedor não pode iniciar (Cloud API sem credenciais)", async () => {
    const fam = await familyWithMembers();
    const conn = await prisma.whatsAppConnection.create({ data: { householdId: fam.householdId, provider: "CLOUD_API", desiredConnected: true } });
    const manager = new ConnectionManager({ subscribe: false, reconcileIntervalMs: 3_600_000 });
    await manager.reconcile(fam.householdId);
    const after = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe("ERROR");
    expect(after.lastError).toMatch(/Cloud API não configurada/);
    expect(await prisma.whatsAppConnectionEvent.count({ where: { connectionId: conn.id, type: "ERROR" } })).toBe(1);
    await manager.stop();
  });

  it("webhook da Cloud API: conversa direta de membro autorizado é registrada; demais descartadas", async () => {
    const fam = await familyWithMembers();
    const conn = await prisma.whatsAppConnection.create({ data: { householdId: fam.householdId, provider: "CLOUD_API", status: "CONNECTED" } });
    const payload = (messages: unknown[]) => ({
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: { metadata: { phone_number_id: "1098765" }, messages } }] }],
    });
    const body = payload([
      { from: "5581999990001", id: "wamid.A1", timestamp: "1760500000", type: "text", text: { body: "gastei 12 de padaria" } },
      { from: "5511900000000", id: "wamid.X1", timestamp: "1760500001", type: "text", text: { body: "spam" } },
      { from: "5581999990002", id: "wamid.W1", timestamp: "1760500002", type: "text", text: { body: "sem consentimento" } },
    ]);
    const res = await handleCloudWebhook(body);
    expect(res).toEqual({ received: 3, accepted: 1, skipped: 2 });
    const stored = await prisma.whatsAppMessage.findMany({ where: { connectionId: conn.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ externalId: "wamid.A1", chatId: "5581999990001", senderMemberId: fam.husbandId, groupId: null, status: "QUEUED" });
    // reentrega do mesmo evento é idempotente
    await handleCloudWebhook(body);
    expect(await prisma.whatsAppMessage.count({ where: { connectionId: conn.id } })).toBe(1);

    // rota: assinatura válida → 200; inválida → 401; verificação GET
    const { GET, POST } = await import("@/app/api/webhooks/whatsapp/route");
    const raw = JSON.stringify(payload([{ from: "5581999990001", id: "wamid.A2", timestamp: "1760500100", type: "text", text: { body: "mercado 30" } }]));
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
    const okRes = await POST(new NextRequest("http://localhost:3000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "x-hub-signature-256": sig, "content-type": "application/json" } }));
    expect(okRes.status).toBe(200);
    const bad = await POST(new NextRequest("http://localhost:3000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` } }));
    expect(bad.status).toBe(401);
    expect(await prisma.whatsAppMessage.count({ where: { connectionId: conn.id } })).toBe(2);
    const verify = await GET(new NextRequest("http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=token-de-verificacao&hub.challenge=42"));
    expect(verify.status).toBe(200);
    expect(await verify.text()).toBe("42");
    const wrong = await GET(new NextRequest("http://localhost:3000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42"));
    expect(wrong.status).toBe(403);
  });
});
