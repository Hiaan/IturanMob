/**
 * CONTRATO — resultado do processamento de uma mensagem recebida (texto, áudio ou imagem).
 * O módulo de WhatsApp persiste a mensagem (e a mídia como Attachment) e chama
 * `handleInboundMessage(messageId)`. As respostas retornadas são enviadas ao grupo.
 */
export interface InboundMessageResult {
  status: "PROCESSED" | "IGNORED" | "NEEDS_CLARIFICATION" | "FAILED";
  /** Intenção detectada (ex.: CREATE_TRANSACTIONS, QUERY, CORRECTION, SMALL_TALK). */
  intent?: string;
  /** Textos a enviar como resposta no chat (já formatados, sem prefixo do bot). */
  replies: string[];
  /** Arquivos a enviar depois das respostas (relatório em PDF, planilha); `caption` acompanha. */
  documents?: ReplyDocument[];
  transactionIds: string[];
  /** Detalhe técnico curto (sem conteúdo sensível) para o histórico. */
  detail?: string;
  /** Erro recuperável: o job deve ser tentado novamente. */
  retryable?: boolean;
}

export interface ReplyDocument {
  storageKey: string;
  mimeType: string;
  fileName: string;
  caption: string;
}
