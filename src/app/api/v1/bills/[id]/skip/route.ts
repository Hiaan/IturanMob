import { authed } from "@/server/api/handler";
import { skipBill } from "@/server/modules/bills/service";

/** POST → ignora esta ocorrência (sem transação). */
export const POST = authed({ permission: "bills:write" }, async ({ ctx, params }) => skipBill(ctx, params.id!));
