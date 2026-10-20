/** Tipos de resposta da caixa de notificações (espelham src/server/modules/notifications/service.ts). */
import type { NotificationTypeKey } from "@/lib/notification-meta";

export interface NotificationDTO {
  id: string;
  type: NotificationTypeKey;
  typeLabel: string;
  title: string;
  body: string;
  /** Livre por tipo; `url` (destino relativo) e `stage` nos lembretes de contas e faturas. */
  data: unknown;
  readAt: string | null;
  createdAt: string;
  /** Notificação da família (sem destinatário específico). */
  shared: boolean;
}

export interface NotificationPage {
  items: NotificationDTO[];
  nextCursor: string | null;
  unreadCount: number;
}

/** Campo de `data` como texto (ex.: `scheduledPaymentId` dos lembretes de conta vencida). */
export function dataString(data: unknown, key: string): string | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}
