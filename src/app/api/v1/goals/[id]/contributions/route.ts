import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { contributeToGoal, contributionSchema, listContributions } from "@/server/modules/goals/service";

const query = z.object({
  includeDeleted: qs.bool(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(64).optional(),
});

/** GET ?includeDeleted=&limit=&cursor= → histórico de contribuições e resgates. */
export const GET = authed({ query }, async ({ ctx, params, query }) => listContributions(ctx, params.id!, query));

/**
 * POST { amountCents (negativo = resgate), date?, fromAccountId?, note? }
 * Com fromAccountId diferente da conta da meta → transferência; caso contrário → alocação interna.
 */
export const POST = authed({ body: contributionSchema.omit({ sourceMessageId: true }), permission: "goals:write" }, async ({ ctx, params, body }) =>
  contributeToGoal(ctx, params.id!, body),
);
