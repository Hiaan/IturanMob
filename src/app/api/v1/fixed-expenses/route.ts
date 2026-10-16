import { authed } from "@/server/api/handler";
import { fixedExpensesOverview, fixedExpensesQuerySchema } from "@/server/modules/fixed-expenses/service";

/** Gastos fixos: recorrências, parcelas em andamento e projeção mês a mês. ?scope=&months= */
export const GET = authed({ query: fixedExpensesQuerySchema, permission: "transactions:read" }, async ({ ctx, query }) => fixedExpensesOverview(ctx, query));
