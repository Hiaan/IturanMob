import { authed } from "@/server/api/handler";
import { sheetsPatchSchema, updateMigrationSheets } from "@/server/modules/migration/service";

/** { sheets: [{ index, selected?, kind?, headerRowIndex?, columns?, month?, unsignedAs?, invertSigns?, matrixMode? }] } */
export const PATCH = authed({ body: sheetsPatchSchema, permission: "data:import" }, async ({ ctx, params, body }) => updateMigrationSheets(ctx, params.id!, body));
