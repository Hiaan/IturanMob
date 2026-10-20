import { authed } from "@/server/api/handler";
import { setSubscriptionCandidateStatus } from "@/server/modules/subscriptions/service";

/** POST → não sugerir mais esta cobrança. */
export const POST = authed({ permission: "bills:write" }, async ({ ctx, params }) => setSubscriptionCandidateStatus(ctx, params.id!, "IGNORED"));
