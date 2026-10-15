import { authed } from "@/server/api/handler";
import { expensesByPerson } from "@/server/modules/analytics/service";
import { filtersFromQuery, periodFromQuery, periodQuerySchema } from "@/server/api/period";

export const GET = authed({ query: periodQuerySchema }, async ({ ctx, query }) =>
  expensesByPerson(ctx, { period: periodFromQuery(query, ctx.timezone), regime: query.regime, filters: filtersFromQuery(query) }),
);
