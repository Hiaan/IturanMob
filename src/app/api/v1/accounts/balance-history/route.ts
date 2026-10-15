import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { balanceHistory } from "@/server/modules/accounts/service";
import { periodFromQuery, periodQuerySchema } from "@/server/api/period";

export const GET = authed({ query: periodQuerySchema.extend({ accountIds: qs.list(z.string()) }) }, async ({ ctx, query }) => {
  const period = periodFromQuery(query, ctx.timezone);
  return balanceHistory(ctx, { ...period, accountIds: query.accountIds });
});
