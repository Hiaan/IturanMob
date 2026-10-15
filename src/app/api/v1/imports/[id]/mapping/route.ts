import { authed } from "@/server/api/handler";
import { importMappingUpdateSchema, previewMapping } from "@/server/modules/imports/service";

/** Reprocessa a prévia: { mapping?, headerRowIndex?, invertSigns? } */
export const POST = authed({ body: importMappingUpdateSchema, permission: "data:import" }, async ({ ctx, params, body }) => previewMapping(ctx, params.id!, body));
