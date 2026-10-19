import { authed } from "@/server/api/handler";
import { correspondencesPatchSchema, updateMigrationCorrespondences } from "@/server/modules/migration/service";

/** { items: [{ field, key, decision: { action: "MAP", targetType, targetId } | { action: "CREATE", name, parentId?, kind } | { action: "IGNORE" } | null }] } */
export const PATCH = authed({ body: correspondencesPatchSchema, permission: "data:import" }, async ({ ctx, params, body }) => updateMigrationCorrespondences(ctx, params.id!, body));
