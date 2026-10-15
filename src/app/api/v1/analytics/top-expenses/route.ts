import { authed, qs } from "@/server/api/handler";
import { topExpenses } from "@/server/modules/analytics/service";
import { filtersFromQuery, periodFromQuery, periodQuerySchema } from "@/server/api/period";

export const GET = authed({ query: periodQuerySchema.extend({ limit: qs.int(10) }) }, async ({ ctx, query }) =>
  topExpenses(ctx, { period: periodFromQuery(query, ctx.timezone), regime: query.regime, filters: filtersFromQuery(query), limit: Math.min(query.limit, 50) }),
);
