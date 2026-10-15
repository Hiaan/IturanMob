import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { cashflowProjection } from "@/server/modules/analytics/service";

export const GET = authed({ query: z.object({ days: qs.int(90) }) }, async ({ ctx, query }) => cashflowProjection(ctx, Math.min(Math.max(query.days, 7), 365)));
