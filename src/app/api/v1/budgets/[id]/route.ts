import { authed } from "@/server/api/handler";
import { budgetUpdateSchema, deleteBudget, updateBudget } from "@/server/modules/budgets/service";

/** PATCH { limitCents } */
export const PATCH = authed({ body: budgetUpdateSchema, permission: "budgets:write" }, async ({ ctx, params, body }) => updateBudget(ctx, params.id!, body));

export const DELETE = authed({ permission: "budgets:write" }, async ({ ctx, params }) => {
  await deleteBudget(ctx, params.id!);
  return { ok: true };
});
