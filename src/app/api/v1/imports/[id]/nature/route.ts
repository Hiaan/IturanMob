import { authed } from "@/server/api/handler";
import { importRowsNatureSchema, setImportRowsNature } from "@/server/modules/imports/service";

/** Natureza das linhas da prévia: { rowIds, nature: PERSONAL|BUSINESS|PASSTHROUGH|null, applyToSimilar? }. */
export const POST = authed({ body: importRowsNatureSchema, permission: "data:import" }, async ({ ctx, params, body }) => setImportRowsNature(ctx, params.id!, body));
