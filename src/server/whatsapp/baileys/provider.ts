import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
  toNumber,
  type GroupMetadata,
  type MessageUpsertType,
  type SocketConfig,
  type proto,
  type WAMessage,
  type WASocket,
} from "baileys";
import { errorInfo, logger } from "../../logger";
import { isLidJid, isPnJid, normalizeJid, phoneFromJid } from "../phone";
import {
  PROVIDER_CAPABILITIES,
  type InboundMessageType,
  type NormalizedInboundMessage,
  type ProviderCallbacks,
  type ProviderGroup,
  type ProviderGroupParticipant,
  type SendTextOptions,
  type WhatsAppProvider,
} from "../types";
import { useDatabaseAuthState } from "./auth-state";

type ILogger = SocketConfig["logger"];

/**
 * Provedor Baileys (WhatsApp Web, NÃO OFICIAL). Conexão por QR Code; credenciais criptografadas no
 * PostgreSQL; reconexão com backoff exponencial; logout limpa as credenciais.
 *
 * Política de uso responsável: identifica-se como "Finance AI" na lista de aparelhos conectados,
 * não altera presença (online), não baixa histórico, não faz envio em massa nem mensagens a terceiros
 * — o envio é feito apenas pelo consumidor da fila, que direciona SEMPRE ao grupo autorizado.
 */

const MAX_BACKOFF_MS = 5 * 60_000;
/** Quantidade de QR Codes exibidos sem leitura antes de desistir (~3 ciclos de conexão). */
const MAX_UNSCANNED_QR_CODES = 15;
const CACHE_SIZE = 200;

/** Logger para o Baileys que nunca repassa objetos (podem conter conteúdo de mensagens). */
function makeBaileysLogger(): ILogger {
  const base = logger.child({ module: "baileys" });
  const errOf = (obj: unknown): Record<string, unknown> => {
    const e = obj instanceof Error ? obj : (obj as { err?: unknown; error?: unknown } | null)?.err ?? (obj as { error?: unknown } | null)?.error;
    return e instanceof Error ? { err: e.message.slice(0, 200) } : {};
  };
  const text = (obj: unknown, msg?: string) => (typeof msg === "string" ? msg : typeof obj === "string" ? obj : "evento").slice(0, 200);
  const l: ILogger = {
    level: "warn",
    child: () => l,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (obj, msg) => base.debug(errOf(obj), `baileys: ${text(obj, msg)}`),
    error: (obj, msg) => base.warn(errOf(obj), `baileys: ${text(obj, msg)}`),
  };
  return l;
}

class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  clear() {
    this.map.clear();
  }
}

function statusCodeOf(error: unknown): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

const IGNORED_CONTENT = new Set([
  "protocolMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "keepInChatMessage",
  "pinInChatMessage",
  "pollUpdateMessage",
  "encReactionMessage",
  "callLogMesssage",
]);

function mapType(ctype: string): InboundMessageType {
  switch (ctype) {
    case "conversation":
    case "extendedTextMessage":
      return "TEXT";
    case "audioMessage":
      return "AUDIO";
    case "imageMessage":
      return "IMAGE";
    case "documentMessage":
      return "DOCUMENT";
    case "videoMessage":
    case "ptvMessage":
      return "VIDEO";
    case "stickerMessage":
      return "STICKER";
    case "reactionMessage":
      return "REACTION";
    default:
      return "OTHER";
  }
}

export class BaileysProvider implements WhatsAppProvider {
  readonly type = "BAILEYS" as const;
  readonly capabilities = PROVIDER_CAPABILITIES.BAILEYS;

  private sock: WASocket | null = null;
  private generation = 0;
  private stopped = true;
  private connected = false;
  private attempt = 0;
  private qrCycles = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private groupsTimer: NodeJS.Timeout | null = null;
  private clearCreds: (() => Promise<void>) | null = null;
  private hasCreds = false;
  private readonly blog = makeBaileysLogger();
  /** Mensagens ACEITAS recentes (somente do chat autorizado), para citar na resposta. Apenas em memória. */
  private readonly quoteCache = new Lru<WAMessage>(CACHE_SIZE);
  /** Conteúdo das mensagens enviadas (necessário para reenvio a pedido do WhatsApp). */
  private readonly sentCache = new Lru<proto.IMessage>(CACHE_SIZE);

  constructor(private readonly opts: { connectionId: string; callbacks: ProviderCallbacks }) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.attempt = 0;
    this.qrCycles = 0;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    const auth = await useDatabaseAuthState(this.opts.connectionId);
    this.clearCreds = auth.clear;
    this.hasCreds = Boolean(auth.state.creds.me);
    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(5000) });
      version = latest.version;
    } catch {
      version = undefined;
    }
    if (this.stopped || gen !== this.generation) return;
    // Nas reconexões o status já foi informado por scheduleReconnect (mantém o ERROR visível).
    if (this.attempt === 0) await this.opts.callbacks.onStatus({ status: "CONNECTING" });

    const sock = makeWASocket({
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, this.blog) },
      logger: this.blog,
      browser: Browsers.ubuntu("Finance AI"),
      ...(version ? { version } : {}),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid: string) => Boolean(isJidBroadcast(jid) || isJidNewsletter(jid)),
      getMessage: async (key) => (key.id ? this.sentCache.get(key.id) : undefined),
    });
    this.sock = sock;

    sock.ev.on("creds.update", () => {
      if (gen !== this.generation) return;
      void auth.saveCreds().catch((err) => logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao salvar credenciais"));
    });
    sock.ev.on("connection.update", (update) => {
      if (gen !== this.generation) return;
      void this.onConnectionUpdate(sock, update).catch((err) => logger.warn({ err: errorInfo(err).message }, "whatsapp: erro ao tratar atualização de conexão"));
    });
    sock.ev.on("messages.upsert", (event) => {
      if (gen !== this.generation) return;
      void this.onUpsert(sock, event).catch((err) => logger.warn({ err: errorInfo(err).message }, "whatsapp: erro ao tratar mensagens"));
    });
    const scheduleGroups = () => {
      if (gen !== this.generation) return;
      if (this.groupsTimer) clearTimeout(this.groupsTimer);
      this.groupsTimer = setTimeout(() => {
        this.groupsTimer = null;
        if (!this.connected || gen !== this.generation) return;
        void this.listGroups()
          .then((groups) => this.opts.callbacks.onGroups(groups))
          .catch((err) => logger.debug({ err: errorInfo(err).message }, "whatsapp: falha ao atualizar grupos"));
      }, 3000);
    };
    sock.ev.on("groups.upsert", scheduleGroups);
    sock.ev.on("groups.update", scheduleGroups);
    sock.ev.on("group-participants.update", scheduleGroups);
  }

  private async onConnectionUpdate(
    sock: WASocket,
    update: Partial<{ connection: "open" | "connecting" | "close"; qr: string; lastDisconnect: { error: Error | undefined; date: Date } }>,
  ) {
    if (update.qr) {
      this.qrCycles++;
      await this.opts.callbacks.onQr(update.qr);
    }
    if (update.connection === "open") {
      this.connected = true;
      this.attempt = 0;
      this.qrCycles = 0;
      this.hasCreds = true;
      const me = sock.user;
      await this.opts.callbacks.onStatus({
        status: "CONNECTED",
        phoneNumber: phoneFromJid(me?.id ?? null) ?? phoneFromJid(me?.phoneNumber ?? null),
        displayName: me?.name ?? me?.notify ?? me?.verifiedName ?? null,
      });
      return;
    }
    if (update.connection !== "close") return;

    this.connected = false;
    if (this.stopped) return;
    const code = statusCodeOf(update.lastDisconnect?.error);
    const reason = (update.lastDisconnect?.error?.message ?? "Conexão encerrada").slice(0, 200);

    if (code === DisconnectReason.loggedOut || code === DisconnectReason.multideviceMismatch) {
      this.stopped = true;
      this.generation++;
      await this.clearCreds?.().catch(() => undefined);
      await this.opts.callbacks.onStatus({
        status: "LOGGED_OUT",
        error: "A sessão foi encerrada no celular (aparelho desconectado). Leia o QR Code novamente para reconectar.",
        terminal: true,
      });
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.stopped = true;
      this.generation++;
      await this.opts.callbacks.onStatus({
        status: "ERROR",
        error: "A sessão foi aberta em outro lugar (conexão substituída). Reconecte manualmente.",
        terminal: true,
      });
      return;
    }
    if (code === DisconnectReason.forbidden) {
      this.stopped = true;
      this.generation++;
      await this.opts.callbacks.onStatus({ status: "ERROR", error: "O WhatsApp recusou a conexão (403). Verifique o número.", terminal: true });
      return;
    }
    if (!this.hasCreds && this.qrCycles >= MAX_UNSCANNED_QR_CODES) {
      // QR Codes expiraram sem leitura: não fica gerando QR indefinidamente.
      this.stopped = true;
      this.generation++;
      await this.opts.callbacks.onStatus({
        status: "DISCONNECTED",
        error: "O QR Code expirou sem leitura. Clique em Conectar para gerar um novo.",
        terminal: true,
      });
      return;
    }
    const immediate = code === DisconnectReason.restartRequired;
    this.scheduleReconnect(immediate ? "Reinício solicitado pelo WhatsApp" : `${reason}${code ? ` (código ${code})` : ""}`, immediate);
  }

  private scheduleReconnect(reason: string, immediate: boolean) {
    if (this.stopped) return;
    if (!immediate) this.attempt++;
    const delay = immediate ? 500 : Math.min(2000 * 2 ** Math.max(0, this.attempt - 1), MAX_BACKOFF_MS);
    if (!immediate) {
      void this.opts.callbacks.onStatus({
        status: this.attempt >= 2 ? "ERROR" : "CONNECTING",
        error: `Conexão perdida: ${reason}. Nova tentativa em ${Math.round(delay / 1000)} s.`,
        attempt: this.attempt,
      });
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err) => this.scheduleReconnect(errorInfo(err).message, false));
    }, delay);
  }

  private async resolveSender(sock: WASocket, ids: Array<string | null | undefined>): Promise<{ jid: string | null; lid: string | null }> {
    let jid: string | null = null;
    let lid: string | null = null;
    for (const raw of ids) {
      const n = normalizeJid(raw);
      if (!n) continue;
      if (!lid && isLidJid(n)) lid = n;
      else if (!jid && isPnJid(n)) jid = n;
    }
    if (lid && !jid) {
      try {
        jid = normalizeJid(await sock.signalRepository.lidMapping.getPNForLID(lid));
      } catch {
        jid = null;
      }
    }
    return { jid, lid };
  }

  private async normalize(sock: WASocket, msg: WAMessage): Promise<NormalizedInboundMessage | null> {
    const key = msg.key;
    const remoteJid = key.remoteJid;
    if (!remoteJid || !key.id) return null;
    if (isJidStatusBroadcast(remoteJid) || isJidBroadcast(remoteJid) || isJidNewsletter(remoteJid)) return null;
    if (msg.messageStubType) return null;
    const content = normalizeMessageContent(msg.message);
    if (!content) return null;
    const ctype = getContentType(content);
    if (!ctype || IGNORED_CONTENT.has(ctype)) return null;
    const type = mapType(ctype);
    const isGroup = Boolean(isJidGroup(remoteJid));
    const sender = await this.resolveSender(sock, isGroup ? [key.participant, key.participantAlt] : [remoteJid, key.remoteJidAlt]);
    const inner = content[ctype] as { contextInfo?: proto.IContextInfo | null; caption?: string | null } | string | null | undefined;
    const contextInfo = inner && typeof inner === "object" ? inner.contextInfo : undefined;

    let text: string | null = null;
    let caption: string | null = null;
    if (ctype === "conversation") text = content.conversation ?? null;
    else if (ctype === "extendedTextMessage") text = content.extendedTextMessage?.text ?? null;
    else if (inner && typeof inner === "object") caption = inner.caption ?? null;

    let media: NormalizedInboundMessage["media"] = null;
    const mediaContent =
      type === "AUDIO" ? content.audioMessage : type === "IMAGE" ? content.imageMessage : type === "DOCUMENT" ? content.documentMessage : null;
    if (mediaContent) {
      const fileName = type === "DOCUMENT" ? (content.documentMessage?.fileName ?? null) : null;
      media = {
        mimeType: mediaContent.mimetype ?? "application/octet-stream",
        sizeBytes: mediaContent.fileLength ? toNumber(mediaContent.fileLength) : null,
        fileName,
        download: async (maxBytes: number) => {
          const stream = await downloadMediaMessage(msg, "stream", {}, { logger: this.blog, reuploadRequest: sock.updateMediaMessage });
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            total += chunk.length;
            if (total > maxBytes) {
              stream.destroy();
              throw new Error("Arquivo acima do limite de 16 MB");
            }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        },
      };
    }
    const ts = msg.messageTimestamp ? toNumber(msg.messageTimestamp) : 0;
    return {
      externalId: key.id,
      chatId: remoteJid,
      isGroup,
      senderIds: { jid: sender.jid, lid: sender.lid, phone: phoneFromJid(sender.jid) },
      fromMe: Boolean(key.fromMe),
      sentAt: ts > 0 ? new Date(ts * 1000) : new Date(),
      type,
      text,
      caption,
      quotedExternalId: contextInfo?.stanzaId ?? null,
      media,
    };
  }

  private async onUpsert(sock: WASocket, event: { messages: WAMessage[]; type: MessageUpsertType }) {
    // "notify" = tempo real; "append" = mensagens recebidas enquanto o worker estava offline.
    for (const msg of event.messages) {
      let normalized: NormalizedInboundMessage | null = null;
      try {
        normalized = await this.normalize(sock, msg);
      } catch (err) {
        logger.debug({ err: errorInfo(err).message }, "whatsapp: mensagem não normalizada");
      }
      if (!normalized) continue;
      const res = await this.opts.callbacks.onMessage(normalized);
      if (res && res.accepted) this.quoteCache.set(normalized.externalId, msg);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.groupsTimer) clearTimeout(this.groupsTimer);
    this.reconnectTimer = null;
    this.groupsTimer = null;
    const sock = this.sock;
    this.sock = null;
    this.quoteCache.clear();
    if (sock) {
      try {
        await sock.end(undefined);
      } catch {
        // ignora
      }
    }
  }

  async logout(): Promise<void> {
    const sock = this.sock;
    this.stopped = true;
    this.generation++;
    this.connected = false;
    if (sock) {
      try {
        await sock.logout("Finance AI: logout solicitado pelo usuário");
      } catch {
        // a sessão pode já estar inválida — as credenciais locais são apagadas mesmo assim
      }
    }
    await this.stop();
    await (this.clearCreds ?? (await useDatabaseAuthState(this.opts.connectionId)).clear)();
  }

  isConnected(): boolean {
    return this.connected && Boolean(this.sock);
  }

  async sendText(chatId: string, text: string, opts?: SendTextOptions): Promise<{ externalId: string }> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new Error("WhatsApp desconectado");
    const quoted = opts?.quotedExternalId ? this.quoteCache.get(opts.quotedExternalId) : undefined;
    const sent = await sock.sendMessage(chatId, { text }, quoted ? { quoted } : undefined);
    const id = sent?.key?.id;
    if (!id) throw new Error("O WhatsApp não confirmou o envio");
    if (sent.message) this.sentCache.set(id, sent.message);
    return { externalId: id };
  }

  async listGroups(): Promise<ProviderGroup[]> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new Error("WhatsApp desconectado");
    const all = await sock.groupFetchAllParticipating();
    const groups: ProviderGroup[] = [];
    for (const meta of Object.values(all) as GroupMetadata[]) {
      if (meta.isCommunity || meta.isCommunityAnnounce) continue;
      const raw = (meta.participants ?? []).map((p) => {
        let jid: string | null = null;
        let lid: string | null = null;
        for (const id of [p.id, p.phoneNumber, p.lid]) {
          const n = normalizeJid(id);
          if (!n) continue;
          if (!lid && isLidJid(n)) lid = n;
          else if (!jid && isPnJid(n)) jid = n;
        }
        return { jid, lid, isAdmin: Boolean(p.admin) };
      });
      // Mapeamento LID → telefone em lote (somente quando o WhatsApp não informou o telefone).
      const missing = raw.filter((p) => p.lid && !p.jid).map((p) => p.lid!);
      if (missing.length) {
        try {
          const mappings = (await sock.signalRepository.lidMapping.getPNsForLIDs(missing)) ?? [];
          const byLid = new Map(mappings.map((m) => [normalizeJid(m.lid), normalizeJid(m.pn)]));
          for (const p of raw) if (p.lid && !p.jid) p.jid = byLid.get(p.lid) ?? null;
        } catch {
          // sem mapeamento: o membro ainda é reconhecido pelo LID aprendido nas mensagens
        }
      }
      const participants: ProviderGroupParticipant[] = raw.map((p) => ({ ...p, phone: phoneFromJid(p.jid) }));
      groups.push({ externalId: meta.id, name: meta.subject || "Grupo sem nome", participantsCount: meta.size ?? participants.length, participants });
    }
    return groups;
  }
}
