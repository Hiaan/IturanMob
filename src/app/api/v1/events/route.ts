import type { NextRequest } from "next/server";
import { resolveSession, SESSION_COOKIE } from "@/server/auth/session";
import { newRedisConnection } from "@/server/redis";
import { householdChannel } from "@/server/events";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events: notifica o dashboard sobre mudanças (sem conteúdo sensível),
 * para que o cliente atualize apenas os dados afetados.
 */
export async function GET(req: NextRequest) {
  const session = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const channel = householdChannel(session.ctx.householdId);
  const encoder = new TextEncoder();
  let sub: ReturnType<typeof newRedisConnection> | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string, event?: string) => {
        try {
          controller.enqueue(encoder.encode(`${event ? `event: ${event}\n` : ""}data: ${data}\n\n`));
        } catch {
          // stream fechado
        }
      };
      send(JSON.stringify({ type: "connected", at: new Date().toISOString() }), "ready");
      keepAlive = setInterval(() => send(JSON.stringify({ type: "ping" }), "ping"), 25_000);
      try {
        sub = newRedisConnection("sse");
        await sub.subscribe(channel);
        sub.on("message", (_ch: string, message: string) => send(message));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "sse: tempo real indisponível");
        send(JSON.stringify({ type: "degraded" }), "degraded");
      }
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
      sub?.disconnect();
    },
  });

  req.signal.addEventListener("abort", () => {
    if (keepAlive) clearInterval(keepAlive);
    sub?.disconnect();
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
