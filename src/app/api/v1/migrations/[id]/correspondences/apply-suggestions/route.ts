import { authed } from "@/server/api/handler";
import { applyMigrationSuggestions, applySuggestionsSchema } from "@/server/modules/migration/service";

/** Aceita as sugestões dos itens ainda sem decisão ({ fields? } limita aos campos indicados). */
export const POST = authed({ body: applySuggestionsSchema, permission: "data:import" }, async ({ ctx, params, body }) => applyMigrationSuggestions(ctx, params.id!, body));
