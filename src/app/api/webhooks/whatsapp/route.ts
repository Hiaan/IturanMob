import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { errorInfo, logger } from "@/server/logger";
import { verifyCloudSignature } from "@/server/whatsapp/cloud-api/provider";
import { handleCloudWebhook } from "@/server/whatsapp/cloud-api/webhook";

/**
 * Webhook da WhatsApp Business Cloud API (oficial).
 * GET: verificação (hub.mode=subscribe, hub.verify_token = WHATSAPP_CLOUD_VERIFY_TOKEN).
 * POST: valida X-Hub-Signature-256 (HMAC-SHA256 com WHATSAPP_CLOUD_APP_SECRET, tempo constante),
 * persiste/enfileira pelo ingest e responde 200 rapidamente. Em falha interna responde 500 para que
 * a Meta reenvie (o ingest é idempotente por id da mensagem).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 3_000_000;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("hub.mode");
  const token = sp.get("hub.verify_token");
  const challenge = sp.get("hub.challenge");
  const expected = env().WHATSAPP_CLOUD_VERIFY_TOKEN;
  if (mode === "subscribe" && expected && token && challenge && safeEqual(token, expected)) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ error: { code: "FORBIDDEN", message: "Verificação do webhook recusada." } }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const secret = env().WHATSAPP_CLOUD_APP_SECRET;
  if (!secret) {
    return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "Webhook da Cloud API não configurado." } }, { status: 503 });
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Requisição muito grande." } }, { status: 413 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Requisição muito grande." } }, { status: 413 });
  if (!verifyCloudSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    logger.warn("whatsapp: webhook com assinatura inválida recusado");
    return NextResponse.json({ error: { code: "INVALID_SIGNATURE", message: "Assinatura inválida." } }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: { code: "BAD_JSON", message: "JSON inválido." } }, { status: 400 });
  }
  try {
    const result = await handleCloudWebhook(payload);
    if (result.received) logger.info({ ...result }, "whatsapp: webhook da Cloud API processado");
    return NextResponse.json({ data: { ok: true } }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error({ err: errorInfo(err).message }, "whatsapp: falha ao registrar webhook da Cloud API");
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Falha temporária." } }, { status: 500 });
  }
}
