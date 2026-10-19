import { authed } from "@/server/api/handler";
import { requestMigrationPreview } from "@/server/modules/migration/service";

/** Gera a prévia em segundo plano (um lote por conta/cartão). */
export const POST = authed({ permission: "data:import" }, async ({ ctx, params }) => requestMigrationPreview(ctx, params.id!));
