import { authed } from "@/server/api/handler";
import { resolveReviewRule, reviewRuleSchema } from "@/server/modules/imports/service";

/** Sugestão de regra "sempre não importar": { key, accept } (accept=false dispensa nesta importação). */
export const POST = authed({ body: reviewRuleSchema, permission: "data:import" }, async ({ ctx, params, body }) => resolveReviewRule(ctx, params.id!, body));
