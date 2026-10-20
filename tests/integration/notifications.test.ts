import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import * as notificationsRoute from "@/app/api/v1/notifications/route";
import * as unreadRoute from "@/app/api/v1/notifications/unread-count/route";
import * as readRoute from "@/app/api/v1/notifications/[id]/read/route";
import * as readAllRoute from "@/app/api/v1/notifications/read-all/route";
import * as prefsRoute from "@/app/api/v1/notifications/preferences/route";
import { prisma } from "@/server/db";
import { hourInTimezone } from "@/lib/dates";
import { getPreferences, listForMember, markAllRead, markRead, minutesInTimezone, notify, unreadCount, updatePreferences, WHATSAPP_HOURLY_LIMIT } from "@/server/modules/notifications/service";
import { runNotificationDispatch } from "@/server/modules/notifications/jobs";
import { createFamily, resetDatabase } from "./helpers";

const outbound = vi.hoisted(() => ({
  canSend: true,
  queued: true,
  reason: undefined as string | undefined,
  fail: false,
  sent: [] as Array<{ householdId: string; text: string; kind?: string; dedupeKey?: string | null }>,
}));

vi.mock("@/server/whatsapp/outbound", () => ({
  enqueueOutboundMessage: vi.fn(async (input: { householdId: string; text: string; kind?: string; dedupeKey?: string | null }) => {
    if (outbound.fail) throw new Error("fila indisponível");
    if (!outbound.queued) return { queued: false, reason: outbound.reason };
    outbound.sent.push(input);
    return { queued: true };
  }),
  whatsappCanSend: vi.fn(async () => outbound.canSend),
}));

const TZ = "America/Recife";

type RouteHandler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Chama um handler de rota com sessão real (cookie), mesma origem e corpo JSON. */
async function api(handler: RouteHandler, opts: { token: string; path: string; method?: string; body?: unknown; params?: Record<string, string> }) {
  const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${opts.token}`, origin: "http://localhost:3000", host: "localhost:3000" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(new URL(opts.path, "http://localhost:3000"), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  // Corpo JSON livre: os testes inspecionam a resposta como o cliente faria.
  return { status: res.status, body: (await res.json()) as { data?: any; error?: { code: string; message: string } } }; // eslint-disable-line
}

/** Próximo instante (dentro de 24 h) em que a hora local é a informada. */
function atLocalHour(hour: number, from = new Date()): Date {
  const d = new Date(from.getTime() + 60_000);
  d.setUTCMinutes(5, 0, 0);
  for (let i = 0; i < 25; i++) {
    if (hourInTimezone(TZ, d) === hour) return d;
    d.setTime(d.getTime() + 3_600_000);
  }
  throw new Error("hora não encontrada");
}

function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

async function whatsappRows(householdId: string) {
  return prisma.notification.findMany({ where: { householdId, channel: "WHATSAPP" }, orderBy: { createdAt: "asc" } });
}

describe("notificações", () => {
  beforeEach(async () => {
    await resetDatabase();
    outbound.canSend = true;
    outbound.queued = true;
    outbound.reason = undefined;
    outbound.fail = false;
    outbound.sent = [];
  });

  it("respeita as preferências padrão e cria preferências para quem não tem", async () => {
    const fam = await createFamily();
    expect(await prisma.notificationPreference.count({ where: { memberId: fam.wifeId } })).toBe(0);

    // Padrão: lançamento registrado não notifica.
    const none = await notify({ householdId: fam.householdId, type: "TRANSACTION_CREATED", title: "Despesa", body: "Mercado R$ 10,00" });
    expect(none.created).toBe(0);

    const res = await notify({ householdId: fam.householdId, type: "BUDGET_THRESHOLD", title: "Orçamento", body: "Alimentação atingiu 50%.", dedupeKey: "budget:x:50" });
    expect(res.created).toBe(3); // in-app marido + in-app esposa + 1 WhatsApp (grupo)
    expect(await prisma.notificationPreference.count({ where: { memberId: fam.wifeId } })).toBe(17);

    const inApp = await prisma.notification.findMany({ where: { householdId: fam.householdId, channel: "IN_APP" } });
    expect(inApp.map((n) => n.recipientMemberId).sort()).toEqual([fam.husbandId, fam.wifeId].sort());
    expect(inApp.every((n) => n.status === "SENT")).toBe(true);

    const wa = await whatsappRows(fam.householdId);
    expect(wa).toHaveLength(1);
    expect(wa[0]!.recipientMemberId).toBeNull();
    expect(wa[0]!.status).toBe("PENDING");
    expect(wa[0]!.dedupeKey).toBe("budget:x:50:wa");
  });

  it("frequência OFF desativa o tipo e WhatsApp só sai se alguém quiser", async () => {
    const fam = await createFamily();
    await updatePreferences(fam.wifeCtx, [{ type: "BILL_DUE", frequency: "OFF" }]);
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta a vencer", body: "Internet vence amanhã.", dedupeKey: "bill:1" });
    const inApp = await prisma.notification.findMany({ where: { householdId: fam.householdId, channel: "IN_APP" } });
    expect(inApp.map((n) => n.recipientMemberId)).toEqual([fam.husbandId]);
    expect(await whatsappRows(fam.householdId)).toHaveLength(1);

    await updatePreferences(fam.ctx, [{ type: "BILL_DUE", whatsapp: false }]);
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta a vencer", body: "Água vence amanhã.", dedupeKey: "bill:2" });
    expect(await whatsappRows(fam.householdId)).toHaveLength(1);

    // Destinatário explícito e marcador inAppOnly (itens privados não vão ao grupo).
    await notify({
      householdId: fam.householdId,
      type: "STATEMENT_AVAILABLE",
      title: "Fatura",
      body: "Fatura fechada.",
      recipientMemberIds: [fam.wifeId],
      data: { inAppOnly: true },
      dedupeKey: "st:1",
    });
    await updatePreferences(fam.wifeCtx, [{ type: "STATEMENT_AVAILABLE", whatsapp: true }]);
    await notify({ householdId: fam.householdId, type: "STATEMENT_AVAILABLE", title: "Fatura", body: "Fatura fechada.", recipientMemberIds: [fam.wifeId], data: { inAppOnly: true }, dedupeKey: "st:2" });
    const st = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "STATEMENT_AVAILABLE" } });
    expect(st).toHaveLength(2);
    expect(st.every((n) => n.channel === "IN_APP" && n.recipientMemberId === fam.wifeId)).toBe(true);
  });

  it("deduplica pelo dedupeKey", async () => {
    const fam = await createFamily();
    const input = { householdId: fam.householdId, type: "BILL_DUE" as const, title: "Conta a vencer", body: "Internet vence hoje.", dedupeKey: "bill:abc:2026-10-20" };
    expect((await notify(input)).created).toBe(3);
    expect((await notify(input)).created).toBe(0);
    expect(await prisma.notification.count({ where: { householdId: fam.householdId } })).toBe(3);
  });

  it("limita as mensagens de WhatsApp por hora (excedentes ficam SKIPPED)", async () => {
    const fam = await createFamily();
    for (let i = 0; i < WHATSAPP_HOURLY_LIMIT + 2; i++) {
      await notify({ householdId: fam.householdId, type: "BUDGET_THRESHOLD", title: `Orçamento ${i}`, body: "Atingiu 50%.", dedupeKey: `budget:${i}:50` });
    }
    const wa = await whatsappRows(fam.householdId);
    expect(wa.filter((n) => n.status === "PENDING")).toHaveLength(WHATSAPP_HOURLY_LIMIT);
    const skipped = wa.filter((n) => n.status === "SKIPPED");
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.error).toMatch(/Limite de 6 mensagens por hora/);
    // As notificações in-app não são limitadas.
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, channel: "IN_APP" } })).toBe(2 * (WHATSAPP_HOURLY_LIMIT + 2));
  });

  it("caixa de entrada: listagem, não lidas e marcação de leitura", async () => {
    const fam = await createFamily();
    for (let i = 0; i < 3; i++) await notify({ householdId: fam.householdId, type: "BILL_DUE", title: `Conta ${i}`, body: "vence amanhã", dedupeKey: `b:${i}` });
    // Notificação da família (sem destinatário) aparece para todos.
    await prisma.notification.create({ data: { householdId: fam.householdId, type: "SYSTEM", channel: "IN_APP", status: "SENT", title: "Aviso", body: "Backup concluído." } });

    expect(await unreadCount(fam.ctx)).toBe(4);
    const page1 = await listForMember(fam.ctx, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listForMember(fam.ctx, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(4);
    expect(page2.nextCursor).toBeNull();

    const mine = page1.items.find((i) => !i.shared)!;
    await markRead(fam.ctx, mine.id);
    expect(await unreadCount(fam.ctx)).toBe(3);
    // A esposa não pode marcar a notificação do marido.
    await expect(markRead(fam.wifeCtx, mine.id)).rejects.toThrow(/não encontrad/);
    expect((await listForMember(fam.ctx, { unreadOnly: true })).items).toHaveLength(3);

    const all = await markAllRead(fam.ctx);
    expect(all.updated).toBe(3);
    expect(await unreadCount(fam.ctx)).toBe(0);
    // A notificação compartilhada já foi lida; as da esposa continuam não lidas.
    expect(await unreadCount(fam.wifeCtx)).toBe(3);
  });

  it("preferências: leitura, atualização parcial e validação do horário silencioso", async () => {
    const fam = await createFamily();
    const prefs = await getPreferences(fam.wifeCtx);
    expect(prefs).toHaveLength(17);
    expect(prefs.find((p) => p.type === "BUDGET_THRESHOLD")).toMatchObject({ inApp: true, whatsapp: true, frequency: "IMMEDIATE" });
    const updated = await updatePreferences(fam.wifeCtx, [{ type: "BUDGET_THRESHOLD", quietStart: "22:00", quietEnd: "07:00", frequency: "DAILY_DIGEST" }]);
    expect(updated.find((p) => p.type === "BUDGET_THRESHOLD")).toMatchObject({ inApp: true, whatsapp: true, frequency: "DAILY_DIGEST", quietStart: "22:00", quietEnd: "07:00" });
    await expect(updatePreferences(fam.wifeCtx, [{ type: "BILL_DUE", quietStart: "22:00" }])).rejects.toThrow(/horário silencioso/);
    await expect(updatePreferences(fam.wifeCtx, [{ type: "BILL_DUE", quietStart: "25:00", quietEnd: "07:00" }])).rejects.toThrow();
    const audits = await prisma.auditLog.count({ where: { householdId: fam.householdId, entityType: "NotificationPreference" } });
    expect(audits).toBe(1);
  });

  it("despacho: envia, registra falhas e não perde notificações", async () => {
    const fam = await createFamily();
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta a vencer: Internet", body: "Internet vence amanhã.", dedupeKey: "b:1" });

    const sent = await runNotificationDispatch();
    expect(sent.sent).toBe(1);
    const [n] = await whatsappRows(fam.householdId);
    expect(n!.status).toBe("SENT");
    expect(n!.sentAt).not.toBeNull();
    expect(outbound.sent[0]).toMatchObject({
      householdId: fam.householdId,
      text: "Conta a vencer: Internet\nInternet vence amanhã.",
      kind: "notification",
      dedupeKey: `notif:${n!.id}`,
    });
    // Idempotente: nada a reenviar.
    expect((await runNotificationDispatch()).sent).toBe(0);
    expect(outbound.sent).toHaveLength(1);

    outbound.queued = false;
    outbound.reason = "WhatsApp desconectado";
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta", body: "Água vence amanhã.", dedupeKey: "b:2" });
    await runNotificationDispatch();
    let rows = await whatsappRows(fam.householdId);
    expect(rows[1]).toMatchObject({ status: "FAILED", error: "WhatsApp desconectado" });

    outbound.queued = true;
    outbound.fail = true;
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta", body: "Luz vence amanhã.", dedupeKey: "b:3" });
    await runNotificationDispatch();
    rows = await whatsappRows(fam.householdId);
    expect(rows[2]!.status).toBe("FAILED");
    expect(rows[2]!.error).toMatch(/fila indisponível/);

    outbound.fail = false;
    outbound.canSend = false;
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta", body: "Gás vence amanhã.", dedupeKey: "b:4" });
    await runNotificationDispatch();
    rows = await whatsappRows(fam.householdId);
    expect(rows[3]!.status).toBe("SKIPPED");
    expect(rows[3]!.error).toMatch(/não está conectado/);
    expect(rows).toHaveLength(4);
  });

  it("respeita o horário silencioso (fuso da família)", async () => {
    const fam = await createFamily();
    const now = new Date();
    const minutes = minutesInTimezone(TZ, now);
    await updatePreferences(fam.wifeCtx, [{ type: "BILL_DUE", quietStart: hhmm(minutes - 60), quietEnd: hhmm(minutes + 60) }]);
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta", body: "Internet vence amanhã.", dedupeKey: "q:1" });

    const during = await runNotificationDispatch(now);
    expect(during.deferred).toBe(1);
    expect((await whatsappRows(fam.householdId))[0]!.status).toBe("PENDING");

    const after = await runNotificationDispatch(new Date(now.getTime() + 2 * 3_600_000));
    expect(after.sent).toBe(1);
    expect((await whatsappRows(fam.householdId))[0]!.status).toBe("SENT");
  });

  it("notificações não enviadas em 24 horas deixam de ser enviadas", async () => {
    const fam = await createFamily();
    await notify({ householdId: fam.householdId, type: "BILL_DUE", title: "Conta", body: "Internet vence amanhã.", dedupeKey: "old:1" });
    const res = await runNotificationDispatch(new Date(Date.now() + 25 * 3_600_000));
    expect(res.expired).toBe(1);
    const [n] = await whatsappRows(fam.householdId);
    expect(n!.status).toBe("SKIPPED");
    expect(n!.error).toMatch(/24 horas/);
    expect(outbound.sent).toHaveLength(0);
  });

  it("resumo diário agrupa as notificações em DAILY_DIGEST e envia uma única mensagem", async () => {
    const fam = await createFamily();
    await updatePreferences(fam.ctx, [{ type: "BUDGET_THRESHOLD", frequency: "DAILY_DIGEST" }]);
    await updatePreferences(fam.wifeCtx, [{ type: "BUDGET_THRESHOLD", whatsapp: false }]);
    await notify({ householdId: fam.householdId, type: "BUDGET_THRESHOLD", title: "Orçamento de Alimentação", body: "Alimentação atingiu 75%.", dedupeKey: "d:1" });
    await notify({ householdId: fam.householdId, type: "BUDGET_THRESHOLD", title: "Orçamento de Lazer", body: "Lazer atingiu 50%.", dedupeKey: "d:2" });
    const items = await whatsappRows(fam.householdId);
    expect(items).toHaveLength(2);
    expect(items.every((n) => (n.data as { delivery?: string }).delivery === "DIGEST" && n.status === "PENDING")).toBe(true);

    // Antes do horário do resumo: nada é enviado.
    const morning = await runNotificationDispatch(atLocalHour(10));
    expect(morning.digests).toBe(0);
    expect(outbound.sent).toHaveLength(0);

    const evening = atLocalHour(20);
    const res = await runNotificationDispatch(evening);
    expect(res.digests).toBe(1);
    expect(res.sent).toBe(1);
    expect(outbound.sent).toHaveLength(1);
    expect(outbound.sent[0]!.text).toMatch(/Resumo do dia/);
    expect(outbound.sent[0]!.text).toMatch(/Alimentação atingiu 75%/);
    expect(outbound.sent[0]!.text).toMatch(/Lazer atingiu 50%/);
    const after = await whatsappRows(fam.householdId);
    expect(after.filter((n) => n.status === "SENT")).toHaveLength(3);

    // Uma vez por dia.
    expect((await runNotificationDispatch(new Date(evening.getTime() + 3_600_000))).digests).toBe(0);
  });

  it("API: caixa de entrada e preferências", async () => {
    const fam = await createFamily();
    for (let i = 0; i < 2; i++) await notify({ householdId: fam.householdId, type: "BILL_DUE", title: `Conta ${i}`, body: "vence amanhã", dedupeKey: `api:${i}` });
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });

    const list = await api(notificationsRoute.GET, { token, path: "/api/v1/notifications?unreadOnly=true&limit=10" });
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.unreadCount).toBe(2);
    const id = list.body.data.items[0].id as string;
    const read = await api(readRoute.POST, { token, path: `/api/v1/notifications/${id}/read`, method: "POST", params: { id } });
    expect(read.body.data.readAt).not.toBeNull();
    expect((await api(unreadRoute.GET, { token, path: "/api/v1/notifications/unread-count" })).body.data).toEqual({ count: 1 });
    expect((await api(readAllRoute.POST, { token, path: "/api/v1/notifications/read-all", method: "POST" })).body.data).toEqual({ updated: 1 });

    const prefs = await api(prefsRoute.GET, { token, path: "/api/v1/notifications/preferences" });
    expect(prefs.body.data).toHaveLength(17);
    const put = await api(prefsRoute.PUT, { token, path: "/api/v1/notifications/preferences", method: "PUT", body: { items: [{ type: "BILL_DUE", whatsapp: false, quietStart: "22:00", quietEnd: "07:00" }] } });
    expect(put.status).toBe(200);
    expect(put.body.data.find((p: { type: string }) => p.type === "BILL_DUE")).toMatchObject({ whatsapp: false, quietStart: "22:00", quietEnd: "07:00" });
    const invalid = await api(prefsRoute.PUT, { token, path: "/api/v1/notifications/preferences", method: "PUT", body: { items: [{ type: "INEXISTENTE" }] } });
    expect(invalid.status).toBe(422);
  });
});
