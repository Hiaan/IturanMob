/**
 * CONTRATO — envio de mensagens ao grupo autorizado da família.
 *
 * Qualquer módulo (notificações, relatórios, pipeline) usa estas funções; o worker que mantém
 * a conexão com o provedor consome a fila e entrega. Se o WhatsApp estiver desconectado ou o
 * provedor não permitir envio, a mensagem fica registrada com falha e NÃO é perdida silenciosamente.
 */
export interface OutboundMessageInput {
  householdId: string;
  text: string;
  /** Mensagem citada (externalId do provedor), quando a resposta se refere a uma mensagem. */
  quotedExternalId?: string | null;
  /** Chave de idempotência: evita enviar a mesma mensagem duas vezes. */
  dedupeKey?: string | null;
  /** Origem lógica (ex.: "reply", "notification", "report"). */
  kind?: "reply" | "notification" | "report";
  /** Arquivo já gravado no armazenamento (relatório, planilha); `text` vira a legenda. */
  document?: OutboundDocumentRef | null;
}

export interface OutboundDocumentRef {
  storageKey: string;
  mimeType: string;
  fileName: string;
}

export { enqueueOutboundMessage, whatsappCanSend } from "./outbound-impl";
