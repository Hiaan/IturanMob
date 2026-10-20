import { redis } from "./redis";
import { logger } from "./logger";

/**
 * Eventos em tempo real por família (Redis pub/sub → SSE no dashboard).
 * Os eventos carregam apenas identificadores e tipos — nunca conteúdo sensível.
 */
export type RealtimeEventType =
  | "transaction.changed"
  | "account.changed"
  | "card.changed"
  | "budget.changed"
  | "goal.changed"
  | "bill.changed"
  | "pending.changed"
  | "notification.created"
  | "whatsapp.status"
  | "whatsapp.message"
  | "import.changed"
  | "category.changed"
  | "appointment.changed";

export interface RealtimeEvent {
  type: RealtimeEventType;
  householdId: string;
  entityId?: string;
  at: string;
}

export function householdChannel(householdId: string) {
  return `fa:events:${householdId}`;
}

export async function publishEvent(householdId: string, type: RealtimeEventType, entityId?: string): Promise<void> {
  if (process.env.NODE_ENV === "test" && process.env.TEST_REDIS !== "1") return;
  const event: RealtimeEvent = { type, householdId, entityId, at: new Date().toISOString() };
  try {
    const client = redis();
    // Com o Redis indisponível, não espera reconexão: o tempo real é opcional.
    if (client.status !== "ready") return;
    await Promise.race([
      client.publish(householdChannel(householdId), JSON.stringify(event)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);
  } catch (err) {
    // Tempo real é melhor esforço: a falha não pode impedir a operação financeira.
    logger.debug({ err: (err as Error).message, type }, "events: falha ao publicar");
  }
}
