import { authed } from "@/server/api/handler";
import { restoreTransaction } from "@/server/modules/transactions/service";

export const POST = authed({ permission: "transactions:delete" }, async ({ ctx, params }) => restoreTransaction(ctx, params.id!));
