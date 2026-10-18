import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppConnection } from "@prisma/client";
import type { ProviderCallbacks, ProviderGroup, WhatsAppProvider } from "@/server/whatsapp/types";
import { PROVIDER_CAPABILITIES } from "@/server/whatsapp/types";

/**
 * Duas famílias, cada uma com o próprio WhatsApp (Baileys, QR Code), no MESMO worker: sessões,
 * QR Codes, credenciais, grupos e mensagens nunca se misturam. O Baileys real é substituído por um
 * provedor falso (nenhuma conexão de rede).
 */

const fakes = new Map<string, FakeBaileys>();

class FakeBaileys implements WhatsAppProvider {
  readonly type = "BAILEYS" as const;
  readonly capabilities = PROVIDER_CAPABILITIES.BAILEYS;
  connected = false;
  sent: Array<{ chatId: string; text: string }> = [];
  constructor(
    readonly connectionId: string,
    readonly cb: ProviderCallbacks,
  ) {}
  async start() {}
  async stop() {
    this.connected = false;
  }
  async logout() {
    this.connected = false;
  }
  isConnected() {
    return this.connected;
  }
  async sendText(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { externalId: `OUT-${this.sent.length}` };
  }
  async listGroups(): Promise<ProviderGroup[]> {
    return [];
  }
}

vi.mock("@/server/whatsapp/providers", () => ({
  createProvider: async (conn: WhatsAppConnection, callbacks: ProviderCallbacks) => {
    const p = new FakeBaileys(conn.id, callbacks);
    fakes.set(conn.householdId, p);
    return p;
  },
}));

const { prisma } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { ConnectionManager } = await import("@/server/whatsapp/connection-manager");
const { qrKey } = await import("@/server/whatsapp/keys");
const { useDatabaseAuthState } = await import("@/server/whatsapp/baileys/auth-state");
const { getWhatsAppStatus, setGroupAuthorization } = await import("@/server/whatsapp/service");
const { createFamily, resetDatabase } = await import("./helpers");
const { clearTestQueues, initTestQueues, teardownTestQueues } = await import("./ai-pipeline-support");

async function familyWithBaileys(name: string, phone: string) {
  const fam = await createFamily(name);
  await prisma.householdMember.update({ where: { id: fam.husbandId }, data: { whatsappPhone: phone, whatsappAuthorized: true, whatsappConsentAt: new Date() } });
  const conn = await prisma.whatsAppConnection.create({ data: { householdId: fam.householdId, provider: "BAILEYS", desiredConnected: true } });
  return { fam, conn, phone };
}

describe("Worker com duas conexões Baileys ao mesmo tempo", () => {
  beforeAll(() => initTestQueues("wa-two-connections"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
    fakes.clear();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("cada família tem sua sessão, QR, credenciais, grupos e mensagens", async () => {
    const a = await familyWithBaileys("Família A", "+5581990000001");
    const b = await familyWithBaileys("Família B", "+5581990000002");
    const manager = new ConnectionManager({ subscribe: false, reconcileIntervalMs: 3_600_000 });
    try {
      await manager.reconcileAll();
      expect(fakes.size).toBe(2);
      const pa = fakes.get(a.fam.householdId)!;
      const pb = fakes.get(b.fam.householdId)!;
      expect(pa.connectionId).toBe(a.conn.id);
      expect(pb.connectionId).toBe(b.conn.id);

      // QR Codes simultâneos e separados.
      await Promise.all([pa.cb.onQr("2@QR-DA-FAMILIA-A"), pb.cb.onQr("2@QR-DA-FAMILIA-B")]);
      expect(await redis().get(qrKey(a.fam.householdId))).toBe("2@QR-DA-FAMILIA-A");
      expect(await redis().get(qrKey(b.fam.householdId))).toBe("2@QR-DA-FAMILIA-B");
      expect((await getWhatsAppStatus(a.fam.ctx)).status).toBe("QR_PENDING");

      // Cada uma lê o seu QR: conectadas ao mesmo tempo, cada uma com seu número.
      pa.connected = true;
      pb.connected = true;
      await Promise.all([pa.cb.onStatus({ status: "CONNECTED", phoneNumber: a.phone, displayName: "A" }), pb.cb.onStatus({ status: "CONNECTED", phoneNumber: b.phone, displayName: "B" })]);
      const [ca, cb] = await Promise.all([
        prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: a.conn.id } }),
        prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: b.conn.id } }),
      ]);
      expect(ca).toMatchObject({ status: "CONNECTED", phoneNumber: a.phone });
      expect(cb).toMatchObject({ status: "CONNECTED", phoneNumber: b.phone });
      expect(manager.getProvider(a.fam.householdId)).toBe(pa);
      expect(manager.getProvider(b.fam.householdId)).toBe(pb);

      // Credenciais do Baileys guardadas por conexão (criptografadas): uma não enxerga a outra.
      const [sa, sb] = await Promise.all([useDatabaseAuthState(a.conn.id), useDatabaseAuthState(b.conn.id)]);
      await Promise.all([sa.saveCreds(), sb.saveCreds()]);
      expect(await prisma.whatsAppAuthState.count({ where: { connectionId: a.conn.id } })).toBe(1);
      expect(await prisma.whatsAppAuthState.count({ where: { connectionId: b.conn.id } })).toBe(1);
      expect((await useDatabaseAuthState(a.conn.id)).state.creds.noiseKey.public).toEqual(sa.state.creds.noiseKey.public);
      expect(sa.state.creds.noiseKey.public).not.toEqual(sb.state.creds.noiseKey.public);

      // Grupos de cada família só aparecem para ela.
      await Promise.all([
        pa.cb.onGroups([{ externalId: "grupo-a@g.us", name: "Casa A", participantsCount: 2, participants: [{ phone: a.phone, jid: null }] }]),
        pb.cb.onGroups([{ externalId: "grupo-b@g.us", name: "Casa B", participantsCount: 2, participants: [{ phone: b.phone, jid: null }] }]),
      ]);
      const ga = await prisma.whatsAppGroup.findFirstOrThrow({ where: { householdId: a.fam.householdId } });
      const gb = await prisma.whatsAppGroup.findFirstOrThrow({ where: { householdId: b.fam.householdId } });
      expect([ga.name, gb.name]).toEqual(["Casa A", "Casa B"]);
      await setGroupAuthorization(a.fam.ctx, ga.id, true);
      await setGroupAuthorization(b.fam.ctx, gb.id, true);
      await expect(setGroupAuthorization(a.fam.ctx, gb.id, true)).rejects.toThrow(/não encontrado/);

      // Mensagens chegando ao mesmo tempo vão para a família certa; a de outro grupo é descartada.
      const msg = (chatId: string, phone: string, id: string) => ({
        externalId: id,
        chatId,
        isGroup: true,
        senderIds: { phone },
        fromMe: false,
        sentAt: new Date(),
        type: "TEXT" as const,
        text: "gastei 10 de pão",
        caption: null,
        quotedExternalId: null,
        media: null,
      });
      const [ra, rb, wrong] = await Promise.all([
        pa.cb.onMessage(msg("grupo-a@g.us", a.phone, "A-1")),
        pb.cb.onMessage(msg("grupo-b@g.us", b.phone, "B-1")),
        pa.cb.onMessage(msg("grupo-b@g.us", b.phone, "A-2")),
      ]);
      expect(ra).toMatchObject({ accepted: true });
      expect(rb).toMatchObject({ accepted: true });
      expect(wrong).toMatchObject({ accepted: false });
      expect(await prisma.whatsAppMessage.findMany({ where: { householdId: a.fam.householdId }, select: { externalId: true } })).toEqual([{ externalId: "A-1" }]);
      expect(await prisma.whatsAppMessage.findMany({ where: { householdId: b.fam.householdId }, select: { externalId: true } })).toEqual([{ externalId: "B-1" }]);

      // Desconectar uma não derruba a outra.
      await prisma.whatsAppConnection.update({ where: { id: a.conn.id }, data: { desiredConnected: false } });
      await manager.reconcile(a.fam.householdId);
      expect(manager.getProvider(a.fam.householdId)).toBeNull();
      expect(manager.getProvider(b.fam.householdId)).toBe(pb);
      expect(pb.isConnected()).toBe(true);
    } finally {
      await manager.stop();
      await redis().del(qrKey(a.fam.householdId), qrKey(b.fam.householdId));
    }
  });
});
