import { authed } from "@/server/api/handler";
import { importReviewSchema, reviewImportRows } from "@/server/modules/imports/service";

/** Confirmar fatura: importar ou não cada compra nova. { rows: [{ rowId, decision: IMPORT|SKIP }] } */
export const POST = authed({ body: importReviewSchema, permission: "data:import" }, async ({ ctx, params, body }) => reviewImportRows(ctx, params.id!, body));
