import { z } from "zod";
import { authed } from "@/server/api/handler";
import { pushSubscriptionSchema, subscribePush, unsubscribePush } from "@/server/modules/push/service";

/** Inscreve este aparelho (PushSubscription do navegador: endpoint + chaves). */
export const POST = authed({ body: pushSubscriptionSchema, permission: "transactions:read", rateLimit: { key: "push:subscribe", limit: 20, windowSeconds: 60 } }, async ({ ctx, body }) =>
  subscribePush(ctx, body),
);

/** Remove a inscrição (pelo endpoint deste aparelho ou pelo id, na lista de aparelhos). */
export const DELETE = authed(
  { body: z.object({ endpoint: z.string().max(1000).optional(), id: z.string().max(64).optional() }).refine((b) => b.endpoint || b.id, "Informe o aparelho."), permission: "transactions:read" },
  async ({ ctx, body }) => unsubscribePush(ctx, body),
);
