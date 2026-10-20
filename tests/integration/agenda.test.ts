import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import { addDays, todayISO, zonedToInstant } from "@/lib/dates";
import { createAppointment, deleteAppointment, listAppointments, updateAppointment } from "@/server/modules/agenda/service";
import { buildMorningSummary, runAppointmentReminders, runMorningSummaries } from "@/server/modules/agenda/jobs";
import { disconnectGoogle, finishGoogleConnect, getGoogleStatus, saveGoogleApp, startGoogleConnect, syncGoogleConnection, updateGoogleSettings } from "@/server/modules/agenda/google";
import { createBill } from "@/server/modules/bills/service";
import { createTransaction } from "@/server/modules/transactions/service";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, messageState, sendMessage, TZ } from "./ai-pipeline-support";

/**
 * Agenda: compromissos compartilhados × privados, comandos do WhatsApp, lembretes, resumo da manhã
 * (recorte da família) e Google Agenda somente leitura (API do Google falsa).
 */

const at = (iso: string, time: string) => zonedToInstant(iso, time, TZ);

describe("agenda", () => {
  beforeAll(() => initTestQueues("agenda"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });

  it("compartilhado aparece para todos; privado só para quem é dono", async () => {
    const fam = await createFamily();
    await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
    const fam2 = { ...fam, ctx: { ...fam.ctx, timezone: TZ }, wifeCtx: { ...fam.wifeCtx, timezone: TZ } };
    const tomorrow = addDays(todayISO(TZ), 1);
    const shared = await createAppointment(fam2.ctx, { title: "Reunião da escola", date: tomorrow, time: "19:30", endTime: "20:30", location: "Escola" });
    expect(shared).toMatchObject({ date: tomorrow, time: "19:30", endTime: "20:30", allDay: false, visibility: "SHARED", reminderMinutes: 60, readOnly: false });
    expect(new Date(shared.startsAt).toISOString()).toBe(at(tomorrow, "19:30").toISOString());
    const priv = await createAppointment(fam2.ctx, { title: "Presente surpresa", date: tomorrow, visibility: "PRIVATE" });
    expect(priv).toMatchObject({ allDay: true, time: null });
    await expect(createAppointment(fam2.ctx, { title: "X", date: tomorrow, time: "10:00", endTime: "09:00" })).rejects.toThrow(/fim precisa ser depois/);

    expect((await listAppointments(fam2.ctx)).map((a) => a.title)).toEqual(["Presente surpresa", "Reunião da escola"]);
    expect((await listAppointments(fam2.wifeCtx)).map((a) => a.title)).toEqual(["Reunião da escola"]);
    await expect(updateAppointment(fam2.wifeCtx, priv.id, { title: "Vi" })).rejects.toThrow(/não encontrad/i);
    const moved = await updateAppointment(fam2.wifeCtx, shared.id, { time: "18:00", endTime: null });
    expect(moved).toMatchObject({ time: "18:00", endTime: null });
    await deleteAppointment(fam2.ctx, shared.id);
    expect((await listAppointments(fam2.ctx)).map((a) => a.title)).toEqual(["Presente surpresa"]);
  });

  it("WhatsApp: marcar, consultar e desmarcar; privados nunca aparecem no grupo", async () => {
    const wa = await createWaFamily();
    const ctx = { ...wa.ctx, timezone: TZ };
    const tomorrow = addDays(todayISO(TZ), 1);
    await createAppointment(ctx, { title: "Exame particular", date: tomorrow, time: "08:00", visibility: "PRIVATE" });

    const made = await sendMessage(wa, { text: "marca dentista amanhã às 15h" });
    expect((await messageState(wa, made.messageId)).reply).toContain("Marquei: *Dentista*");
    const appt = await prisma.appointment.findFirstOrThrow({ where: { householdId: wa.householdId, title: "Dentista" } });
    expect(appt).toMatchObject({ visibility: "SHARED", source: "WHATSAPP", reminderMinutes: 60 });
    expect(appt.startsAt.toISOString()).toBe(at(tomorrow, "15:00").toISOString());
    expect(await prisma.transaction.count({ where: { householdId: wa.householdId } })).toBe(0);

    const list = await sendMessage(wa, { text: "o que tenho amanhã?" });
    const listReply = (await messageState(wa, list.messageId)).reply;
    expect(listReply).toContain("15:00 Dentista");
    expect(listReply).not.toContain("Exame particular");

    const del = await sendMessage(wa, { text: "desmarcar dentista" });
    expect((await messageState(wa, del.messageId)).reply).toContain("Desmarquei *Dentista*");
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).deletedAt).not.toBeNull();
    // Lançamento continua sendo lançamento.
    await sendMessage(wa, { text: "marca 50 reais no mercado hoje" });
    expect(await prisma.appointment.count({ where: { householdId: wa.householdId, deletedAt: null } })).toBe(1);
  });

  it("lembrete: uma vez, na hora certa; privado só para a pessoa e nunca no WhatsApp", async () => {
    const fam = await createFamily();
    await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
    const ctx = { ...fam.ctx, timezone: TZ };
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 60_000);
    const date = todayISO(TZ, in30);
    const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(in30);
    const shared = await createAppointment(ctx, { title: "Buscar as crianças", date, time: hhmm });
    await createAppointment(ctx, { title: "Terapia", date, time: hhmm, visibility: "PRIVATE" });
    await createAppointment(ctx, { title: "Longe ainda", date: addDays(todayISO(TZ), 3), time: "10:00" });
    expect(await runAppointmentReminders(now)).toEqual({ reminders: 2 });
    expect(await runAppointmentReminders(now)).toEqual({ reminders: 0 });
    const notes = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "APPOINTMENT_REMINDER" } });
    const terapia = notes.filter((n) => n.title.includes("Terapia"));
    expect(terapia.map((n) => [n.channel, n.recipientMemberId])).toEqual([["IN_APP", fam.husbandId]]);
    expect(notes.some((n) => n.title.includes("Buscar as crianças") && n.channel === "WHATSAPP")).toBe(true);
    // Mudou o horário: lembra de novo.
    await updateAppointment(ctx, shared.id, { time: new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now.getTime() + 45 * 60_000)), date: todayISO(TZ, new Date(now.getTime() + 45 * 60_000)) });
    expect(await runAppointmentReminders(now)).toEqual({ reminders: 1 });
  });

  it("resumo da manhã: agenda, contas do dia, vencidas e gastos de ontem; privado à parte; hora e desligar", async () => {
    const fam = await createFamily();
    await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
    const ctx = { ...fam.ctx, timezone: TZ };
    const { itau } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    await createAppointment(ctx, { title: "Dentista", date: today, time: "15:00", location: "Clínica" });
    await createAppointment(ctx, { title: "Aniversário da vó", date: today });
    await createAppointment(ctx, { title: "Exame particular", date: today, time: "08:00", visibility: "PRIVATE" });
    await createBill(fam.ctx, { description: "Internet", amountCents: 9_990, dueDate: today });
    await createBill(fam.ctx, { description: "Condomínio", amountCents: 50_000, dueDate: addDays(today, -3) });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 12_345, description: "Mercado", date: addDays(today, -1), accountId: itau.id });

    const text = await buildMorningSummary(fam.householdId, TZ, today);
    expect(text.title).toMatch(/^Bom dia! Resumo de \w+/);
    expect(text.body).toContain("Dia todo Aniversário da vó");
    expect(text.body).toContain("15:00 Dentista (Clínica)");
    expect(text.body).toContain("Internet: R$ 99,90");
    expect(text.body).toContain("1 conta(s) vencida(s) sem pagamento: R$ 500,00");
    expect(text.body).toContain("Ontem: R$ 123,45 em gastos");
    expect(text.body).not.toContain("Exame particular");

    const seven = at(today, "07:10");
    expect(await runMorningSummaries(at(today, "06:30"), { householdId: fam.householdId })).toMatchObject({ sent: 0 });
    expect(await runMorningSummaries(seven, { householdId: fam.householdId })).toMatchObject({ sent: 1 });
    expect(await runMorningSummaries(at(today, "08:00"), { householdId: fam.householdId })).toMatchObject({ sent: 0 });
    const notes = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "MORNING_SUMMARY" } });
    const priv = notes.filter((n) => n.title === "Seus compromissos privados hoje");
    expect(priv.map((n) => [n.channel, n.recipientMemberId])).toEqual([["IN_APP", fam.husbandId]]);
    expect(priv[0]!.body).toContain("08:00 Exame particular");
    expect(notes.some((n) => n.channel === "WHATSAPP" && n.body.includes("Dentista") && !n.body.includes("Exame"))).toBe(true);

    await prisma.householdSettings.update({ where: { householdId: fam.householdId }, data: { morningSummaryEnabled: false } });
    expect(await runMorningSummaries(at(addDays(today, 1), "07:10"), { householdId: fam.householdId })).toMatchObject({ households: 0, sent: 0 });
  });
});

// ---------------------------------------------------------------------------------- Google Agenda

const GOOGLE = {
  events: [] as Array<Record<string, unknown>>,
  refreshFails: false,
  tokenCalls: 0,
};
const googleFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
    GOOGLE.tokenCalls++;
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (form.get("client_secret") !== "segredo-google-123") return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      if (form.get("code") !== "codigo-ok" || !form.get("code_verifier")) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.readonly" });
    }
    return GOOGLE.refreshFails ? json(400, { error: "invalid_grant" }) : json(200, { access_token: "at-2", expires_in: 3600 });
  }
  if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
  const auth = new Headers(init?.headers).get("Authorization");
  if (!auth?.startsWith("Bearer at-")) return json(401, { error: { status: "UNAUTHENTICATED" } });
  if (url.pathname === "/calendar/v3/calendars/primary") return json(200, { id: "joao@example.com" });
  if (url.pathname === "/calendar/v3/calendars/primary/events") return json(200, { items: GOOGLE.events });
  return json(404, {});
});

describe("Google Agenda (somente leitura)", () => {
  beforeEach(async () => {
    await resetDatabase();
    GOOGLE.events = [];
    GOOGLE.refreshFails = false;
    GOOGLE.tokenCalls = 0;
    vi.stubGlobal("fetch", googleFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("conecta com PKCE, importa como privado, compartilha se pedir, acompanha exclusões e expiração", async () => {
    const fam = await createFamily();
    await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
    const ctx = { ...fam.ctx, timezone: TZ };
    await expect(startGoogleConnect(ctx)).rejects.toThrow(/configurar o Google Agenda/);
    await expect(saveGoogleApp(fam.wifeCtx, { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "segredo-google-123" })).rejects.toThrow();
    await expect(saveGoogleApp(ctx, { clientId: "nao-e-google", clientSecret: "segredo-google-123" })).rejects.toThrow(/apps.googleusercontent.com/);
    const st = await saveGoogleApp(ctx, { clientId: "123-abcdef.apps.googleusercontent.com", clientSecret: "segredo-google-123" });
    expect(st).toMatchObject({ appConfigured: true, me: null, redirectUri: "http://localhost:3000/api/v1/integrations/google/callback" });
    expect(JSON.stringify(await prisma.googleOAuthApp.findFirst())).not.toContain("segredo-google-123");

    const { url } = await startGoogleConnect(ctx);
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(auth.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    const state = auth.searchParams.get("state")!;
    // Outra pessoa não pode usar o state de quem pediu.
    expect(await finishGoogleConnect({ ...fam.wifeCtx, timezone: TZ }, { code: "codigo-ok", state })).toMatchObject({ ok: false });
    expect(await finishGoogleConnect(ctx, { error: "access_denied" })).toMatchObject({ ok: false, message: "Você não autorizou o acesso à agenda." });

    const tomorrow = addDays(todayISO(TZ), 1);
    GOOGLE.events = [
      { id: "ev1", status: "confirmed", summary: "Reunião com cliente", location: "Escritório", start: { dateTime: at(tomorrow, "10:00").toISOString() }, end: { dateTime: at(tomorrow, "11:00").toISOString() } },
      { id: "ev2", status: "confirmed", summary: "Feriado", start: { date: tomorrow }, end: { date: addDays(tomorrow, 1) } },
      { id: "ev3", status: "cancelled", summary: "Cancelado", start: { dateTime: at(tomorrow, "12:00").toISOString() } },
    ];
    expect(await finishGoogleConnect(ctx, { code: "codigo-ok", state })).toEqual({ ok: true, message: "Google Agenda conectado." });
    const conn = await prisma.googleCalendarConnection.findUniqueOrThrow({ where: { memberId: fam.husbandId } });
    expect(conn.email).toBe("joao@example.com");
    expect(conn.refreshTokenEnc).not.toContain("rt-1");
    const mine = await listAppointments(ctx, { start: todayISO(TZ), end: addDays(tomorrow, 2) });
    expect(mine.map((a) => [a.title, a.visibility, a.readOnly, a.allDay])).toEqual([
      ["Feriado", "PRIVATE", true, true],
      ["Reunião com cliente", "PRIVATE", true, false],
    ]);
    expect(await listAppointments({ ...fam.wifeCtx, timezone: TZ }, { start: todayISO(TZ), end: addDays(tomorrow, 2) })).toEqual([]);
    await expect(updateAppointment(ctx, mine[1]!.id, { title: "x" })).rejects.toThrow(/Google Agenda/);
    expect((await getGoogleStatus(ctx)).me).toMatchObject({ connected: true, email: "joao@example.com", events: 2, shareWithFamily: false });

    await updateGoogleSettings(ctx, { shareWithFamily: true });
    expect((await listAppointments({ ...fam.wifeCtx, timezone: TZ }, { start: todayISO(TZ), end: addDays(tomorrow, 2) })).map((a) => a.title)).toEqual(["Feriado", "Reunião com cliente"]);

    // Evento apagado no Google some daqui; token expirado é renovado.
    GOOGLE.events = GOOGLE.events.slice(0, 1);
    await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    expect(await syncGoogleConnection(conn.id)).toEqual({ events: 1 });
    expect(await prisma.appointment.count({ where: { googleConnectionId: conn.id } })).toBe(1);

    // Acesso removido no Google: avisa e limpa os tokens.
    GOOGLE.refreshFails = true;
    await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    await expect(syncGoogleConnection(conn.id)).rejects.toThrow(/expirou/);
    const after = await prisma.googleCalendarConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after).toMatchObject({ refreshTokenEnc: null, lastError: "O acesso ao Google expirou ou foi removido. Conecte de novo." });

    await disconnectGoogle(ctx);
    expect(await prisma.appointment.count({ where: { source: "GOOGLE" } })).toBe(0);
  });
});
