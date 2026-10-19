import { authed } from "@/server/api/handler";
import { optionsPatchSchema, updateMigrationOptions } from "@/server/modules/migration/service";

export const PATCH = authed({ body: optionsPatchSchema, permission: "data:import" }, async ({ ctx, params, body }) => updateMigrationOptions(ctx, params.id!, body));
