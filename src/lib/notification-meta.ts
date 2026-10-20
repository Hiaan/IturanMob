/**
 * Destino e importância de cada tipo de notificação (push, sininho e pop-ups no app).
 * Compartilhado entre servidor e cliente: só tipos e textos, sem dados.
 */

export type NotificationTypeKey =
  | "TRANSACTION_CREATED"
  | "INCOME_CREATED"
  | "CONFIRMATION_REQUIRED"
  | "BUDGET_THRESHOLD"
  | "BILL_DUE"
  | "STATEMENT_AVAILABLE"
  | "WEEKLY_REPORT"
  | "MONTHLY_REPORT"
  | "WHATSAPP_CONNECTION_FAILED"
  | "SYSTEM"
  | "INCOME_GOAL"
  | "GOAL_PROGRESS"
  | "BILL_OVERDUE"
  | "STATEMENT_DUE";

export const NOTIFICATION_TYPE_URL: Partial<Record<NotificationTypeKey, string>> = {
  BILL_DUE: "/contas-a-pagar",
  BILL_OVERDUE: "/contas-a-pagar",
  BUDGET_THRESHOLD: "/orcamentos",
  CONFIRMATION_REQUIRED: "/pendencias",
  STATEMENT_AVAILABLE: "/cartoes",
  STATEMENT_DUE: "/cartoes",
  INCOME_GOAL: "/metas",
  GOAL_PROGRESS: "/metas",
  WEEKLY_REPORT: "/relatorios",
  MONTHLY_REPORT: "/relatorios",
  WHATSAPP_CONNECTION_FAILED: "/integracoes",
  TRANSACTION_CREATED: "/transacoes",
  INCOME_CREATED: "/transacoes",
};

/** Destino ao tocar na notificação: o informado em `data.url` (relativo) ou o do tipo. */
export function notificationUrl(type: string, data?: unknown): string {
  const url = data && typeof data === "object" && "url" in data ? (data as { url?: unknown }).url : null;
  if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//")) return url;
  return NOTIFICATION_TYPE_URL[type as NotificationTypeKey] ?? "/";
}

/**
 * Importância para os pop-ups ao voltar ao app (menor = mais importante):
 * vencidas → vence hoje → metas → o resto.
 */
export function notificationPriority(type: string, data?: unknown): number {
  const stage = data && typeof data === "object" && "stage" in data ? (data as { stage?: unknown }).stage : null;
  if (type === "BILL_OVERDUE" || (type === "STATEMENT_DUE" && stage === "OVERDUE")) return 0;
  if ((type === "STATEMENT_DUE" && stage === "TODAY") || (type === "BILL_DUE" && stage === "TODAY")) return 1;
  if (type === "INCOME_GOAL" || type === "GOAL_PROGRESS") return 2;
  if (type === "BILL_DUE" || type === "STATEMENT_DUE" || type === "BUDGET_THRESHOLD") return 3;
  return 4;
}
