import { authed } from "@/server/api/handler";
import { discardMigration } from "@/server/modules/migration/service";

/** Descarta a migração antes de importar. */
export const POST = authed({ permission: "data:import" }, async ({ ctx, params }) => discardMigration(ctx, params.id!));
