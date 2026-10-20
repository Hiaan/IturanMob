import { z } from "zod";
import { authed } from "@/server/api/handler";
import { listSubscriptionCandidates } from "@/server/modules/subscriptions/service";

/** GET ?status=OPEN|IGNORED → cobranças mensais encontradas que não estão nos gastos fixos. */
export const GET = authed({ query: z.object({ status: z.enum(["OPEN", "IGNORED"]).optional() }) }, async ({ ctx, query }) =>
  listSubscriptionCandidates(ctx, { status: query.status }),
);
