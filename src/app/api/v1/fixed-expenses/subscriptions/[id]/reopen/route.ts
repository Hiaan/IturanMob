import { authed } from "@/server/api/handler";
import { setSubscriptionCandidateStatus } from "@/server/modules/subscriptions/service";

/** POST → volta a sugerir uma cobrança ignorada. */
export const POST = authed({ permission: "bills:write" }, async ({ ctx, params }) => setSubscriptionCandidateStatus(ctx, params.id!, "OPEN"));
