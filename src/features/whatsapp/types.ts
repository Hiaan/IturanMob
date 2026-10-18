/** Tipos das respostas da API de integração com o WhatsApp (/api/v1/integrations/whatsapp). */

export type WaProvider = "CLOUD_API" | "BAILEYS" | "SIMULATOR";
export type WaConnectionStatus = "DISCONNECTED" | "CONNECTING" | "QR_PENDING" | "CONNECTED" | "ERROR" | "LOGGED_OUT";
export type WaMessageStatus = "RECEIVED" | "QUEUED" | "PROCESSING" | "PROCESSED" | "IGNORED" | "NEEDS_CLARIFICATION" | "FAILED";
export type WaMessageType = "TEXT" | "AUDIO" | "IMAGE" | "DOCUMENT" | "VIDEO" | "STICKER" | "REACTION" | "OTHER";

export interface WaEvent {
  id: string;
  type: string;
  message: string | null;
  createdAt: string;
}

/** Natureza padrão do grupo: PERSONAL (pessoa física), BUSINESS (empresa) ou null (não atribuído). */
export type WaGroupNature = "PERSONAL" | "BUSINESS";

export interface WaGroup {
  id: string;
  name: string;
  participantsCount: number;
  isAuthorized: boolean;
  /** Vale para os lançamentos que chegam pelo grupo (a mensagem e as regras vencem). */
  defaultNature: WaGroupNature | null;
  authorizedAt: string | null;
  lastSyncedAt: string;
  isSimulator: boolean;
  /** Grupo simulado da família ou da empresa (null fora do simulador). */
  simulatorKind: "FAMILY" | "BUSINESS" | null;
}

export interface WaMember {
  id: string;
  displayName: string;
  relation: string | null;
  whatsappPhone: string | null;
  whatsappAuthorized: boolean;
  whatsappConsentAt: string | null;
  hasConsent: boolean;
  identified: boolean;
  ready: boolean;
}

export interface WaStatus {
  provider: WaProvider;
  providerLabel: string;
  providerDescription: string;
  official: boolean;
  riskWarning: string | null;
  simulator: { notice: string; enabled: boolean } | null;
  capabilities: { qrCode: boolean; groups: boolean; sendMessages: boolean; mediaDownload: boolean };
  status: WaConnectionStatus;
  desiredConnected: boolean;
  phoneNumber: string | null;
  displayName: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastMessageAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  processingEnabled: boolean;
  pendingRequests: { logout: boolean; reconnect: boolean; groupSync: boolean };
  qrAvailable: boolean;
  worker: { online: boolean; lastHeartbeat: string | null };
  stats7d: { total: number; byStatus: Record<WaMessageStatus, number> };
  recentErrors: WaEvent[];
  recentEvents: WaEvent[];
  groups: WaGroup[];
  /** Primeiro grupo autorizado (pode haver vários: veja `groups`). */
  authorizedGroup: WaGroup | null;
  members: WaMember[];
  canSend: boolean;
  cloudApi: {
    configured: boolean;
    webhookUrl: string;
    verifyTokenConfigured: boolean;
    appSecretConfigured: boolean;
    phoneNumberId: string | null;
    note: string;
  } | null;
  availableProviders: Array<{ type: WaProvider; label: string; official: boolean; description: string; enabled: boolean; reason: string | null }>;
}

export interface WaCommandResult {
  ok: boolean;
  commandDelivered: boolean;
  workerOnline: boolean;
  message: string | null;
}

export interface WaMessageTransaction {
  id: string;
  type: string;
  status: string;
  amountCents: number;
  description: string;
  date: string;
  deleted: boolean;
  sourceIndex: number;
}

export interface WaMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type: WaMessageType;
  status: WaMessageStatus;
  intent: string | null;
  statusDetail: string | null;
  text: string | null;
  sentAt: string;
  processedAt: string | null;
  quotedExternalId: string | null;
  isBot: boolean;
  sender: { id: string; displayName: string; color: string } | null;
  attachment: { id: string; kind: string; mimeType: string; sizeBytes: number; contentDeleted: boolean } | null;
  job: { status: string; attempts: number; maxAttempts: number; lastError: string | null; runAfter: string; finishedAt: string | null } | null;
  transactions: WaMessageTransaction[];
  /** Grupo da mensagem (há famílias com um grupo de pessoa física e outro da empresa). */
  group: { id: string; name: string; defaultNature: WaGroupNature | null } | null;
}

export interface WaMessagesPage {
  items: WaMessage[];
  nextCursor: string | null;
  /** Primeiro grupo autorizado. */
  scope: { groupId: string; groupName: string } | null;
  /** Todos os grupos autorizados. */
  groups?: Array<{ id: string; name: string }>;
}

export interface WaSimulateResult {
  notice: string;
  accepted: boolean;
  reason: string | null;
  reasonLabel: string | null;
  messageId: string | null;
  externalId: string | null;
  status: WaMessageStatus | null;
  mode: "worker" | "inline" | null;
  outcome:
    | { outcome: "SKIPPED"; reason: string }
    | { outcome: "SUCCEEDED" | "FAILED"; messageStatus: WaMessageStatus; replies: number }
    | { outcome: "RETRY_SCHEDULED"; attempts: number; runAfter: string }
    | { outcome: "DEAD"; attempts: number }
    | null;
}
