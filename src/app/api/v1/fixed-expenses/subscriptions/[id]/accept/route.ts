import { authed } from "@/server/api/handler";
import { acceptSubscriptionCandidate, acceptSubscriptionSchema } from "@/server/modules/subscriptions/service";

/** POST { description?, categoryId? } → cadastra como gasto fixo mensal. */
export const POST = authed({ body: acceptSubscriptionSchema, permission: "bills:write" }, async ({ ctx, params, body }) => acceptSubscriptionCandidate(ctx, params.id!, body));
