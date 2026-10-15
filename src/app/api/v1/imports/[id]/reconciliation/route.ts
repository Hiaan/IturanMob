import { authed } from "@/server/api/handler";
import { getReconciliation } from "@/server/modules/imports/service";

export const GET = authed({ permission: "transactions:read" }, async ({ ctx, params }) => getReconciliation(ctx, params.id!));
