import { z } from "zod";
import { authed } from "@/server/api/handler";
import { expensesByCategory } from "@/server/modules/analytics/service";
import { filtersFromQuery, periodFromQuery, periodQuerySchema } from "@/server/api/period";

export const GET = authed({ query: periodQuerySchema.extend({ type: z.enum(["EXPENSE", "INCOME"]).optional() }) }, async ({ ctx, query }) =>
  expensesByCategory(ctx, { period: periodFromQuery(query, ctx.timezone), regime: query.regime, filters: filtersFromQuery(query), type: query.type }),
);
