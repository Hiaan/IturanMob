import { z } from "zod";
import { authed } from "@/server/api/handler";
import { budgetHistory, monthKeySchema } from "@/server/modules/budgets/service";

const query = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
  endMonth: monthKeySchema.optional(),
  categoryId: z.string().min(1).max(64).optional(),
  regime: z.enum(["ACCRUAL", "CASH"]).optional(),
});

/** GET ?months=6&endMonth=AAAA-MM&categoryId=&regime= → limite × realizado por categoria e mês. */
export const GET = authed({ query }, async ({ ctx, query }) => budgetHistory(ctx, query));
