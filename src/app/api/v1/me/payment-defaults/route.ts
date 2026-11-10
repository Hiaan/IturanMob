import { authed } from "@/server/api/handler";
import { getPaymentDefaults, paymentDefaultsSchema, setPaymentDefaults } from "@/server/modules/members/payment-defaults";

/** Conta e forma de pagamento padrão de quem está logado (usadas quando o gasto não diz de onde saiu). */
export const GET = authed({}, async ({ ctx }) => getPaymentDefaults(ctx));
export const PUT = authed({ body: paymentDefaultsSchema }, async ({ ctx, body }) => setPaymentDefaults(ctx, body));
