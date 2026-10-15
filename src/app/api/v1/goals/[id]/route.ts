import { authed } from "@/server/api/handler";
import { deleteGoal, getGoal, goalUpdateSchema, updateGoal } from "@/server/modules/goals/service";

export const GET = authed({}, async ({ ctx, params }) => getGoal(ctx, params.id!));

/** PATCH { name?, targetCents?, deadline?, accountId?, color?, icon?, notes?, status? } */
export const PATCH = authed({ body: goalUpdateSchema, permission: "goals:write" }, async ({ ctx, params, body }) => updateGoal(ctx, params.id!, body));

export const DELETE = authed({ permission: "goals:write" }, async ({ ctx, params }) => {
  await deleteGoal(ctx, params.id!);
  return { ok: true };
});
