import { authed } from "@/server/api/handler";
import { billUpdateSchema, getBill, updateBill } from "@/server/modules/bills/service";

export const GET = authed({}, async ({ ctx, params }) => getBill(ctx, params.id!));

/** PATCH { description?, amountCents?, isEstimate?, dueDate?, categoryId?, accountId?, creditCardId?, notes?, status?: "PENDING" (reabrir) } */
export const PATCH = authed({ body: billUpdateSchema, permission: "bills:write" }, async ({ ctx, params, body }) => updateBill(ctx, params.id!, body));
