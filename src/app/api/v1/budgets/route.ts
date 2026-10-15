import { authed } from "@/server/api/handler";
import { budgetListSchema, budgetUpsertSchema, listBudgets, upsertBudget } from "@/server/modules/budgets/service";

/** GET ?month=AAAA-MM&regime=ACCRUAL|CASH → orçamentos do mês com realizado, alertas e categorias sem orçamento. */
export const GET = authed({ query: budgetListSchema }, async ({ ctx, query }) => listBudgets(ctx, query));

/** POST { categoryId, month, limitCents } → cria ou atualiza o limite da categoria no mês. */
export const POST = authed({ body: budgetUpsertSchema, permission: "budgets:write" }, async ({ ctx, body }) => upsertBudget(ctx, body));
