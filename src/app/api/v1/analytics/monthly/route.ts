import { z } from "zod";
import { authed } from "@/server/api/handler";
import { monthlyIncomeExpense } from "@/server/modules/analytics/service";
import { filtersFromQuery, periodQuerySchema } from "@/server/api/period";
import { addMonthsToKey, isMonthKey, monthKey, todayISO } from "@/lib/dates";

export const GET = authed(
  { query: periodQuerySchema.extend({ startMonth: z.string().refine(isMonthKey).optional(), endMonth: z.string().refine(isMonthKey).optional() }) },
  async ({ ctx, query }) => {
    const endMonth = query.endMonth ?? monthKey(todayISO(ctx.timezone));
    const startMonth = query.startMonth ?? addMonthsToKey(endMonth, -11);
    return monthlyIncomeExpense(ctx, { startMonth, endMonth, regime: query.regime, filters: filtersFromQuery(query) });
  },
);
