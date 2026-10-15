import { authed } from "@/server/api/handler";
import { confirmTransaction } from "@/server/modules/transactions/service";

export const POST = authed({ permission: "transactions:write" }, async ({ ctx, params }) => confirmTransaction(ctx, params.id!));
