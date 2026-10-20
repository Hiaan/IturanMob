import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { GoogleCalendarConnection } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { decryptStringSafe, encryptString } from "../../crypto";
import { env } from "../../env";
import { NotFoundError, ValidationError } from "../../errors";
import { errorInfo, logger } from "../../logger";
import { publishEvent } from "../../events";
import { addDays, todayISO, zonedToInstant } from "@/lib/dates";
import { audit } from "../audit/service";

/**
 * Google Agenda (somente leitura). Cada pessoa conecta a própria conta Google; os eventos entram
 * como compromissos PRIVADOS dela (nunca vão para o grupo do WhatsApp), a menos que ela escolha
 * compartilhar com a família. O app usa a aplicação OAuth criada pela própria família no Google
 * Cloud (Client ID/Secret cifrados). Tokens cifrados; nada disso vai para logs. Só título, horário e
 * local são guardados (a descrição dos eventos não).
 */

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 20_000;
/** Janela sincronizada: de ontem até 60 dias à frente. */
const WINDOW_BACK_DAYS = 1;
const WINDOW_AHEAD_DAYS = 60;
const SYNC_EVERY_MS = 25 * 60_000;
const STATE_TTL_MS = 10 * 60_000;

export function googleRedirectUri(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/v1/integrations/google/callback`;
}

function simulatorAvailable() {
  return env().GOOGLE_CALENDAR_SIMULATOR;
}

class GoogleError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

async function googleFetch(url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GoogleError("Não consegui falar com o Google (sem conexão ou tempo esgotado).");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body ?? {}) as { error?: unknown; error_description?: unknown };
    const code = typeof err.error === "string" ? err.error : typeof (err.error as { status?: unknown })?.status === "string" ? String((err.error as { status: string }).status) : null;
    if (code === "invalid_grant") throw new GoogleError("O acesso ao Google expirou ou foi removido. Conecte de novo.", code);
    if (code === "invalid_client" || code === "unauthorized_client") throw new GoogleError("O Google recusou o Client ID/Secret configurados.", code);
    if (res.status === 401 || res.status === 403) throw new GoogleError("O Google recusou o acesso à agenda. Conecte de novo.", code);
    throw new GoogleError(`Erro do Google (HTTP ${res.status}).`, code);
  }
  return body;
}

// -----------------------------------------------------------------------------
// Configuração (aplicação OAuth da família)
// -----------------------------------------------------------------------------

export const googleAppSchema = z.object({
  clientId: z.string().trim().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, "Client ID do Google termina com .apps.googleusercontent.com").max(200),
  clientSecret: z.string().trim().min(10, "Cole o Client Secret").max(200).optional(),
});

async function appCredentials(householdId: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const app = await prisma.googleOAuthApp.findUnique({ where: { householdId } });
  const clientId = decryptStringSafe(app?.clientIdEnc);
  const clientSecret = decryptStringSafe(app?.clientSecretEnc);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export interface GoogleStatusDTO {
  appConfigured: boolean;
  clientIdHint: string | null;
  redirectUri: string;
  simulatorAvailable: boolean;
  canManageApp: boolean;
  me: { connected: boolean; simulated: boolean; email: string | null; shareWithFamily: boolean; lastSyncAt: string | null; lastError: string | null; events: number } | null;
  /** Quem da família já conectou (sem e-mail). */
  connectedMembers: Array<{ memberId: string; name: string; simulated: boolean }>;
}

export async function getGoogleStatus(ctx: ServiceContext): Promise<GoogleStatusDTO> {
  assertCan(ctx, "transactions:read");
  const app = await appCredentials(ctx.householdId);
  const mine = ctx.memberId ? await prisma.googleCalendarConnection.findUnique({ where: { memberId: ctx.memberId } }) : null;
  const all = await prisma.googleCalendarConnection.findMany({ where: { householdId: ctx.householdId }, include: { member: { select: { displayName: true } } } });
  const events = mine ? await prisma.appointment.count({ where: { googleConnectionId: mine.id, deletedAt: null } }) : 0;
  let canManageApp = true;
  try {
    assertCan(ctx, "integrations:manage");
  } catch {
    canManageApp = false;
  }
  return {
    appConfigured: Boolean(app),
    clientIdHint: app ? `…${app.clientId.split(".")[0]!.slice(-6)}` : null,
    redirectUri: googleRedirectUri(),
    simulatorAvailable: simulatorAvailable(),
    canManageApp,
    me: mine
      ? { connected: true, simulated: mine.simulated, email: mine.email, shareWithFamily: mine.shareWithFamily, lastSyncAt: mine.lastSyncAt?.toISOString() ?? null, lastError: mine.lastError, events }
      : null,
    connectedMembers: all.map((c) => ({ memberId: c.memberId, name: c.member.displayName, simulated: c.simulated })),
  };
}

export async function saveGoogleApp(ctx: ServiceContext, raw: z.input<typeof googleAppSchema>): Promise<GoogleStatusDTO> {
  assertCan(ctx, "integrations:manage");
  const input = googleAppSchema.parse(raw);
  const current = await appCredentials(ctx.householdId);
  const secret = input.clientSecret || current?.clientSecret;
  if (!secret) throw new ValidationError("Cole o Client Secret.");
  await prisma.googleOAuthApp.upsert({
    where: { householdId: ctx.householdId },
    create: { householdId: ctx.householdId, clientIdEnc: encryptString(input.clientId), clientSecretEnc: encryptString(secret) },
    update: { clientIdEnc: encryptString(input.clientId), clientSecretEnc: encryptString(secret) },
  });
  await audit(ctx, { action: "UPDATE", entityType: "GoogleOAuthApp", entityId: ctx.householdId, after: { credentials: "atualizadas (cifradas)" } });
  return getGoogleStatus(ctx);
}

// -----------------------------------------------------------------------------
// Conectar (OAuth com PKCE) — cada pessoa, a própria agenda
// -----------------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface OAuthState {
  m: string;
  h: string;
  exp: number;
  v: string;
}

/** Endereço do consentimento do Google (state cifrado com quem pediu, validade e o PKCE). */
export async function startGoogleConnect(ctx: ServiceContext): Promise<{ url: string }> {
  assertCan(ctx, "transactions:read");
  if (!ctx.memberId) throw new ValidationError("Entre com a sua conta para conectar a sua agenda.");
  const app = await appCredentials(ctx.householdId);
  if (!app) throw new ValidationError("Peça a quem administra a família para configurar o Google Agenda em Integrações.");
  const verifier = b64url(randomBytes(32));
  const state: OAuthState = { m: ctx.memberId, h: ctx.householdId, exp: Date.now() + STATE_TTL_MS, v: verifier };
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: b64url(Buffer.from(encryptString(JSON.stringify(state)))),
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return { url: `${AUTH_URL}?${params.toString()}` };
}

function readState(raw: string): OAuthState | null {
  try {
    const json = decryptStringSafe(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const st = json ? (JSON.parse(json) as OAuthState) : null;
    return st && typeof st.m === "string" && typeof st.v === "string" && st.exp > Date.now() ? st : null;
  } catch {
    return null;
  }
}

/** Volta do Google: troca o código pelos tokens (só a mesma pessoa que pediu, dentro de 10 min). */
export async function finishGoogleConnect(ctx: ServiceContext, input: { code?: string | null; state?: string | null; error?: string | null }): Promise<{ ok: boolean; message: string }> {
  if (input.error) return { ok: false, message: input.error === "access_denied" ? "Você não autorizou o acesso à agenda." : "O Google não concluiu a autorização." };
  const st = input.state ? readState(input.state) : null;
  if (!st || st.m !== ctx.memberId || st.h !== ctx.householdId || !input.code) return { ok: false, message: "Link de autorização inválido ou expirado. Tente conectar de novo." };
  const app = await appCredentials(ctx.householdId);
  if (!app) return { ok: false, message: "O Google Agenda não está configurado." };
  try {
    const tok = (await googleFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: input.code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: googleRedirectUri(), grant_type: "authorization_code", code_verifier: st.v }).toString(),
    })) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!tok.access_token || !tok.refresh_token) return { ok: false, message: "O Google não devolveu o acesso permanente. Remova o app em myaccount.google.com/permissions e conecte de novo." };
    if (tok.scope && !tok.scope.split(" ").includes(GOOGLE_SCOPE)) return { ok: false, message: "A permissão de ler a agenda não foi concedida." };
    const cal = (await googleFetch(`${CAL_API}/calendars/primary`, { headers: { Authorization: `Bearer ${tok.access_token}` } })) as { id?: string };
    const data = {
      householdId: ctx.householdId,
      simulated: false,
      email: typeof cal.id === "string" ? cal.id.slice(0, 200) : null,
      accessTokenEnc: encryptString(tok.access_token),
      refreshTokenEnc: encryptString(tok.refresh_token),
      accessExpiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000),
      lastError: null,
    };
    const conn = await prisma.googleCalendarConnection.upsert({ where: { memberId: ctx.memberId! }, create: { ...data, memberId: ctx.memberId! }, update: data });
    await audit(ctx, { action: "CREATE", entityType: "GoogleCalendarConnection", entityId: conn.id, after: { scope: "calendar.readonly" } });
    await syncGoogleConnection(conn.id).catch(() => undefined);
    return { ok: true, message: "Google Agenda conectado." };
  } catch (err) {
    return { ok: false, message: err instanceof GoogleError ? err.message : "Falha ao conectar com o Google." };
  }
}

/** Simulador (desenvolvimento): eventos de exemplo, identificados como tal. */
export async function connectSimulatedGoogle(ctx: ServiceContext): Promise<GoogleStatusDTO> {
  assertCan(ctx, "transactions:read");
  if (!simulatorAvailable()) throw new ValidationError("O simulador do Google Agenda está desligado neste servidor.");
  if (!ctx.memberId) throw new ValidationError("Entre com a sua conta.");
  const conn = await prisma.googleCalendarConnection.upsert({
    where: { memberId: ctx.memberId },
    create: { householdId: ctx.householdId, memberId: ctx.memberId, simulated: true, email: "agenda-simulada@exemplo.invalid" },
    update: { simulated: true, email: "agenda-simulada@exemplo.invalid", accessTokenEnc: null, refreshTokenEnc: null, lastError: null },
  });
  await syncGoogleConnection(conn.id);
  return getGoogleStatus(ctx);
}

export const googleSettingsSchema = z.object({ shareWithFamily: z.boolean() });

/** Compartilhar os eventos com a família (aparecem para todos e no grupo) ou mantê-los privados. */
export async function updateGoogleSettings(ctx: ServiceContext, raw: z.input<typeof googleSettingsSchema>): Promise<GoogleStatusDTO> {
  const input = googleSettingsSchema.parse(raw);
  if (!ctx.memberId) throw new ValidationError("Entre com a sua conta.");
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { memberId: ctx.memberId } });
  if (!conn) throw new NotFoundError("Conexão com o Google Agenda");
  await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { shareWithFamily: input.shareWithFamily } });
  await prisma.appointment.updateMany({ where: { googleConnectionId: conn.id }, data: { visibility: input.shareWithFamily ? "SHARED" : "PRIVATE" } });
  await audit(ctx, { action: "UPDATE", entityType: "GoogleCalendarConnection", entityId: conn.id, before: { shareWithFamily: conn.shareWithFamily }, after: input });
  await publishEvent(ctx.householdId, "appointment.changed");
  return getGoogleStatus(ctx);
}

/** Desconecta: revoga o acesso no Google (melhor esforço) e apaga as cópias dos eventos. */
export async function disconnectGoogle(ctx: ServiceContext): Promise<GoogleStatusDTO> {
  if (!ctx.memberId) throw new ValidationError("Entre com a sua conta.");
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { memberId: ctx.memberId } });
  if (!conn) return getGoogleStatus(ctx);
  const token = decryptStringSafe(conn.refreshTokenEnc);
  if (token) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
  }
  await prisma.googleCalendarConnection.delete({ where: { id: conn.id } });
  await audit(ctx, { action: "DELETE", entityType: "GoogleCalendarConnection", entityId: conn.id });
  await publishEvent(ctx.householdId, "appointment.changed");
  return getGoogleStatus(ctx);
}

// -----------------------------------------------------------------------------
// Sincronização
// -----------------------------------------------------------------------------

interface CalEvent {
  id: string;
  title: string;
  allDay: boolean;
  /** AAAA-MM-DD (dia todo) ou ISO com horário. */
  start: string;
  end: string | null;
  location: string | null;
}

async function accessToken(conn: GoogleCalendarConnection): Promise<string> {
  const current = decryptStringSafe(conn.accessTokenEnc);
  if (current && conn.accessExpiresAt && conn.accessExpiresAt.getTime() - Date.now() > 60_000) return current;
  const refresh = decryptStringSafe(conn.refreshTokenEnc);
  const app = await appCredentials(conn.householdId);
  if (!refresh || !app) throw new GoogleError("O acesso ao Google não está configurado. Conecte de novo.");
  const tok = (await googleFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
  })) as { access_token?: string; expires_in?: number };
  if (!tok.access_token) throw new GoogleError("O Google não devolveu o acesso.");
  await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { accessTokenEnc: encryptString(tok.access_token), accessExpiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000) } });
  return tok.access_token;
}

async function fetchEvents(conn: GoogleCalendarConnection, from: Date, to: Date): Promise<CalEvent[]> {
  if (conn.simulated) {
    const out: CalEvent[] = [];
    const names = ["Consulta (simulado)", "Reunião (simulado)", "Aniversário (simulado)"];
    for (let i = 0; i < 3; i++) {
      const day = new Date(from.getTime() + (i * 3 + 2) * 86_400_000).toISOString().slice(0, 10);
      out.push(i === 2 ? { id: `sim-${i}`, title: names[i]!, allDay: true, start: day, end: null, location: null } : { id: `sim-${i}`, title: names[i]!, allDay: false, start: `${day}T13:00:00.000Z`, end: `${day}T14:00:00.000Z`, location: i === 0 ? "Clínica Exemplo" : null });
    }
    return out;
  }
  const token = await accessToken(conn);
  const out: CalEvent[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250", fields: "items(id,status,summary,location,start,end),nextPageToken" });
    if (pageToken) qs.set("pageToken", pageToken);
    const body = (await googleFetch(`${CAL_API}/calendars/${encodeURIComponent(conn.calendarId)}/events?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } })) as {
      items?: Array<{ id?: string; status?: string; summary?: string; location?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } }>;
      nextPageToken?: string;
    };
    for (const e of body.items ?? []) {
      if (!e.id || e.status === "cancelled" || !e.start) continue;
      const allDay = Boolean(e.start.date && !e.start.dateTime);
      out.push({
        id: e.id.slice(0, 200),
        title: (e.summary ?? "").trim().slice(0, 160) || "(sem título)",
        allDay,
        start: (allDay ? e.start.date : e.start.dateTime)!,
        end: allDay ? null : e.end?.dateTime ?? null,
        location: e.location?.trim().slice(0, 200) || null,
      });
    }
    pageToken = body.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return out;
}

export async function syncGoogleConnection(connectionId: string): Promise<{ events: number }> {
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { id: connectionId }, include: { household: { select: { timezone: true } } } });
  if (!conn) throw new NotFoundError("Conexão com o Google Agenda");
  if (conn.simulated && !simulatorAvailable()) throw new ValidationError("O simulador do Google Agenda está desligado neste servidor.");
  const tz = conn.household.timezone;
  const today = todayISO(tz);
  const from = zonedToInstant(addDays(today, -WINDOW_BACK_DAYS), "00:00", tz);
  const to = zonedToInstant(addDays(today, WINDOW_AHEAD_DAYS), "00:00", tz);
  try {
    const events = await fetchEvents(conn, from, to);
    const seen: string[] = [];
    for (const e of events) {
      const startsAt = e.allDay ? zonedToInstant(e.start, "00:00", tz) : new Date(e.start);
      if (Number.isNaN(startsAt.getTime())) continue;
      const endsAt = e.end ? new Date(e.end) : null;
      seen.push(e.id);
      const data = {
        title: e.title,
        startsAt,
        endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
        allDay: e.allDay,
        location: e.location,
        visibility: conn.shareWithFamily ? ("SHARED" as const) : ("PRIVATE" as const),
        deletedAt: null,
      };
      await prisma.appointment.upsert({
        where: { googleConnectionId_externalId: { googleConnectionId: conn.id, externalId: e.id } },
        create: { ...data, householdId: conn.householdId, ownerMemberId: conn.memberId, source: "GOOGLE", externalId: e.id, googleConnectionId: conn.id, reminderMinutes: null },
        update: data,
      });
    }
    // Evento apagado no Google (dentro da janela): some daqui também (é só uma cópia).
    await prisma.appointment.deleteMany({ where: { googleConnectionId: conn.id, startsAt: { gte: from, lt: to }, externalId: { notIn: seen.length ? seen : ["-"] } } });
    await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), lastError: null } });
    await publishEvent(conn.householdId, "appointment.changed");
    return { events: events.length };
  } catch (err) {
    const message = err instanceof GoogleError || err instanceof ValidationError ? err.message : "Falha ao ler o Google Agenda.";
    await prisma.googleCalendarConnection.update({
      where: { id: conn.id },
      data: { lastSyncAt: new Date(), lastError: message, ...(err instanceof GoogleError && err.code === "invalid_grant" ? { accessTokenEnc: null, refreshTokenEnc: null } : {}) },
    });
    throw err;
  }
}

/** "Atualizar agora" na tela. */
export async function syncMyGoogle(ctx: ServiceContext): Promise<GoogleStatusDTO> {
  if (!ctx.memberId) throw new ValidationError("Entre com a sua conta.");
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { memberId: ctx.memberId } });
  if (!conn) throw new NotFoundError("Conexão com o Google Agenda");
  try {
    await syncGoogleConnection(conn.id);
  } catch (err) {
    if (err instanceof GoogleError) throw new ValidationError(err.message);
    throw err;
  }
  return getGoogleStatus(ctx);
}

export async function runGoogleCalendarJobs(now: Date = new Date()): Promise<{ synced: number; errors: number }> {
  const summary = { synced: 0, errors: 0 };
  const conns = await prisma.googleCalendarConnection.findMany({
    where: { OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - SYNC_EVERY_MS) } }], AND: [{ OR: [{ refreshTokenEnc: { not: null } }, { simulated: true }] }] },
    select: { id: true, simulated: true },
  });
  for (const c of conns) {
    if (c.simulated && !simulatorAvailable()) continue;
    try {
      await syncGoogleConnection(c.id);
      summary.synced++;
    } catch (err) {
      summary.errors++;
      logger.warn({ connectionId: c.id, err: errorInfo(err).name }, "google: falha ao ler a agenda");
    }
  }
  return summary;
}
