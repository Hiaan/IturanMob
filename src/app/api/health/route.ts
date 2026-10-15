import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { redisHealthy } from "@/server/redis";

export const dynamic = "force-dynamic";

/** Health check (sem dados sensíveis). */
export async function GET() {
  const started = Date.now();
  let database = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch {
    database = false;
  }
  const redis = await redisHealthy();
  let worker: { lastHeartbeat: string | null; healthy: boolean } = { lastHeartbeat: null, healthy: false };
  if (redis) {
    try {
      const { redis: r } = await import("@/server/redis");
      const hb = await r().get("fa:worker:heartbeat");
      worker = { lastHeartbeat: hb, healthy: Boolean(hb && Date.now() - new Date(hb).getTime() < 90_000) };
    } catch {
      // ignore
    }
  }
  const ok = database;
  return NextResponse.json(
    { status: ok ? (redis && worker.healthy ? "ok" : "degraded") : "down", database, redis, worker, latencyMs: Date.now() - started },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
