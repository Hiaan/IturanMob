import type { WhatsAppConnectionStatus, WhatsAppProviderType } from "@prisma/client";

/**
 * Abstração de provedores de WhatsApp.
 *
 * O restante do sistema (ingestão, processamento, envio, API) conhece APENAS estes tipos.
 * Trocar de provedor (Baileys, Cloud API oficial, simulador) não exige mudanças fora de
 * `src/server/whatsapp`. Nenhum provedor implementa envio em massa ou mensagens a terceiros:
 * o envio é sempre direcionado ao chat autorizado da família.
 */

export type InboundMessageType = "TEXT" | "AUDIO" | "IMAGE" | "DOCUMENT" | "VIDEO" | "STICKER" | "REACTION" | "OTHER";

/** Identificadores do remetente conforme o provedor os entrega (qualquer um pode faltar). */
export interface SenderIds {
  /** JID por telefone, ex.: 5581999999999@s.whatsapp.net. */
  jid?: string | null;
  /** LID (identificador opaco do WhatsApp), ex.: 123456789@lid. */
  lid?: string | null;
  /** Telefone em E.164 (+5581999999999), quando conhecido. */
  phone?: string | null;
}

export interface InboundMedia {
  mimeType: string;
  /** Tamanho informado pelo provedor (pode faltar ou ser impreciso). */
  sizeBytes?: number | null;
  fileName?: string | null;
  /** Baixa o conteúdo original. Deve respeitar o limite `maxBytes` (lança erro se excedido). */
  download(maxBytes: number): Promise<Buffer>;
}

/** Mensagem recebida normalizada — independente do provedor. */
export interface NormalizedInboundMessage {
  /** Identificador da mensagem no provedor (idempotência por conexão). */
  externalId: string;
  /** Chat de origem: JID do grupo (Baileys/simulador) ou wa_id do remetente (Cloud API). */
  chatId: string;
  isGroup: boolean;
  senderIds: SenderIds;
  /** Enviada pelo próprio número conectado (ex.: o cônjuge dono do número). */
  fromMe: boolean;
  sentAt: Date;
  type: InboundMessageType;
  /** Texto (mensagens de texto). */
  text?: string | null;
  /** Legenda (imagens, documentos, vídeos). */
  caption?: string | null;
  /** Mensagem citada (resposta a outra mensagem). */
  quotedExternalId?: string | null;
  media?: InboundMedia | null;
}

export interface ProviderCapabilities {
  qrCode: boolean;
  groups: boolean;
  sendMessages: boolean;
  mediaDownload: boolean;
}

export interface ProviderGroupParticipant {
  jid?: string | null;
  lid?: string | null;
  phone?: string | null;
  isAdmin?: boolean;
}

export interface ProviderGroup {
  externalId: string;
  name: string;
  participantsCount: number;
  participants: ProviderGroupParticipant[];
}

export interface ProviderStatusUpdate {
  status: WhatsAppConnectionStatus;
  phoneNumber?: string | null;
  displayName?: string | null;
  /** Mensagem de erro curta, sem dados sensíveis. */
  error?: string | null;
  /** Tentativa de reconexão (1, 2, ...) quando em backoff. */
  attempt?: number;
  /** Estado terminal: o provedor não tentará reconectar sozinho (ex.: sessão substituída). */
  terminal?: boolean;
}

export interface OnMessageResult {
  accepted: boolean;
}

export interface ProviderCallbacks {
  onQr(qr: string): void | Promise<void>;
  onStatus(update: ProviderStatusUpdate): void | Promise<void>;
  /** Retorna se a mensagem foi aceita (pertence ao chat autorizado e a remetente autorizado). */
  onMessage(msg: NormalizedInboundMessage): Promise<OnMessageResult | void> | OnMessageResult | void;
  onGroups(groups: ProviderGroup[]): void | Promise<void>;
}

export interface SendTextOptions {
  quotedExternalId?: string | null;
}

export interface WhatsAppProvider {
  readonly type: WhatsAppProviderType;
  readonly capabilities: ProviderCapabilities;
  /** Inicia a conexão (não bloqueia até conectar; o progresso chega por onStatus/onQr). */
  start(): Promise<void>;
  /** Encerra a conexão mantendo as credenciais. */
  stop(): Promise<void>;
  /** Encerra a sessão no provedor e apaga as credenciais locais. */
  logout(): Promise<void>;
  isConnected(): boolean;
  sendText(chatId: string, text: string, opts?: SendTextOptions): Promise<{ externalId: string }>;
  listGroups(): Promise<ProviderGroup[]>;
}

/** Capacidades estáticas por tipo de provedor (sem importar o código do provedor). */
export const PROVIDER_CAPABILITIES: Record<WhatsAppProviderType, ProviderCapabilities> = {
  BAILEYS: { qrCode: true, groups: true, sendMessages: true, mediaDownload: true },
  CLOUD_API: { qrCode: false, groups: false, sendMessages: true, mediaDownload: true },
  SIMULATOR: { qrCode: false, groups: true, sendMessages: true, mediaDownload: true },
};

export const PROVIDER_INFO: Record<WhatsAppProviderType, { label: string; official: boolean; description: string }> = {
  CLOUD_API: {
    label: "WhatsApp Business Cloud API (oficial)",
    official: true,
    description:
      "API oficial da Meta. Exige número comercial e aplicativo verificado. As mensagens chegam como conversas diretas com o número comercial (sem grupos).",
  },
  BAILEYS: {
    label: "WhatsApp Web via Baileys (NÃO oficial)",
    official: false,
    description: "Conecta um número comum lendo o QR Code, como o WhatsApp Web. Permite usar o grupo da família.",
  },
  SIMULATOR: {
    label: "Simulador (desenvolvimento)",
    official: false,
    description: "Simulador — nenhuma conexão real com o WhatsApp. As mensagens são injetadas pela tela de simulação.",
  },
};

export const SIMULATOR_NOTICE = "Simulador — nenhuma conexão real com o WhatsApp";

export const BAILEYS_RISK_WARNING =
  "Atenção: o Baileys é uma biblioteca NÃO oficial, não autorizada pela Meta. O uso pode levar ao bloqueio do número e a integração pode parar de funcionar após mudanças no protocolo do WhatsApp. Use um número dedicado, obtenha o consentimento de todos os participantes e mantenha um grupo exclusivo para as finanças da família.";

/** Limite de tamanho de mídia aceito (16 MB). */
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
