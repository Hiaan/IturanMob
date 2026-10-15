import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { dashboardSummary } from "@/server/modules/analytics/service";
import { filtersFromQuery, periodFromQuery, periodQuerySchema } from "@/server/api/period";

export const GET = authed({ query: periodQuerySchema.extend({ accountIds: qs.list(z.string()) }) }, async ({ ctx, query }) =>
  dashboardSummary(ctx, { period: periodFromQuery(query, ctx.timezone), regime: query.regime, filters: filtersFromQuery(query), accountIds: query.accountIds }),
);
