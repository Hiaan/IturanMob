import { authed } from "@/server/api/handler";
import { importRowsUpdateSchema, updateImportRows } from "@/server/modules/imports/service";

/** { rows: [{ rowId, selected?, categoryId?, forceNew? }] } */
export const PATCH = authed({ body: importRowsUpdateSchema, permission: "data:import" }, async ({ ctx, params, body }) => updateImportRows(ctx, params.id!, body.rows));
