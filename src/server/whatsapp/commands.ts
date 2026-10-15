import { redis } from "../redis";
import { logger } from "../logger";
import { WA_COMMANDS_CHANNEL, WORKER_HEARTBEAT_KEY } from "./keys";

/**
 * Comandos da API para o worker (Redis pub/sub, canal fa:wa:commands).
 * O estado desejado também fica no banco; o worker verifica o banco periodicamente (~10 s),
 * então um comando perdido apenas atrasa a convergência.
 */
export type WhatsAppCommandType = "connect" | "disconnect" | "reconnect" | "logout" | "sync-groups";

export interface WhatsAppCommand {
  type: WhatsAppCommandType;
  householdId: string;
  at: string;
}

const COMMAND_TYPES: ReadonlySet<string> = new Set(["connect", "disconnect", "reconnect", "logout", "sync-groups"]);

export function parseCommand(raw: string): WhatsAppCommand | null {
  try {
    const obj = JSON.parse(raw) as Partial<WhatsAppCommand>;
    if (!obj || typeof obj.householdId !== "string" || typeof obj.type !== "string" || !COMMAND_TYPES.has(obj.type)) return null;
    return { type: obj.type as WhatsAppCommandType, householdId: obj.householdId, at: typeof obj.at === "string" ? obj.at : new Date().toISOString() };
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Publica um comando. Retorna false se o Redis estiver indisponível (o worker converge pelo banco). */
export async function publishCommand(type: WhatsAppCommandType, householdId: string): Promise<boolean> {
  const cmd: WhatsAppCommand = { type, householdId, at: new Date().toISOString() };
  try {
    const r = redis();
    if (r.status !== "ready" && r.status !== "connecting" && r.status !== "connect") return false;
    await withTimeout(r.publish(WA_COMMANDS_CHANNEL, JSON.stringify(cmd)), 2000);
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message, type }, "whatsapp: comando não publicado (o worker usará o banco)");
    return false;
  }
}

/** Situação do worker pelo heartbeat no Redis. */
export async function workerStatus(): Promise<{ online: boolean; lastHeartbeat: string | null }> {
  try {
    const r = redis();
    const hb = await withTimeout(r.get(WORKER_HEARTBEAT_KEY), 1500);
    const online = Boolean(hb && Date.now() - new Date(hb).getTime() < 90_000);
    return { online, lastHeartbeat: hb };
  } catch {
    return { online: false, lastHeartbeat: null };
  }
}
