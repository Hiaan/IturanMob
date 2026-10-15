import { authed } from "@/server/api/handler";
import { compareCategories } from "@/server/modules/analytics/service";
import { periodFromQuery, periodQuerySchema } from "@/server/api/period";

export const GET = authed({ query: periodQuerySchema }, async ({ ctx, query }) =>
  compareCategories(ctx, { current: periodFromQuery(query, ctx.timezone), regime: query.regime }),
);
