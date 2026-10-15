import { z } from "zod";
import { authed } from "@/server/api/handler";
import { applyRuleRetroactively } from "@/server/modules/categories/service";

export const POST = authed({ body: z.object({ onlyUncategorized: z.boolean().default(true) }), permission: "transactions:write" }, async ({ ctx, params, body }) =>
  applyRuleRetroactively(ctx, params.id!, body),
);
