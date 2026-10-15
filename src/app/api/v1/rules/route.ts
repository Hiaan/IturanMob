import { authed } from "@/server/api/handler";
import { createRule, listRules, ruleSchema } from "@/server/modules/categories/service";

export const GET = authed({}, async ({ ctx }) => listRules(ctx));
export const POST = authed({ body: ruleSchema, permission: "rules:write" }, async ({ ctx, body }) => createRule(ctx, body));
