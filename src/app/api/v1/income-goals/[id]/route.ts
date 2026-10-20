import { authed } from "@/server/api/handler";
import { deleteIncomeGoal, incomeGoalUpdateSchema, updateIncomeGoal } from "@/server/modules/income-goals/service";

/** PATCH { scope?, categoryId?, targetCents?, alertThresholds?, active? } */
export const PATCH = authed({ body: incomeGoalUpdateSchema, permission: "goals:write" }, async ({ ctx, params, body }) => updateIncomeGoal(ctx, params.id!, body));

export const DELETE = authed({ permission: "goals:write" }, async ({ ctx, params }) => {
  await deleteIncomeGoal(ctx, params.id!);
  return { deleted: true };
});
