import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { proto } from "baileys";
import { prisma } from "@/server/db";
import { CREDS_KEY, clearAuthState, deserializeAuthValue, useDatabaseAuthState } from "@/server/whatsapp/baileys/auth-state";
import { createFamily, resetDatabase } from "./helpers";

async function connection() {
  const fam = await createFamily();
  return prisma.whatsAppConnection.create({ data: { householdId: fam.householdId, provider: "BAILEYS" } });
}

describe("WhatsApp: credenciais do Baileys no PostgreSQL", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("grava as credenciais criptografadas (sem JSON em claro) e as recupera", async () => {
    const conn = await connection();
    const auth = await useDatabaseAuthState(conn.id);
    const creds = auth.state.creds;
    expect(creds.registrationId).toBeGreaterThan(0);
    await auth.saveCreds();

    const row = await prisma.whatsAppAuthState.findUniqueOrThrow({ where: { connectionId_key: { connectionId: conn.id, key: CREDS_KEY } } });
    expect(row.value.startsWith("v1:")).toBe(true);
    for (const needle of ["noiseKey", "registrationId", "signedIdentityKey", "advSecretKey", creds.advSecretKey, '"type":"Buffer"']) {
      expect(row.value).not.toContain(needle);
    }
    const decoded = deserializeAuthValue<typeof creds>(row.value);
    expect(decoded.registrationId).toBe(creds.registrationId);
    expect(Buffer.isBuffer(decoded.noiseKey.private)).toBe(true);
    expect(Buffer.from(decoded.noiseKey.private).equals(Buffer.from(creds.noiseKey.private))).toBe(true);

    // nova carga devolve as mesmas credenciais
    const again = await useDatabaseAuthState(conn.id);
    expect(again.state.creds.registrationId).toBe(creds.registrationId);
    expect(again.state.creds.advSecretKey).toBe(creds.advSecretKey);
  });

  it("chaves de sinal: set/get/remoção com Buffers e app-state-sync-key", async () => {
    const conn = await connection();
    const { state } = await useDatabaseAuthState(conn.id);
    const preKey = { public: Buffer.from("chave-publica-123"), private: Buffer.from("chave-privada-456") };
    await state.keys.set({
      "pre-key": { "1": preKey, "2": preKey },
      "app-state-sync-key": { AAAA: { keyData: Buffer.from("sync-key"), timestamp: 1700000000 } },
      "lid-mapping": { "5581999990001": "123456789@lid" },
    });
    const rows = await prisma.whatsAppAuthState.findMany({ where: { connectionId: conn.id } });
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.value).not.toContain("chave-privada");
      expect(r.value).not.toContain("123456789@lid");
    }
    const got = await state.keys.get("pre-key", ["1", "2", "3"]);
    expect(Object.keys(got).sort()).toEqual(["1", "2"]);
    expect(Buffer.from(got["1"]!.private).toString()).toBe("chave-privada-456");
    const sync = await state.keys.get("app-state-sync-key", ["AAAA"]);
    expect(sync.AAAA).toBeInstanceOf(proto.Message.AppStateSyncKeyData);
    expect((await state.keys.get("lid-mapping", ["5581999990001"]))["5581999990001"]).toBe("123456789@lid");

    await state.keys.set({ "pre-key": { "1": null } });
    expect(Object.keys(await state.keys.get("pre-key", ["1", "2"]))).toEqual(["2"]);

    expect(await clearAuthState(conn.id)).toBe(3);
    expect(await prisma.whatsAppAuthState.count({ where: { connectionId: conn.id } })).toBe(0);
  });

  it("valor adulterado/ilegível é descartado (novo pareamento) sem lançar", async () => {
    const conn = await connection();
    await prisma.whatsAppAuthState.create({ data: { connectionId: conn.id, key: CREDS_KEY, value: "v1:AAAAinvalido" } });
    const auth = await useDatabaseAuthState(conn.id);
    expect(auth.state.creds.me).toBeUndefined();
    expect(auth.state.creds.registered).toBe(false);
  });
});
