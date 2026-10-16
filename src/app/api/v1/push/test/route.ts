import { authed } from "@/server/api/handler";
import { sendTestPush } from "@/server/modules/push/service";

/** Envia uma notificação de teste para os aparelhos do membro logado. */
export const POST = authed({ permission: "transactions:read", rateLimit: { key: "push:test", limit: 5, windowSeconds: 60 } }, async ({ ctx }) => sendTestPush(ctx));
