import { authed } from "@/server/api/handler";
import { billPaySchema, markPaid, undoPayment } from "@/server/modules/bills/service";

/** POST { date?, accountId?, creditCardId?, amountCents?, paymentMethod?, notes? } → registra o pagamento (cria a transação). */
export const POST = authed({ body: billPaySchema, permission: "bills:write" }, async ({ ctx, params, body }) => markPaid(ctx, params.id!, body));

/** DELETE → desfaz o pagamento (exclui a transação vinculada; a conta volta a ficar prevista). */
export const DELETE = authed({ permission: "transactions:delete" }, async ({ ctx, params }) => undoPayment(ctx, params.id!));
