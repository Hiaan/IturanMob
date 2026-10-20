import { authed } from "@/server/api/handler";
import { boletoBillSchema, createBillFromBoleto } from "@/server/modules/bills/service";

/**
 * POST { line, description?, amountCents?, dueDate?, categoryId?, accountId?, notes? } → conta a pagar
 * do boleto. Valor e vencimento do código prevalecem; o mesmo boleto não é duplicado (`duplicate`).
 */
export const POST = authed({ body: boletoBillSchema, permission: "bills:write" }, async ({ ctx, body }) => createBillFromBoleto(ctx, body));
