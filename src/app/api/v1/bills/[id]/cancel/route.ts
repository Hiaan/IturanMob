import { authed } from "@/server/api/handler";
import { cancelBill } from "@/server/modules/bills/service";

/** POST → cancela a conta prevista (sem transação). */
export const POST = authed({ permission: "bills:write" }, async ({ ctx, params }) => cancelBill(ctx, params.id!));
