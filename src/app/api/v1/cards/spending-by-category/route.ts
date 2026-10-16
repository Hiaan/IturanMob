import { authed } from "@/server/api/handler";
import { cardsSpendingByCategory } from "@/server/modules/cards/service";

/** Gastos por categoria da fatura atual e da anterior de cada cartão, e a soma de todos. */
export const GET = authed({ permission: "transactions:read" }, async ({ ctx }) => cardsSpendingByCategory(ctx));
