import { z } from "zod";
import QRCode from "qrcode";
import type { MessageStatus, Prisma, WhatsAppProviderType } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { emitEvent as publishEvent, withRedis } from "./redis-safe";
import type { ServiceContext } from "../auth/context";
import { assertCan } from "../auth/permissions";
import { AppError, NotFoundError, ValidationError } from "../errors";
import { audit } from "../modules/audit/service";
import { getVisibilityScope, visibleTransactionWhere } from "../modules/visibility/scope";
import { dateToISO } from "@/lib/dates";
import { publishCommand, workerStatus } from "./commands";
import { ensureConnection, mergeConfig, readConfig } from "./config";
import { cloudConfig } from "./cloud-api/provider";
import { upsertSyncedGroups } from "./groups";
import { enqueueInboundJob } from "./inbound-queue";
import { ingestMessage, type IngestSkipReason } from "./ingest";
import { qrKey, QR_TTL_SECONDS } from "./keys";
import { whatsappCanSend } from "./outbound";
import { runProcessingJob, type ProcessOutcome } from "./processor";
import { queueReceivedMessages } from "./recovery";
import { buildSimulatedMessage, SIMULATOR_GROUP_ID, SIMULATOR_GROUP_NAME } from "./simulator/provider";
import { BAILEYS_RISK_WARNING, MAX_MEDIA_BYTES, PROVIDER_CAPABILITIES, PROVIDER_INFO, SIMULATOR_NOTICE } from "./types";

/**
 * Serviço da integração (camada usada pelas rotas do Next.js). Não importa o Baileys:
 * a comunicação com o worker é feita pelo banco (estado desejado) + Redis (comandos/QR).
 */

const MESSAGE_STATUSES: MessageStatus[] = ["RECEIVED", "QUEUED", "PROCESSING", "PROCESSED", "IGNORED", "NEEDS_CLARIFICATION", "FAILED"];

function providerAvailable(type: WhatsAppProviderType): { enabled: boolean; reason: string | null } {
  if (type === "SIMULATOR" && !env().WHATSAPP_ENABLE_SIMULATOR) return { enabled: false, reason: "Desabilitado (WHATSAPP_ENABLE_SIMULATOR=false)" };
  if (type === "CLOUD_API" && !cloudConfig()) return { enabled: true, reason: "Requer WHATSAPP_CLOUD_ACCESS_TOKEN e WHATSAPP_CLOUD_PHONE_NUMBER_ID" };
  return { enabled: true, reason: null };
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export async function getWhatsAppStatus(ctx: ServiceContext) {
  const conn = await ensureConnection(ctx.householdId);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [stats, events, groups, members, canSend, worker, qrAvailable] = await Promise.all([
    prisma.whatsAppMessage.groupBy({
      by: ["status"],
      where: { householdId: ctx.householdId, direction: "INBOUND", sentAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.whatsAppConnectionEvent.findMany({ where: { connectionId: conn.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.whatsAppGroup.findMany({ where: { connectionId: conn.id }, orderBy: [{ isAuthorized: "desc" }, { name: "asc" }] }),
    prisma.householdMember.findMany({
      where: { householdId: ctx.householdId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, displayName: true, relation: true, whatsappPhone: true, whatsappAuthorized: true, whatsappConsentAt: true, whatsappJid: true, whatsappLid: true },
    }),
    whatsappCanSend(ctx.householdId),
    workerStatus(),
    withRedis(async (r) => (await r.exists(qrKey(ctx.householdId))) === 1, false),
  ]);
  const byStatus = Object.fromEntries(MESSAGE_STATUSES.map((s) => [s, 0])) as Record<MessageStatus, number>;
  let total = 0;
  for (const s of stats) {
    byStatus[s.status] = s._count._all;
    total += s._count._all;
  }
  const cfg = readConfig(conn.config);
  const authorizedGroup = groups.find((g) => g.isAuthorized) ?? null;
  const groupDto = (g: (typeof groups)[number]) => ({
    id: g.id,
    name: g.name,
    participantsCount: g.participantsCount,
    isAuthorized: g.isAuthorized,
    authorizedAt: g.authorizedAt,
    lastSyncedAt: g.lastSyncedAt,
    isSimulator: g.externalId === SIMULATOR_GROUP_ID,
  });
  return {
    provider: conn.provider,
    providerLabel: PROVIDER_INFO[conn.provider].label,
    providerDescription: PROVIDER_INFO[conn.provider].description,
    official: PROVIDER_INFO[conn.provider].official,
    riskWarning: conn.provider === "BAILEYS" ? BAILEYS_RISK_WARNING : null,
    simulator: conn.provider === "SIMULATOR" ? { notice: SIMULATOR_NOTICE, enabled: env().WHATSAPP_ENABLE_SIMULATOR } : null,
    capabilities: PROVIDER_CAPABILITIES[conn.provider],
    status: conn.status,
    desiredConnected: conn.desiredConnected,
    phoneNumber: conn.phoneNumber,
    displayName: conn.displayName,
    lastConnectedAt: conn.lastConnectedAt,
    lastDisconnectedAt: conn.lastDisconnectedAt,
    lastMessageAt: conn.lastMessageAt,
    lastError: conn.lastError,
    lastErrorAt: conn.lastErrorAt,
    processingEnabled: conn.processingEnabled,
    pendingRequests: {
      logout: Boolean(cfg.logoutRequestedAt),
      reconnect: Boolean(cfg.reconnectRequestedAt),
      groupSync: Boolean(cfg.groupSyncRequestedAt),
    },
    qrAvailable,
    worker,
    stats7d: { total, byStatus },
    recentErrors: events
      .filter((e) => e.type === "ERROR" || e.type === "LOGGED_OUT" || e.type === "DISCONNECTED")
      .slice(0, 10)
      .map((e) => ({ id: e.id, type: e.type, message: e.message, createdAt: e.createdAt })),
    recentEvents: events.slice(0, 15).map((e) => ({ id: e.id, type: e.type, message: e.message, createdAt: e.createdAt })),
    groups: groups.map(groupDto),
    authorizedGroup: authorizedGroup ? groupDto(authorizedGroup) : null,
    members: members.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      relation: m.relation,
      whatsappPhone: m.whatsappPhone,
      whatsappAuthorized: m.whatsappAuthorized,
      whatsappConsentAt: m.whatsappConsentAt,
      hasConsent: Boolean(m.whatsappConsentAt),
      identified: Boolean(m.whatsappJid || m.whatsappLid),
      ready: Boolean(m.whatsappPhone && m.whatsappAuthorized && m.whatsappConsentAt),
    })),
    canSend,
    cloudApi:
      conn.provider === "CLOUD_API"
        ? {
            configured: Boolean(cloudConfig(cfg)),
            webhookUrl: `${env().APP_URL.replace(/\/$/, "")}/api/webhooks/whatsapp`,
            verifyTokenConfigured: Boolean(env().WHATSAPP_CLOUD_VERIFY_TOKEN),
            appSecretConfigured: Boolean(env().WHATSAPP_CLOUD_APP_SECRET),
            phoneNumberId: cfg.phoneNumberId ?? env().WHATSAPP_CLOUD_PHONE_NUMBER_ID ?? null,
            note: "Na Cloud API as mensagens chegam como conversas diretas com o número comercial: somente as conversas dos membros autorizados (com consentimento) são processadas.",
          }
        : null,
    availableProviders: (["CLOUD_API", "BAILEYS", "SIMULATOR"] as WhatsAppProviderType[]).map((type) => ({
      type,
      label: PROVIDER_INFO[type].label,
      official: PROVIDER_INFO[type].official,
      description: PROVIDER_INFO[type].description,
      ...providerAvailable(type),
    })),
  };
}

// -----------------------------------------------------------------------------
// Conexão (estado desejado + comando ao worker)
// -----------------------------------------------------------------------------

async function afterCommand(ctx: ServiceContext, type: Parameters<typeof publishCommand>[0]) {
  const delivered = await publishCommand(type, ctx.householdId);
  await publishEvent(ctx.householdId, "whatsapp.status");
  const worker = await workerStatus();
  return {
    ok: true,
    commandDelivered: delivered,
    workerOnline: worker.online,
    message: worker.online ? null : "O worker não está em execução: o pedido será aplicado quando ele iniciar (pnpm worker).",
  };
}

function assertProviderUsable(provider: WhatsAppProviderType, config: Prisma.JsonValue | null) {
  if (provider === "SIMULATOR" && !env().WHATSAPP_ENABLE_SIMULATOR) throw new ValidationError("O simulador está desabilitado neste ambiente.");
  if (provider === "CLOUD_API" && !cloudConfig(readConfig(config))) {
    throw new ValidationError("Configure WHATSAPP_CLOUD_ACCESS_TOKEN e WHATSAPP_CLOUD_PHONE_NUMBER_ID antes de conectar a Cloud API.");
  }
}

export async function requestConnect(ctx: ServiceContext) {
  assertCan(ctx, "integrations:manage");
  const conn = await ensureConnection(ctx.householdId);
  assertProviderUsable(conn.provider, conn.config);
  // Um logout pendente continua valendo: o worker encerra a sessão antiga e inicia uma nova (novo QR Code).
  await prisma.whatsAppConnection.update({ where: { id: conn.id }, data: { desiredConnected: true } });
  await audit(ctx, { action: "CONNECT", entityType: "WhatsAppConnection", entityId: conn.id, after: { provider: conn.provider } });
  return afterCommand(ctx, "connect");
}

export async function requestDisconnect(ctx: ServiceContext) {
  assertCan(ctx, "integrations:manage");
  const conn = await ensureConnection(ctx.householdId);
  const cfg = mergeConfig(readConfig(conn.config), { reconnectRequestedAt: null });
  await prisma.whatsAppConnection.update({ where: { id: conn.id }, data: { desiredConnected: false, config: cfg as Prisma.InputJsonValue } });
  await audit(ctx, { action: "DISCONNECT", entityType: "WhatsAppConnection", entityId: conn.id, after: { provider: conn.provider } });
  return afterCommand(ctx, "disconnect");
}

export async function requestReconnect(ctx: ServiceContext) {
  assertCan(ctx, "integrations:manage");
  const conn = await ensureConnection(ctx.householdId);
  assertProviderUsable(conn.provider, conn.config);
  const cfg = mergeConfig(readConfig(conn.config), { reconnectRequestedAt: new Date().toISOString() });
  await prisma.whatsAppConnection.update({ where: { id: conn.id }, data: { desiredConnected: true, config: cfg as Prisma.InputJsonValue } });
  await audit(ctx, { action: "CONNECT", entityType: "WhatsAppConnection", entityId: conn.id, metadata: { operation: "reconnect" } });
  return afterCommand(ctx, "reconnect");
}

export async function requestLogout(ctx: ServiceContext) {
  assertCan(ctx, "integrations:manage");
  const conn = await ensureConnection(ctx.householdId);
  const worker = await workerStatus();
  await audit(ctx, { action: "DISCONNECT", entityType: "WhatsAppConnection", entityId: conn.id, metadata: { operation: "logout", provider: conn.provider } });
  // O pedido fica registrado no banco: o worker encerra a sessão no WhatsApp (aparelho conectado) e apaga as credenciais.
  const cfg = mergeConfig(readConfig(conn.config), { logoutRequestedAt: new Date().toISOString(), reconnectRequestedAt: null });
  if (worker.online) {
    await prisma.whatsAppConnection.update({ where: { id: conn.id }, data: { desiredConnected: false, config: cfg as Prisma.InputJsonValue } });
    return afterCommand(ctx, "logout");
  }
  // Sem worker não há sessão ativa: apaga as credenciais locais já (o pedido continua registrado para o worker).
  await prisma.$transaction([
    prisma.whatsAppAuthState.deleteMany({ where: { connectionId: conn.id } }),
    prisma.whatsAppConnection.update({
      where: { id: conn.id },
      data: {
        desiredConnected: false,
        status: "LOGGED_OUT",
        phoneNumber: null,
        displayName: null,
        lastDisconnectedAt: new Date(),
        config: cfg as Prisma.InputJsonValue,
      },
    }),
    prisma.whatsAppConnectionEvent.create({ data: { connectionId: conn.id, type: "LOGGED_OUT", message: "Sessão encerrada pelo usuário" } }),
  ]);
  await withRedis((r) => r.del(qrKey(ctx.householdId)), 0);
  const delivered = await publishCommand("logout", ctx.householdId);
  await publishEvent(ctx.householdId, "whatsapp.status");
  return {
    ok: true,
    commandDelivered: delivered,
    workerOnline: false,
    message: "Credenciais locais apagadas. Se necessário, remova também o aparelho em WhatsApp › Aparelhos conectados no celular.",
  };
}

export const whatsappSettingsSchema = z
  .object({
    provider: z.enum(["BAILEYS", "CLOUD_API", "SIMULATOR"]),
    processingEnabled: z.boolean(),
    /** Cloud API: phone-number-id (não secreto). */
    phoneNumberId: z
      .string()
      .trim()
      .regex(/^\d{5,30}$/, "phone-number-id inválido")
      .nullable(),
  })
  .partial();

export async function updateWhatsAppSettings(ctx: ServiceContext, input: z.infer<typeof whatsappSettingsSchema>) {
  assertCan(ctx, "integrations:manage");
  const data = whatsappSettingsSchema.parse(input);
  const conn = await ensureConnection(ctx.householdId);
  const update: Prisma.WhatsAppConnectionUpdateInput = {};
  const providerChanged = data.provider !== undefined && data.provider !== conn.provider;
  if (providerChanged) {
    if (data.provider === "SIMULATOR" && !env().WHATSAPP_ENABLE_SIMULATOR) throw new ValidationError("O simulador está desabilitado neste ambiente.");
    update.provider = data.provider;
    // Troca de provedor: desconecta o atual; a autorização de grupo precisa ser refeita.
    update.desiredConnected = false;
  }
  if (data.processingEnabled !== undefined) update.processingEnabled = data.processingEnabled;
  if (data.phoneNumberId !== undefined) {
    update.config = mergeConfig(readConfig(conn.config), { phoneNumberId: data.phoneNumberId }) as Prisma.InputJsonValue;
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (providerChanged) {
      await tx.whatsAppGroup.updateMany({ where: { connectionId: conn.id, isAuthorized: true }, data: { isAuthorized: false, authorizedAt: null, authorizedById: null } });
    }
    return tx.whatsAppConnection.update({ where: { id: conn.id }, data: update });
  });
  await audit(ctx, {
    action: "SETTINGS_CHANGE",
    entityType: "WhatsAppConnection",
    entityId: conn.id,
    before: { provider: conn.provider, processingEnabled: conn.processingEnabled, phoneNumberId: readConfig(conn.config).phoneNumberId ?? null },
    after: { provider: updated.provider, processingEnabled: updated.processingEnabled, phoneNumberId: readConfig(updated.config).phoneNumberId ?? null },
  });
  let requeued = 0;
  if (data.processingEnabled === true && !conn.processingEnabled) {
    const jobs = await queueReceivedMessages(ctx.householdId);
    for (const job of jobs) {
      const res = await enqueueInboundJob(job);
      if (res.ok) requeued++;
    }
  }
  if (providerChanged) await publishCommand("disconnect", ctx.householdId);
  await publishEvent(ctx.householdId, "whatsapp.status");
  return { provider: updated.provider, processingEnabled: updated.processingEnabled, desiredConnected: updated.desiredConnected, requeued };
}

// -----------------------------------------------------------------------------
// QR Code
// -----------------------------------------------------------------------------

export async function getQrCode(ctx: ServiceContext) {
  assertCan(ctx, "integrations:manage");
  const [qr, ttl] = await withRedis((r) => Promise.all([r.get(qrKey(ctx.householdId)), r.ttl(qrKey(ctx.householdId))]), [null, -1] as [string | null, number]);
  if (!qr) throw new NotFoundError("QR Code");
  const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 1, width: 320 });
  return { dataUrl, expiresInSeconds: ttl > 0 ? ttl : QR_TTL_SECONDS };
}

// -----------------------------------------------------------------------------
// Grupos
// -----------------------------------------------------------------------------

async function ensureSimulatorGroup(conn: { id: string; householdId: string }) {
  const members = await prisma.householdMember.count({ where: { householdId: conn.householdId, isActive: true, whatsappPhone: { not: null } } });
  await upsertSyncedGroups(conn, [{ externalId: SIMULATOR_GROUP_ID, name: SIMULATOR_GROUP_NAME, participantsCount: members, participants: [] }]);
}

export async function requestGroupSync(ctx: ServiceContext) {
  assertCan(ctx, "integrations:manage");
  const conn = await ensureConnection(ctx.householdId);
  if (!PROVIDER_CAPABILITIES[conn.provider].groups) throw new ValidationError("Este provedor não trabalha com grupos.");
  if (conn.provider === "SIMULATOR") {
    // O grupo simulado não depende do worker.
    await ensureSimulatorGroup(conn);
    await publishEvent(ctx.householdId, "whatsapp.status");
    return { ok: true, commandDelivered: true, workerOnline: (await workerStatus()).online, message: null };
  }
  const cfg = mergeConfig(readConfig(conn.config), { groupSyncRequestedAt: new Date().toISOString() });
  await prisma.whatsAppConnection.update({ where: { id: conn.id }, data: { config: cfg as Prisma.InputJsonValue } });
  return afterCommand(ctx, "sync-groups");
}

export const groupAuthorizationSchema = z.object({ authorized: z.boolean() });

/** Autoriza (ou revoga) um grupo. No máximo UM grupo autorizado por família. */
export async function setGroupAuthorization(ctx: ServiceContext, groupId: string, authorized: boolean) {
  assertCan(ctx, "integrations:manage");
  const group = await prisma.whatsAppGroup.findFirst({ where: { id: groupId, householdId: ctx.householdId }, include: { connection: { select: { provider: true } } } });
  if (!group) throw new NotFoundError("Grupo");
  if (!PROVIDER_CAPABILITIES[group.connection.provider].groups) throw new ValidationError("Este provedor não trabalha com grupos.");
  const now = new Date();
  const previous = await prisma.$transaction(async (tx) => {
    // Trava a conexão da família para serializar autorizações concorrentes.
    await tx.$queryRaw`SELECT id FROM "WhatsAppConnection" WHERE "householdId" = ${ctx.householdId} FOR UPDATE`;
    const prev = await tx.whatsAppGroup.findFirst({ where: { householdId: ctx.householdId, isAuthorized: true, id: { not: groupId } }, select: { id: true, name: true } });
    if (authorized) {
      await tx.whatsAppGroup.updateMany({
        where: { householdId: ctx.householdId, isAuthorized: true, id: { not: groupId } },
        data: { isAuthorized: false, authorizedAt: null, authorizedById: null },
      });
      await tx.whatsAppGroup.update({ where: { id: groupId }, data: { isAuthorized: true, authorizedAt: now, authorizedById: ctx.memberId } });
    } else {
      await tx.whatsAppGroup.update({ where: { id: groupId }, data: { isAuthorized: false, authorizedAt: null, authorizedById: null } });
    }
    return prev;
  });
  await audit(ctx, {
    action: "SETTINGS_CHANGE",
    entityType: "WhatsAppGroup",
    entityId: groupId,
    before: { isAuthorized: group.isAuthorized },
    after: { isAuthorized: authorized },
    metadata: { groupName: group.name, ...(authorized && previous ? { revokedGroupId: previous.id, revokedGroupName: previous.name } : {}) },
  });
  await publishEvent(ctx.householdId, "whatsapp.status");
  return { id: groupId, name: group.name, isAuthorized: authorized, revokedGroupId: authorized ? (previous?.id ?? null) : null };
}

// -----------------------------------------------------------------------------
// Mensagens
// -----------------------------------------------------------------------------

export const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(40).optional(),
  status: z.enum(["RECEIVED", "QUEUED", "PROCESSING", "PROCESSED", "IGNORED", "NEEDS_CLARIFICATION", "FAILED"]).optional(),
  direction: z.enum(["INBOUND", "OUTBOUND"]).optional(),
});

/** Últimas mensagens do chat autorizado (com status, remetente, texto e transações geradas). */
export async function listWhatsAppMessages(ctx: ServiceContext, input: z.input<typeof messagesQuerySchema>) {
  const q = messagesQuerySchema.parse(input);
  const conn = await prisma.whatsAppConnection.findUnique({ where: { householdId: ctx.householdId }, select: { id: true, provider: true } });
  if (!conn) return { items: [], nextCursor: null, scope: null };
  const group = await prisma.whatsAppGroup.findFirst({ where: { connectionId: conn.id, isAuthorized: true }, select: { id: true, name: true, externalId: true } });
  const scope = await getVisibilityScope(ctx);
  const where: Prisma.WhatsAppMessageWhereInput = {
    householdId: ctx.householdId,
    connectionId: conn.id,
    ...(conn.provider !== "CLOUD_API" && group ? { OR: [{ groupId: group.id }, { chatId: group.externalId }] } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.direction ? { direction: q.direction } : {}),
  };
  const rows = await prisma.whatsAppMessage.findMany({
    where,
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    include: {
      sender: { select: { id: true, displayName: true, color: true } },
      attachment: { select: { id: true, kind: true, mimeType: true, sizeBytes: true, contentDeletedAt: true, transactionId: true } },
      jobs: { select: { status: true, attempts: true, maxAttempts: true, lastError: true, runAfter: true, finishedAt: true } },
      transactions: {
        where: visibleTransactionWhere(scope),
        orderBy: { sourceIndex: "asc" },
        select: { id: true, type: true, status: true, amountCents: true, description: true, date: true, deletedAt: true, sourceIndex: true },
      },
    },
  });
  const items = rows.slice(0, q.limit).map((m) => ({
    id: m.id,
    direction: m.direction,
    type: m.type,
    status: m.status,
    intent: m.intent,
    statusDetail: m.statusDetail,
    text: m.text,
    sentAt: m.sentAt,
    processedAt: m.processedAt,
    quotedExternalId: m.quotedExternalId,
    isBot: m.direction === "OUTBOUND",
    sender: m.sender,
    attachment: m.attachment
      ? { id: m.attachment.id, kind: m.attachment.kind, mimeType: m.attachment.mimeType, sizeBytes: m.attachment.sizeBytes, contentDeleted: Boolean(m.attachment.contentDeletedAt) }
      : null,
    job: m.jobs[0] ?? null,
    transactions: m.transactions.map((t) => ({ ...t, date: dateToISO(t.date), deleted: Boolean(t.deletedAt) })),
  }));
  return {
    items,
    nextCursor: rows.length > q.limit ? (rows[q.limit]?.id ?? null) : null,
    scope: group ? { groupId: group.id, groupName: group.name } : null,
  };
}

// -----------------------------------------------------------------------------
// Simulação (somente provedor SIMULATOR + WHATSAPP_ENABLE_SIMULATOR)
// -----------------------------------------------------------------------------

const base64 = z
  .string()
  .max(Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 1024)
  .regex(/^[A-Za-z0-9+/=\s]+$/, "Conteúdo base64 inválido");

export const simulateSchema = z
  .object({
    memberId: z.string().min(1).max(40),
    text: z.string().max(4000).optional(),
    audioBase64: base64.optional(),
    imageBase64: base64.optional(),
    documentBase64: base64.optional(),
    mimeType: z
      .string()
      .max(100)
      .regex(/^[a-z]+\/[a-zA-Z0-9.+-]+(;.*)?$/, "mimeType inválido")
      .optional(),
    fileName: z.string().max(200).optional(),
    quotedExternalId: z.string().max(200).optional(),
  })
  .refine((v) => Boolean(v.text?.trim() || v.audioBase64 || v.imageBase64 || v.documentBase64), { message: "Informe um texto ou um arquivo." })
  .refine((v) => [v.audioBase64, v.imageBase64, v.documentBase64].filter(Boolean).length <= 1, { message: "Envie apenas um arquivo por mensagem." });

const SKIP_LABELS: Record<IngestSkipReason, string> = {
  connection_not_found: "Conexão não encontrada.",
  chat_not_authorized: "O grupo do simulador não está autorizado. Sincronize os grupos e autorize-o.",
  bot_message: "Mensagem do próprio bot — ignorada.",
  sender_unknown: "O remetente não corresponde a nenhum membro com WhatsApp cadastrado.",
  sender_not_authorized: "O membro não está autorizado a usar o WhatsApp.",
  sender_without_consent: "O membro ainda não deu consentimento para o processamento das suas mensagens.",
};

export async function simulateInbound(ctx: ServiceContext, input: z.input<typeof simulateSchema>) {
  assertCan(ctx, "integrations:manage");
  if (!env().WHATSAPP_ENABLE_SIMULATOR) throw new AppError("O simulador está desabilitado neste ambiente.", { status: 403, code: "SIMULATOR_DISABLED" });
  const data = simulateSchema.parse(input);
  const conn = await ensureConnection(ctx.householdId);
  if (conn.provider !== "SIMULATOR") throw new ValidationError("A simulação só está disponível com o provedor Simulador.");
  const member = await prisma.householdMember.findFirst({ where: { id: data.memberId, householdId: ctx.householdId }, select: { id: true, whatsappPhone: true } });
  if (!member) throw new NotFoundError("Membro");
  if (!member.whatsappPhone) throw new ValidationError("Cadastre o número de WhatsApp do membro para simular mensagens dele.");

  const b64 = data.audioBase64 ?? data.imageBase64 ?? data.documentBase64;
  let media: { buffer: Buffer; mimeType: string; fileName?: string | null } | null = null;
  if (b64) {
    const fallback = data.audioBase64 ? "audio/ogg" : data.imageBase64 ? "image/jpeg" : "application/pdf";
    const mimeType = data.mimeType ?? fallback;
    const kindOk = data.audioBase64 ? mimeType.startsWith("audio/") : data.imageBase64 ? mimeType.startsWith("image/") : true;
    if (!kindOk) throw new ValidationError("O mimeType não corresponde ao tipo do arquivo.");
    const buffer = Buffer.from(b64.replace(/\s/g, ""), "base64");
    if (!buffer.length) throw new ValidationError("Arquivo vazio.");
    if (buffer.length > MAX_MEDIA_BYTES) throw new ValidationError("Arquivo acima do limite de 16 MB.");
    media = { buffer, mimeType, fileName: data.fileName ?? null };
  }

  const existingGroup = await prisma.whatsAppGroup.findUnique({ where: { connectionId_externalId: { connectionId: conn.id, externalId: SIMULATOR_GROUP_ID } } });
  if (!existingGroup) await ensureSimulatorGroup(conn);

  const msg = buildSimulatedMessage({ phone: member.whatsappPhone, text: data.text ?? null, media, quotedExternalId: data.quotedExternalId ?? null });
  const result = await ingestMessage({ id: conn.id, householdId: ctx.householdId }, msg);

  let mode: "worker" | "inline" | null = null;
  let outcome: ProcessOutcome | null = null;
  if (result.accepted && !result.duplicate && result.jobId) {
    const worker = await workerStatus();
    if (worker.online) mode = "worker";
    else {
      // Sem worker: processa em linha pelo MESMO processador; respostas registradas como mensagens simuladas.
      mode = "inline";
      outcome = await runProcessingJob(result.jobId, { inlineSimulator: true });
    }
  }
  return {
    notice: SIMULATOR_NOTICE,
    accepted: result.accepted,
    reason: result.reason ?? null,
    reasonLabel: result.reason ? SKIP_LABELS[result.reason] : null,
    messageId: result.messageId ?? null,
    externalId: result.accepted ? msg.externalId : null,
    status: result.status ?? null,
    mode,
    outcome,
  };
}
