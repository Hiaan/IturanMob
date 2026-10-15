import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../env";
import { normalizeE164 } from "../phone";
import {
  PROVIDER_CAPABILITIES,
  type InboundMessageType,
  type NormalizedInboundMessage,
  type ProviderCallbacks,
  type ProviderGroup,
  type SendTextOptions,
  type WhatsAppProvider,
} from "../types";

/**
 * WhatsApp Business Cloud API (OFICIAL, Meta Graph API).
 *
 * - Recebimento: webhook (src/app/api/webhooks/whatsapp/route.ts) com verificação de assinatura
 *   X-Hub-Signature-256; as mensagens chegam como conversas DIRETAS com o número comercial.
 *   O "chat autorizado" é a conversa de cada membro autorizado (com consentimento).
 * - Envio: POST /{phone-number-id}/messages (somente para os membros autorizados da família).
 * - Mídia: GET /{media-id} → URL temporária → download autenticado.
 * Grupos não são suportados por este provedor.
 */

const GRAPH = "https://graph.facebook.com";
const REQUEST_TIMEOUT_MS = 20_000;

export interface CloudApiConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
}

/** Configuração a partir do ambiente (token SEMPRE do ambiente; phoneNumberId pode vir da conexão). */
export function cloudConfig(connConfig?: { phoneNumberId?: string } | null): CloudApiConfig | null {
  const e = env();
  const accessToken = e.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const phoneNumberId = connConfig?.phoneNumberId || e.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId, apiVersion: e.WHATSAPP_CLOUD_API_VERSION };
}

/** Valida X-Hub-Signature-256 ("sha256=<hex>") com HMAC do corpo bruto, em tempo constante. */
export function verifyCloudSignature(rawBody: string | Buffer, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1]!, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function sanitizeGraphError(status: number, body: unknown): string {
  const err = (body as { error?: { message?: string; code?: number } } | null)?.error;
  const code = err?.code ? ` (código ${err.code})` : "";
  const message = (err?.message ?? "").replace(/access[_ ]token[^ ]*/gi, "[token]").slice(0, 160);
  return `Graph API HTTP ${status}${code}${message ? `: ${message}` : ""}`;
}

async function graphFetch(cfg: CloudApiConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GRAPH}/${cfg.apiVersion}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(sanitizeGraphError(res.status, body));
  return body;
}

/** Baixa uma mídia (GET /{media-id} → URL → download autenticado), respeitando o limite. */
export async function downloadCloudMedia(cfg: CloudApiConfig, mediaId: string, maxBytes: number): Promise<Buffer> {
  if (!/^[A-Za-z0-9_.-]+$/.test(mediaId)) throw new Error("Identificador de mídia inválido");
  const meta = (await graphFetch(cfg, encodeURIComponent(mediaId))) as { url?: string; file_size?: number };
  if (!meta?.url) throw new Error("A Graph API não retornou a URL da mídia");
  if (meta.file_size && meta.file_size > maxBytes) throw new Error("Arquivo acima do limite de 16 MB");
  const url = new URL(meta.url);
  if (url.protocol !== "https:") throw new Error("URL de mídia inválida");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.accessToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`Falha ao baixar mídia (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > maxBytes) throw new Error("Arquivo acima do limite de 16 MB");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Arquivo acima do limite de 16 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// -----------------------------------------------------------------------------
// Webhook → mensagens normalizadas
// -----------------------------------------------------------------------------

interface CloudMediaPayload {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

interface CloudMessagePayload {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  group_id?: string;
  text?: { body?: string };
  image?: CloudMediaPayload;
  audio?: CloudMediaPayload;
  document?: CloudMediaPayload;
  video?: CloudMediaPayload;
  sticker?: CloudMediaPayload;
  reaction?: { message_id?: string; emoji?: string };
  context?: { id?: string; from?: string };
}

export interface CloudWebhookMessage {
  phoneNumberId: string | null;
  message: NormalizedInboundMessage;
}

function mapType(type: string | undefined): InboundMessageType {
  switch (type) {
    case "text":
      return "TEXT";
    case "image":
      return "IMAGE";
    case "audio":
      return "AUDIO";
    case "document":
      return "DOCUMENT";
    case "video":
      return "VIDEO";
    case "sticker":
      return "STICKER";
    case "reaction":
      return "REACTION";
    default:
      return "OTHER";
  }
}

/**
 * Extrai as mensagens de um payload de webhook. `mediaConfig` permite baixar mídias (pode ser null em testes).
 * Atualizações de status (entregue/lida) são ignoradas.
 */
export function parseCloudWebhook(payload: unknown, mediaConfig: CloudApiConfig | null): CloudWebhookMessage[] {
  const out: CloudWebhookMessage[] = [];
  const entries = (payload as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const c = change as { field?: string; value?: { metadata?: { phone_number_id?: string }; messages?: CloudMessagePayload[] } };
      if (c.field !== "messages" || !c.value) continue;
      const phoneNumberId = c.value.metadata?.phone_number_id ?? null;
      for (const m of c.value.messages ?? []) {
        if (!m?.id || !m.from) continue;
        const type = mapType(m.type);
        const mediaPayload: CloudMediaPayload | undefined =
          type === "IMAGE" ? m.image : type === "AUDIO" ? m.audio : type === "DOCUMENT" ? m.document : type === "VIDEO" ? m.video : undefined;
        const mediaId = mediaPayload?.id;
        const ts = Number(m.timestamp);
        const isGroup = Boolean(m.group_id);
        out.push({
          phoneNumberId,
          message: {
            externalId: m.id,
            chatId: isGroup ? m.group_id! : m.from,
            isGroup,
            senderIds: { phone: normalizeE164(m.from) },
            fromMe: false,
            sentAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
            type,
            text: type === "TEXT" ? (m.text?.body ?? null) : null,
            caption: mediaPayload?.caption ?? null,
            quotedExternalId: m.context?.id ?? null,
            media:
              mediaId && mediaConfig
                ? {
                    mimeType: mediaPayload?.mime_type ?? "application/octet-stream",
                    fileName: mediaPayload?.filename ?? null,
                    download: (maxBytes: number) => downloadCloudMedia(mediaConfig, mediaId, maxBytes),
                  }
                : null,
          },
        });
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Provedor (worker): verificação de credenciais e envio
// -----------------------------------------------------------------------------

export class CloudApiProvider implements WhatsAppProvider {
  readonly type = "CLOUD_API" as const;
  readonly capabilities = PROVIDER_CAPABILITIES.CLOUD_API;
  private connected = false;

  constructor(
    private readonly cfg: CloudApiConfig,
    private readonly callbacks: ProviderCallbacks,
  ) {}

  async start(): Promise<void> {
    await this.callbacks.onStatus({ status: "CONNECTING" });
    try {
      const info = (await graphFetch(this.cfg, `${encodeURIComponent(this.cfg.phoneNumberId)}?fields=display_phone_number,verified_name`)) as {
        display_phone_number?: string;
        verified_name?: string;
      };
      this.connected = true;
      await this.callbacks.onStatus({
        status: "CONNECTED",
        phoneNumber: normalizeE164(info?.display_phone_number ?? null),
        displayName: info?.verified_name ?? "WhatsApp Business",
      });
    } catch (err) {
      this.connected = false;
      // O gerenciador de conexão registra o erro (status ERROR + histórico) e tenta novamente com backoff.
      throw new Error(`Falha ao validar a Cloud API: ${(err as Error).message}`.slice(0, 300));
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  async logout(): Promise<void> {
    // As credenciais da Cloud API ficam no ambiente (não há sessão local a apagar).
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendText(chatId: string, text: string, opts?: SendTextOptions): Promise<{ externalId: string }> {
    const to = chatId.replace(/\D/g, "");
    if (!to) throw new Error("Destinatário inválido");
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text, preview_url: false },
      ...(opts?.quotedExternalId ? { context: { message_id: opts.quotedExternalId } } : {}),
    };
    const res = (await graphFetch(this.cfg, `${encodeURIComponent(this.cfg.phoneNumberId)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    })) as { messages?: Array<{ id?: string }> };
    const id = res?.messages?.[0]?.id;
    if (!id) throw new Error("A Graph API não retornou o id da mensagem");
    return { externalId: id };
  }

  async listGroups(): Promise<ProviderGroup[]> {
    return [];
  }
}
