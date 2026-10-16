import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { notify, updatePreferences } from "@/server/modules/notifications/service";
import { runNotificationDispatch } from "@/server/modules/notifications/jobs";
import { listPushDevices, pushConfig, sendTestPush, setPushSenderForTests, subscribePush, unsubscribePush } from "@/server/modules/push/service";
import { decryptStringSafe } from "@/server/crypto";
import manifest from "@/app/manifest";
import { GET as serviceWorker } from "@/app/sw.js/route";
import { createFamily, resetDatabase } from "./helpers";

/** App instalável: manifest, service worker (sem cache de dados) e notificações push por aparelho. */

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" }, deviceLabel: "iPhone" };
const sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
let nextStatus = 201;

function withVapid(on: boolean) {
  if (on) {
    process.env.VAPID_PUBLIC_KEY = "BPublicKeyTest000000000000000000000000000000000000000000000000000000000000000000000000";
    process.env.VAPID_PRIVATE_KEY = "privateKeyTest00000000000000000000000000000";
    process.env.VAPID_SUBJECT = "mailto:teste@example.com";
  } else {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  }
  resetEnvCache();
}

describe("PWA e notificações push", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    nextStatus = 201;
    withVapid(true);
    setPushSenderForTests(async (sub, payload) => {
      if (nextStatus >= 400) throw Object.assign(new Error("push"), { statusCode: nextStatus });
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
      return { statusCode: nextStatus };
    });
  });
  afterEach(() => setPushSenderForTests(null));
  afterAll(() => withVapid(false));

  it("manifest instalável e ícones presentes", () => {
    const m = manifest();
    expect(m).toMatchObject({ short_name: "Finanças", display: "standalone", start_url: "/" });
    for (const icon of m.icons ?? []) expect(existsSync(path.join(process.cwd(), "public", icon.src))).toBe(true);
    expect(m.icons?.some((i) => i.purpose === "maskable")).toBe(true);
    expect(existsSync(path.join(process.cwd(), "src/app/apple-icon.png"))).toBe(true);
  });

  it("service worker nunca guarda /api nem o SSE e não fica em cache", async () => {
    const res = serviceWorker();
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const js = await res.text();
    expect(js).toContain('url.pathname.startsWith("/api/")');
    expect(js).toContain("text/event-stream");
    expect(js).toContain('caches.match("/offline"');
    expect(js).toContain("self.skipWaiting()");
    expect(js).not.toMatch(/cache\.put\([^)]*api/);
  });

  it("sem chaves VAPID o push fica desativado com explicação", async () => {
    withVapid(false);
    expect(pushConfig()).toMatchObject({ enabled: false, publicKey: null });
    const fam = await createFamily();
    await expect(subscribePush(fam.ctx, SUB)).rejects.toThrow(/chaves VAPID/);
  });

  it("inscrição por aparelho (chaves criptografadas), só serviços de push conhecidos", async () => {
    const fam = await createFamily();
    await subscribePush(fam.ctx, SUB);
    const row = await prisma.pushSubscription.findFirstOrThrow({ where: { memberId: fam.husbandId } });
    expect(row.p256dh).not.toBe(SUB.keys.p256dh);
    expect(decryptStringSafe(row.p256dh)).toBe(SUB.keys.p256dh);
    expect(await listPushDevices(fam.ctx)).toEqual([expect.objectContaining({ deviceLabel: "iPhone", endpointHost: "fcm.googleapis.com" })]);
    // Endereço arbitrário seria um SSRF: recusado.
    await expect(subscribePush(fam.ctx, { ...SUB, endpoint: "https://intranet.local/push" })).rejects.toThrow(/não reconhecido/);
    await expect(subscribePush(fam.ctx, { ...SUB, endpoint: "http://fcm.googleapis.com/x" })).rejects.toThrow(/não reconhecido/);
    // O mesmo aparelho logado por outra pessoa passa a ser dela.
    await subscribePush(fam.wifeCtx, SUB);
    expect(await prisma.pushSubscription.count()).toBe(1);
    expect((await prisma.pushSubscription.findFirstOrThrow()).memberId).toBe(fam.wifeId);
    await unsubscribePush(fam.wifeCtx, { endpoint: SUB.endpoint });
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  it("notificações do sistema viram push para quem tem aparelho, respeitando preferência e horário silencioso", async () => {
    const fam = await createFamily();
    await subscribePush(fam.ctx, SUB);
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta de luz vence amanhã", body: "R$ 187,43", dedupeKey: "bill:1" });
    const pushes = await prisma.notification.findMany({ where: { householdId: fam.householdId, channel: "PUSH" } });
    // Só o marido tem aparelho inscrito.
    expect(pushes.map((p) => [p.recipientMemberId, p.status])).toEqual([[fam.husbandId, "PENDING"]]);
    const res = await runNotificationDispatch(new Date());
    expect(res.sent).toBeGreaterThanOrEqual(1);
    expect(sent).toEqual([{ endpoint: SUB.endpoint, payload: expect.objectContaining({ title: "Conta de luz vence amanhã", url: "/contas-a-pagar", tag: "BILL_DUE" }) }]);
    expect((await prisma.notification.findFirstOrThrow({ where: { id: pushes[0]!.id } })).status).toBe("SENT");

    // Mesmo evento de novo (dedupe) não gera outro push.
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta de luz vence amanhã", body: "R$ 187,43", dedupeKey: "bill:1" });
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, channel: "PUSH" } })).toBe(1);

    // Horário silencioso: fica para depois.
    await updatePreferences(fam.ctx, [{ type: "BUDGET_THRESHOLD", quietStart: "00:00", quietEnd: "23:59" }]);
    await notify({ householdId: fam.householdId, type: "BUDGET_THRESHOLD", title: "Orçamento", body: "90%", dedupeKey: "budget:1" });
    const quiet = await runNotificationDispatch(new Date());
    expect(quiet.deferred).toBeGreaterThanOrEqual(1);
    expect(sent).toHaveLength(1);

    // Push desligado no tipo: nem cria.
    await updatePreferences(fam.ctx, [{ type: "CONFIRMATION_REQUIRED", push: false }]);
    await notify({ householdId: fam.householdId, type: "CONFIRMATION_REQUIRED", title: "Confirme", body: "x", dedupeKey: "conf:1" });
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, channel: "PUSH", type: "CONFIRMATION_REQUIRED" } })).toBe(0);
  });

  it("inscrição expirada (410) é removida; teste de envio informa", async () => {
    const fam = await createFamily();
    await subscribePush(fam.ctx, SUB);
    expect((await sendTestPush(fam.ctx)).sent).toBe(1);
    nextStatus = 410;
    await expect(sendTestPush(fam.ctx)).rejects.toThrow(/expirou/);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});
