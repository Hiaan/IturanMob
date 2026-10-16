import { authed } from "@/server/api/handler";
import { importRowsTransferSchema, setImportRowsTransfer } from "@/server/modules/imports/service";

/** Marca linhas da prévia como transferência entre contas próprias (ou desfaz com transferAccountId: null). */
export const POST = authed({ body: importRowsTransferSchema, permission: "data:import" }, async ({ ctx, params, body }) => setImportRowsTransfer(ctx, params.id!, body));
