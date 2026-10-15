import { authed } from "@/server/api/handler";
import { getImportPreview } from "@/server/modules/imports/service";

export const GET = authed({ permission: "transactions:read" }, async ({ ctx, params }) => getImportPreview(ctx, params.id!));
