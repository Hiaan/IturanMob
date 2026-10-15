import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { createGoal, goalCreateSchema, listGoals } from "@/server/modules/goals/service";

const query = z.object({
  status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
  includeArchived: qs.bool(),
});

/** GET ?status=&includeArchived= → metas com progresso e totais. */
export const GET = authed({ query }, async ({ ctx, query }) => listGoals(ctx, query));

/** POST { name, targetCents, deadline?, accountId?, color?, icon?, notes? } */
export const POST = authed({ body: goalCreateSchema, permission: "goals:write" }, async ({ ctx, body }) => createGoal(ctx, body));
