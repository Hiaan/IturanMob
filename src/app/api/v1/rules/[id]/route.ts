import { authed } from "@/server/api/handler";
import { deleteRule, ruleSchema, updateRule } from "@/server/modules/categories/service";

export const PATCH = authed({ body: ruleSchema.partial(), permission: "rules:write" }, async ({ ctx, params, body }) => updateRule(ctx, params.id!, body));
export const DELETE = authed({ permission: "rules:write" }, async ({ ctx, params }) => {
  await deleteRule(ctx, params.id!);
  return { ok: true };
});
