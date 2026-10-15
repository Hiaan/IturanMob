import type { Redis } from "ioredis";
import type { Prisma, WhatsAppConnection, WhatsAppConnectionStatus, WhatsAppProviderType } from "@prisma/client";
import { prisma } from "../db";
import { redis, newRedisConnection } from "../redis";
import { publishEvent } from "../events";
import { errorInfo, logger } from "../logger";
import { notify } from "../modules/notifications/service";
import { parseCommand } from "./commands";
import { patchConnectionConfig, readConfig } from "./config";
import { upsertSyncedGroups } from "./groups";
import { ingestMessage } from "./ingest";
import { QR_TTL_SECONDS, qrKey, WA_COMMANDS_CHANNEL } from "./keys";
import type { ProviderRegistry } from "./outbound-consumer";
import { normalizeE164 } from "./phone";
import { createProvider } from "./providers";
import type { NormalizedInboundMessage, OnMessageResult, ProviderGroup, ProviderStatusUpdate, WhatsAppProvider } from "./types";

/**
 * GERENCIADOR DE CONEXÕES (roda no worker).
 *
 * Para cada WhatsAppConnection, converge o provedor em execução para `desiredConnected`.
 * Gatilhos: comandos via Redis pub/sub (fa:wa:commands) e verificação periódica do banco (~10 s),
 * que funciona mesmo sem Redis. Registra status, eventos (histórico de erros), QR no Redis com TTL,
 * sincroniza grupos e notifica falhas persistentes. O dashboard nunca depende desta integração.
 */

const RECONCILE_INTERVAL_MS = 10_000;
const FAILURES_BEFORE_NOTIFY = 5;
const ACTIVE_STATUSES: WhatsAppConnectionStatus[] = ["CONNECTED", "CONNECTING", "QR_PENDING"];

interface Running {
  householdId: string;
  connectionId: string;
  type: WhatsAppProviderType;
  provider: WhatsAppProvider | null;
  lastStatus: WhatsAppConnectionStatus;
  failures: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clip(text: string | null | undefined, max = 300): string | null {
  return text ? text.slice(0, max) : null;
}

export class ConnectionManager implements ProviderRegistry {
  private readonly running = new Map<string, Running>();
  private readonly startBackoff = new Map<string, { failures: number; nextAt: number }>();
  private readonly chains = new Map<string, Promise<void>>();
  private sub: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private reconciling = false;

  constructor(private readonly opts: { reconcileIntervalMs?: number; subscribe?: boolean } = {}) {}

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.resetStaleStatuses();
    if (this.opts.subscribe !== false) await this.subscribe();
    await this.reconcileAll();
    this.timer = setInterval(() => void this.reconcileAll(), this.opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
    logger.info("whatsapp: gerenciador de conexões iniciado");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.sub) {
      const sub = this.sub;
      this.sub = null;
      try {
        await sub.quit();
      } catch {
        sub.disconnect();
      }
    }
    await Promise.allSettled([...this.chains.values()]);
    for (const run of [...this.running.values()]) {
      await this.stopRunning(run, "Worker encerrado");
    }
    logger.info("whatsapp: gerenciador de conexões encerrado");
  }

  /** Provedor em execução da família (para o consumidor de envio). */
  getProvider(householdId: string): WhatsAppProvider | null {
    return this.running.get(householdId)?.provider ?? null;
  }

  private async subscribe() {
    const sub = newRedisConnection("wa-commands");
    this.sub = sub;
    sub.on("message", (channel: string, raw: string) => {
      if (channel !== WA_COMMANDS_CHANNEL) return;
      const cmd = parseCommand(raw);
      if (!cmd) return;
      logger.debug({ type: cmd.type }, "whatsapp: comando recebido");
      void this.reconcile(cmd.householdId);
    });
    try {
      await Promise.race([sub.subscribe(WA_COMMANDS_CHANNEL), sleep(3000).then(() => Promise.reject(new Error("timeout")))]);
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: pub/sub indisponível — usando apenas a verificação periódica do banco");
    }
  }

  /** Após reinício do worker, nenhuma conexão está realmente ativa. */
  private async resetStaleStatuses() {
    const now = new Date();
    await prisma.whatsAppConnection.updateMany({ where: { status: "CONNECTED" }, data: { status: "DISCONNECTED", lastDisconnectedAt: now } });
    await prisma.whatsAppConnection.updateMany({ where: { status: { in: ["CONNECTING", "QR_PENDING"] } }, data: { status: "DISCONNECTED" } });
  }

  private serialize(householdId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(householdId) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch((err) => {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao convergir conexão");
    });
    this.chains.set(householdId, next);
    void next.then(() => {
      if (this.chains.get(householdId) === next) this.chains.delete(householdId);
    });
    return next;
  }

  async reconcileAll(): Promise<void> {
    if (this.reconciling || this.stopping) return;
    this.reconciling = true;
    try {
      const conns = await prisma.whatsAppConnection.findMany({ select: { householdId: true } });
      const ids = new Set(conns.map((c) => c.householdId));
      for (const hh of this.running.keys()) ids.add(hh);
      for (const hh of ids) await this.reconcile(hh);
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao verificar conexões (banco indisponível?)");
    } finally {
      this.reconciling = false;
    }
  }

  /** Converge uma família (serializado por família). */
  reconcile(householdId: string): Promise<void> {
    return this.serialize(householdId, () => this.doReconcile(householdId));
  }

  private async doReconcile(householdId: string): Promise<void> {
    if (this.stopping) return;
    const conn = await prisma.whatsAppConnection.findUnique({ where: { householdId } });
    let run = this.running.get(householdId);
    if (!conn) {
      if (run) {
        this.running.delete(householdId);
        await run.provider?.stop().catch(() => undefined);
      }
      return;
    }
    const cfg = readConfig(conn.config);

    if (cfg.logoutRequestedAt) {
      await this.doLogout(conn, run, cfg.logoutRequestedAt);
      // Se o usuário pediu para conectar de novo depois do logout, segue com uma sessão nova.
      const after = await prisma.whatsAppConnection.findUnique({ where: { householdId }, select: { desiredConnected: true, config: true } });
      if (after?.desiredConnected && !readConfig(after.config).logoutRequestedAt) await this.doReconcile(householdId);
      return;
    }
    if (run && run.type !== conn.provider) {
      await this.stopRunning(run, "Provedor alterado");
      run = undefined;
    }
    if (!conn.desiredConnected) {
      if (run) await this.stopRunning(run, "Desconectado pelo usuário");
      else if (ACTIVE_STATUSES.includes(conn.status)) {
        await prisma.whatsAppConnection.update({ where: { id: conn.id }, data: { status: "DISCONNECTED" } });
        await publishEvent(householdId, "whatsapp.status");
      }
      return;
    }
    if (cfg.reconnectRequestedAt) {
      if (run) await this.stopRunning(run, "Reconexão solicitada");
      run = undefined;
      this.startBackoff.delete(householdId);
      await patchConnectionConfig(conn.id, { reconnectRequestedAt: null }, { reconnectRequestedAt: cfg.reconnectRequestedAt });
    }
    if (!run) {
      const bo = this.startBackoff.get(householdId);
      if (bo && Date.now() < bo.nextAt) return;
      run = await this.startProvider(conn);
      if (!run) return;
    }
    if (cfg.groupSyncRequestedAt) {
      if (!run.provider?.capabilities.groups) {
        await patchConnectionConfig(conn.id, { groupSyncRequestedAt: null });
      } else if (run.provider.isConnected()) {
        await this.syncGroups(run);
        await patchConnectionConfig(conn.id, { groupSyncRequestedAt: null }, { groupSyncRequestedAt: cfg.groupSyncRequestedAt });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Início / parada / logout
  // ---------------------------------------------------------------------------

  private isCurrent(run: Running): boolean {
    return this.running.get(run.householdId) === run;
  }

  private async startProvider(conn: WhatsAppConnection): Promise<Running | undefined> {
    const run: Running = {
      householdId: conn.householdId,
      connectionId: conn.id,
      type: conn.provider,
      provider: null,
      lastStatus: conn.status,
      failures: 0,
    };
    this.running.set(conn.householdId, run);
    try {
      run.provider = await createProvider(conn, {
        onQr: (qr) => this.handleQr(run, qr),
        onStatus: (u) => this.handleStatus(run, u),
        onMessage: (m) => this.handleMessage(run, m),
        onGroups: (g) => this.handleGroups(run, g),
      });
      await run.provider.start();
      this.startBackoff.delete(conn.householdId);
      return run;
    } catch (err) {
      if (this.isCurrent(run)) this.running.delete(conn.householdId);
      await run.provider?.stop().catch(() => undefined);
      const message = clip(errorInfo(err).message) ?? "Falha ao iniciar a conexão";
      const bo = this.startBackoff.get(conn.householdId) ?? { failures: 0, nextAt: 0 };
      bo.failures++;
      bo.nextAt = Date.now() + Math.min(10_000 * 2 ** (bo.failures - 1), 5 * 60_000);
      this.startBackoff.set(conn.householdId, bo);
      run.failures = bo.failures - 1;
      await this.recordStatus(run, { status: "ERROR", error: message });
      logger.warn({ householdId: conn.householdId, provider: conn.provider, failures: bo.failures }, "whatsapp: falha ao iniciar provedor");
      return undefined;
    }
  }

  private async stopRunning(run: Running, reason: string) {
    if (this.isCurrent(run)) this.running.delete(run.householdId);
    try {
      await run.provider?.stop();
    } catch (err) {
      logger.debug({ err: errorInfo(err).message }, "whatsapp: erro ao parar provedor");
    }
    try {
      await this.recordStatus(run, { status: "DISCONNECTED", error: reason });
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao registrar desconexão");
    }
  }

  private async doLogout(conn: WhatsAppConnection, run: Running | undefined, requestedAt: string) {
    if (run) {
      if (this.isCurrent(run)) this.running.delete(conn.householdId);
      try {
        await run.provider?.logout();
      } catch (err) {
        logger.debug({ err: errorInfo(err).message }, "whatsapp: erro no logout do provedor");
      }
    }
    // As credenciais locais são apagadas em qualquer caso.
    await prisma.whatsAppAuthState.deleteMany({ where: { connectionId: conn.id } });
    await patchConnectionConfig(conn.id, { logoutRequestedAt: null, reconnectRequestedAt: null }, { logoutRequestedAt: requestedAt });
    // Se a API já registrou o logout (worker estava offline) e não havia sessão ativa, não duplica o evento.
    if (run || conn.status !== "LOGGED_OUT") {
      await prisma.$transaction([
        prisma.whatsAppConnection.update({
          where: { id: conn.id },
          data: { status: "LOGGED_OUT", phoneNumber: null, displayName: null, lastDisconnectedAt: new Date() },
        }),
        prisma.whatsAppConnectionEvent.create({ data: { connectionId: conn.id, type: "LOGGED_OUT", message: "Sessão encerrada pelo usuário" } }),
      ]);
    }
    await this.clearQr(conn.householdId);
    this.startBackoff.delete(conn.householdId);
    await publishEvent(conn.householdId, "whatsapp.status");
    logger.info({ householdId: conn.householdId }, "whatsapp: sessão encerrada (logout)");
  }

  // ---------------------------------------------------------------------------
  // Callbacks do provedor
  // ---------------------------------------------------------------------------

  private async clearQr(householdId: string) {
    try {
      await redis().del(qrKey(householdId));
    } catch {
      // TTL curto: expira sozinho
    }
  }

  private async handleQr(run: Running, qr: string) {
    if (!this.isCurrent(run)) return;
    try {
      await redis().set(qrKey(run.householdId), qr, "EX", QR_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: QR Code não armazenado (Redis indisponível)");
    }
    if (run.lastStatus !== "QR_PENDING") await this.recordStatus(run, { status: "QR_PENDING" });
    else await publishEvent(run.householdId, "whatsapp.status");
  }

  private async handleStatus(run: Running, update: ProviderStatusUpdate) {
    if (!this.isCurrent(run)) return;
    await this.recordStatus(run, update);
  }

  private async handleMessage(run: Running, msg: NormalizedInboundMessage): Promise<OnMessageResult> {
    if (!this.isCurrent(run)) return { accepted: false };
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await ingestMessage({ id: run.connectionId, householdId: run.householdId }, msg);
        return { accepted: res.accepted };
      } catch (err) {
        if (attempt >= 3) {
          logger.error({ householdId: run.householdId, err: errorInfo(err).message }, "whatsapp: falha ao registrar mensagem recebida");
          await prisma.whatsAppConnectionEvent
            .create({ data: { connectionId: run.connectionId, type: "ERROR", message: "Falha ao registrar uma mensagem recebida (banco indisponível?)" } })
            .catch(() => undefined);
          return { accepted: false };
        }
        await sleep(1000 * 3 ** (attempt - 1));
      }
    }
  }

  private async handleGroups(run: Running, groups: ProviderGroup[]) {
    if (!this.isCurrent(run)) return;
    try {
      await upsertSyncedGroups({ id: run.connectionId, householdId: run.householdId }, groups);
      await publishEvent(run.householdId, "whatsapp.status");
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao sincronizar grupos");
    }
  }

  private async syncGroups(run: Running) {
    if (!run.provider?.capabilities.groups || !run.provider.isConnected()) return;
    try {
      const groups = await run.provider.listGroups();
      await upsertSyncedGroups({ id: run.connectionId, householdId: run.householdId }, groups);
      await publishEvent(run.householdId, "whatsapp.status");
      logger.info({ householdId: run.householdId, groups: groups.length }, "whatsapp: grupos sincronizados");
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao listar grupos");
    }
  }

  private async afterConnected(run: Running) {
    await this.syncGroups(run);
    try {
      const conn = await prisma.whatsAppConnection.findUnique({ where: { id: run.connectionId }, select: { config: true } });
      const requested = readConfig(conn?.config).groupSyncRequestedAt;
      if (requested) await patchConnectionConfig(run.connectionId, { groupSyncRequestedAt: null }, { groupSyncRequestedAt: requested });
    } catch {
      // o pedido será tratado na próxima verificação
    }
  }

  /** Grava status/eventos, publica tempo real e trata falhas persistentes. */
  private async recordStatus(run: Running, update: ProviderStatusUpdate) {
    const prev = run.lastStatus;
    run.lastStatus = update.status;
    const now = new Date();
    const data: Prisma.WhatsAppConnectionUpdateInput = { status: update.status };
    const events: Array<{ type: string; message: string | null }> = [];
    const error = clip(update.error);

    switch (update.status) {
      case "CONNECTED":
        data.lastConnectedAt = now;
        if (update.phoneNumber !== undefined) data.phoneNumber = normalizeE164(update.phoneNumber);
        if (update.displayName !== undefined) data.displayName = clip(update.displayName, 120);
        events.push({ type: "CONNECTED", message: "Conectado" });
        run.failures = 0;
        break;
      case "QR_PENDING":
        if (prev !== "QR_PENDING") events.push({ type: "QR", message: "QR Code gerado — aguardando leitura no celular" });
        break;
      case "ERROR":
        data.lastError = error ?? "Erro na conexão";
        data.lastErrorAt = now;
        events.push({ type: "ERROR", message: (data.lastError as string) ?? null });
        break;
      case "LOGGED_OUT":
        data.lastError = error ?? "Sessão encerrada";
        data.lastErrorAt = now;
        data.desiredConnected = false;
        data.lastDisconnectedAt = now;
        events.push({ type: "LOGGED_OUT", message: error ?? "Sessão encerrada" });
        break;
      case "DISCONNECTED":
        if (prev !== "DISCONNECTED") events.push({ type: "DISCONNECTED", message: error ?? "Desconectado" });
        break;
      case "CONNECTING":
        break;
    }
    if (prev === "CONNECTED" && update.status !== "CONNECTED") {
      data.lastDisconnectedAt = now;
      if (update.status !== "DISCONNECTED" && update.status !== "LOGGED_OUT") events.unshift({ type: "DISCONNECTED", message: error ?? "Conexão perdida" });
    }
    if (update.terminal) {
      // Estado terminal (ex.: sessão substituída, QR expirado): não reconecta sozinho.
      data.desiredConnected = false;
      if (this.isCurrent(run)) {
        this.running.delete(run.householdId);
        void run.provider?.stop().catch(() => undefined);
      }
    }

    await prisma.$transaction([
      prisma.whatsAppConnection.update({ where: { id: run.connectionId }, data }),
      ...(events.length ? [prisma.whatsAppConnectionEvent.createMany({ data: events.map((e) => ({ connectionId: run.connectionId, ...e })) })] : []),
    ]);
    if (update.status !== "QR_PENDING") await this.clearQr(run.householdId);
    await publishEvent(run.householdId, "whatsapp.status");
    logger.info({ householdId: run.householdId, status: update.status, attempt: update.attempt }, "whatsapp: status da conexão");

    if (update.status === "ERROR" || update.status === "LOGGED_OUT") {
      run.failures++;
      if (update.status === "LOGGED_OUT" || update.terminal || run.failures >= FAILURES_BEFORE_NOTIFY) {
        await this.notifyFailure(run.householdId, update.status, error);
      }
    }
    if (update.status === "CONNECTED" && this.isCurrent(run)) void this.afterConnected(run);
  }

  private async notifyFailure(householdId: string, status: WhatsAppConnectionStatus, error: string | null) {
    const day = new Date().toISOString().slice(0, 10);
    const loggedOut = status === "LOGGED_OUT";
    try {
      await notify({
        householdId,
        type: "WHATSAPP_CONNECTION_FAILED",
        title: loggedOut ? "Sessão do WhatsApp encerrada" : "Falha na conexão do WhatsApp",
        body: loggedOut
          ? "A sessão do WhatsApp foi encerrada. As novas mensagens do grupo não estão sendo recebidas. Conecte novamente em Configurações › WhatsApp. O restante do sistema continua funcionando normalmente."
          : "A conexão com o WhatsApp está falhando repetidamente. As novas mensagens do grupo não estão sendo recebidas. Verifique a integração em Configurações › WhatsApp. O restante do sistema continua funcionando normalmente.",
        data: { status, error },
        dedupeKey: `whatsapp-failed:${householdId}:${status}:${day}`,
      });
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao notificar problema de conexão");
    }
  }
}

let singleton: ConnectionManager | null = null;

/** Instância única do gerenciador (somente no worker). */
export function getConnectionManager(): ConnectionManager {
  if (!singleton) singleton = new ConnectionManager();
  return singleton;
}
