import { z } from "zod";
import { authed } from "@/server/api/handler";
import { createIncomeGoal, incomeGoalSchema, listIncomeGoals } from "@/server/modules/income-goals/service";

const querySchema = z.object({ month: z.string().optional(), includeInactive: z.enum(["true", "false"]).transform((v) => v === "true").optional() });

/** GET ?month=AAAA-MM&includeInactive → metas de ganho com o progresso do mês (receita, %, falta, projeção). */
export const GET = authed({ query: querySchema }, async ({ ctx, query }) => listIncomeGoals(ctx, query));

/** POST { scope: ALL|PERSONAL|BUSINESS, categoryId?, targetCents, alertThresholds?, active? } */
export const POST = authed({ body: incomeGoalSchema, permission: "goals:write" }, async ({ ctx, body }) => createIncomeGoal(ctx, body));
