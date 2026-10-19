import { authed } from "@/server/api/handler";
import { requestMigrationCommit } from "@/server/modules/migration/service";

/** Importa tudo em segundo plano. */
export const POST = authed({ permission: "data:import" }, async ({ ctx, params }) => requestMigrationCommit(ctx, params.id!));
