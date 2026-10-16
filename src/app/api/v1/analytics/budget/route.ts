import { z } from "zod";
import { authed } from "@/server/api/handler";
import { budgetOverview } from "@/server/modules/analytics/service";
import { isMonthKey, monthKey, todayISO } from "@/lib/dates";

export const GET = authed(
  { query: z.object({ month: z.string().refine(isMonthKey).optional(), regime: z.enum(["ACCRUAL", "CASH"]).optional(), scope: z.enum(["PERSONAL", "BUSINESS", "ALL"]).optional() }) },
  async ({ ctx, query }) => budgetOverview(ctx, query.month ?? monthKey(todayISO(ctx.timezone)), query.regime, query.scope),
);
