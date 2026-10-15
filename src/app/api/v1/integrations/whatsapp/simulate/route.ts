import { authed } from "@/server/api/handler";
import { simulateInbound, simulateSchema } from "@/server/whatsapp/service";

/**
 * SIMULADOR — injeta uma mensagem de um membro no grupo simulado (nenhuma conexão real com o WhatsApp).
 * Disponível somente com o provedor SIMULATOR e WHATSAPP_ENABLE_SIMULATOR=true.
 */
export const POST = authed(
  { body: simulateSchema, permission: "integrations:manage", rateLimit: { key: "wa-simulate", limit: 30, windowSeconds: 60 } },
  async ({ ctx, body }) => simulateInbound(ctx, body),
);
