import { authed } from "@/server/api/handler";
import { aiSuggestMigration } from "@/server/modules/migration/service";

/** Sugestões de categoria pela IA configurada: só os nomes distintos saem do servidor. */
export const POST = authed({ permission: "data:import", rateLimit: { key: "migrations:ai", limit: 6, windowSeconds: 60 } }, async ({ ctx, params }) => aiSuggestMigration(ctx, params.id!));
