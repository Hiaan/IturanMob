/** Rótulos em português para enums do domínio (compartilhado entre cliente e servidor). */

export const TRANSACTION_TYPE_LABELS = {
  EXPENSE: "Despesa",
  INCOME: "Receita",
  TRANSFER: "Transferência",
  CARD_PAYMENT: "Pagamento de fatura",
  ADJUSTMENT: "Ajuste de saldo",
} as const;

export const TRANSACTION_STATUS_LABELS = {
  CONFIRMED: "Confirmada",
  PENDING: "Aguardando confirmação",
} as const;

export const PAYMENT_METHOD_LABELS = {
  PIX: "Pix",
  DEBIT_CARD: "Cartão de débito",
  CREDIT_CARD: "Cartão de crédito",
  CASH: "Dinheiro",
  BANK_SLIP: "Boleto",
  BANK_TRANSFER: "Transferência bancária",
  AUTO_DEBIT: "Débito automático",
  VOUCHER: "Vale (VR/VA)",
  OTHER: "Outro",
} as const;

export const TRANSACTION_SOURCE_LABELS = {
  MANUAL: "Manual",
  WHATSAPP_TEXT: "WhatsApp (texto)",
  WHATSAPP_AUDIO: "WhatsApp (áudio)",
  WHATSAPP_IMAGE: "WhatsApp (comprovante)",
  DASHBOARD_CHAT: "Lançamento rápido",
  IMPORT: "Importação",
  RECURRING: "Recorrência",
  SYSTEM: "Sistema",
} as const;

export const OWNERSHIP_LABELS = {
  SHARED: "Família (compartilhada)",
  INDIVIDUAL: "Individual",
} as const;

export const ACCOUNT_TYPE_LABELS = {
  CHECKING: "Conta corrente",
  SAVINGS: "Poupança",
  WALLET: "Carteira",
  INVESTMENT: "Investimento",
  DIGITAL: "Conta digital",
  OTHER: "Outra",
} as const;

export const VISIBILITY_LABELS = {
  SHARED: "Compartilhada",
  PRIVATE: "Privada",
} as const;

export const MEMBER_ROLE_LABELS = {
  OWNER: "Proprietário",
  ADMIN: "Administrador",
  MEMBER: "Membro",
  VIEWER: "Somente leitura",
} as const;

export const RECURRENCE_FREQUENCY_LABELS = {
  WEEKLY: "Semanal",
  BIWEEKLY: "Quinzenal",
  MONTHLY: "Mensal",
  QUARTERLY: "Trimestral",
  SEMIANNUAL: "Semestral",
  YEARLY: "Anual",
  CUSTOM_DAYS: "A cada N dias",
  CUSTOM_MONTHS: "A cada N meses",
} as const;

export const SCHEDULED_STATUS_LABELS = {
  PENDING: "Prevista",
  POSTED: "Lançada",
  PAID: "Paga",
  SKIPPED: "Ignorada",
  CANCELLED: "Cancelada",
  OVERDUE: "Vencida",
} as const;

export const STATEMENT_STATUS_LABELS = {
  OPEN: "Aberta",
  CLOSED: "Fechada",
  PAID: "Paga",
  PARTIAL: "Paga parcialmente",
  OVERDUE: "Vencida",
  FUTURE: "Futura",
} as const;

export const PENDING_TYPE_LABELS = {
  CONFIRMATION: "Aguardando confirmação",
  UNCATEGORIZED: "Sem categoria",
  MISSING_PAYMENT_METHOD: "Sem forma de pagamento",
  POSSIBLE_DUPLICATE: "Possível duplicidade",
  UNREADABLE_RECEIPT: "Comprovante não identificado",
  PROCESSING_FAILED: "Falha de processamento",
  IMPORT_DIVERGENCE: "Divergência de importação",
  INSTALLMENT_INCONSISTENT: "Parcelamento inconsistente",
  CLARIFICATION: "Aguardando esclarecimento",
  NATURE_REVIEW: "Escolher natureza",
} as const;

export const NOTIFICATION_TYPE_LABELS = {
  TRANSACTION_CREATED: "Despesa registrada",
  INCOME_CREATED: "Receita registrada",
  CONFIRMATION_REQUIRED: "Transação aguardando confirmação",
  BUDGET_THRESHOLD: "Orçamento próximo do limite",
  BILL_DUE: "Conta próxima do vencimento",
  STATEMENT_AVAILABLE: "Fatura disponível",
  WEEKLY_REPORT: "Relatório semanal disponível",
  MONTHLY_REPORT: "Relatório mensal disponível",
  WHATSAPP_CONNECTION_FAILED: "Falha na conexão do WhatsApp",
  SYSTEM: "Sistema",
  INCOME_GOAL: "Meta de ganho",
  GOAL_PROGRESS: "Metas de economia",
  BILL_OVERDUE: "Conta vencida não paga",
  STATEMENT_DUE: "Fatura perto de vencer",
  CASH_SHORTFALL: "Vai faltar dinheiro",
  SUBSCRIPTION_FOUND: "Assinatura encontrada ou mais cara",
} as const;

export const WHATSAPP_STATUS_LABELS = {
  DISCONNECTED: "Desconectado",
  CONNECTING: "Conectando…",
  QR_PENDING: "Aguardando leitura do QR Code",
  CONNECTED: "Conectado",
  ERROR: "Erro",
  LOGGED_OUT: "Sessão encerrada",
} as const;

export const MESSAGE_STATUS_LABELS = {
  RECEIVED: "Recebida",
  QUEUED: "Na fila",
  PROCESSING: "Processando",
  PROCESSED: "Processada",
  IGNORED: "Ignorada",
  NEEDS_CLARIFICATION: "Aguardando esclarecimento",
  FAILED: "Falhou",
} as const;

export const AI_PROVIDER_LABELS = {
  ANTHROPIC: "Anthropic Claude",
  OPENAI: "OpenAI",
  OPENAI_COMPATIBLE: "Compatível com OpenAI",
  LOCAL: "Motor local (heurístico, sem IA externa)",
} as const;

export const AI_TASK_LABELS = {
  PARSE_MESSAGE: "Interpretação de mensagens",
  RECEIPT_EXTRACTION: "Leitura de comprovantes",
  TRANSCRIPTION: "Transcrição de áudio",
  ASSISTANT: "Assistente financeiro",
  INSIGHTS: "Análise de padrões",
} as const;

export const REGIME_LABELS = {
  ACCRUAL: "Competência",
  CASH: "Caixa",
} as const;

export const REGIME_DESCRIPTIONS = {
  ACCRUAL:
    "Competência: a despesa é reconhecida na data de competência (por padrão, a data da compra), pelo valor total — inclusive compras parceladas no cartão.",
  CASH:
    "Caixa: a despesa é reconhecida quando o dinheiro sai. Débito, Pix e dinheiro na data do pagamento; compras no cartão pelo valor de cada parcela, na data de vencimento da fatura. O pagamento da fatura em si nunca é contado como despesa.",
} as const;

export function labelOf<T extends Record<string, string>>(map: T, key: string | null | undefined, fallback = "—"): string {
  if (!key) return fallback;
  return (map as Record<string, string>)[key] ?? key;
}
