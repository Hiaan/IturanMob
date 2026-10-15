import { authed } from "@/server/api/handler";
import { budgetBulkSchema, setBudgetsBulk } from "@/server/modules/budgets/service";

/** POST { month, items: [{ categoryId, limitCents | null }] } — limite nulo/zero remove o orçamento. */
export const POST = authed({ body: budgetBulkSchema, permission: "budgets:write" }, async ({ ctx, body }) => setBudgetsBulk(ctx, body));
