import { authed } from "@/server/api/handler";
import { unusualExpenses } from "@/server/modules/analytics/service";
import { periodFromQuery, periodQuerySchema } from "@/server/api/period";

export const GET = authed({ query: periodQuerySchema }, async ({ ctx, query }) => unusualExpenses(ctx, { period: periodFromQuery(query, ctx.timezone), scope: query.scope }));
