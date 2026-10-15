import { authed } from "@/server/api/handler";
import { budgetCopySchema, copyPreviousMonth } from "@/server/modules/budgets/service";

/** POST { month } → copia os orçamentos do mês anterior sem sobrescrever os existentes. */
export const POST = authed({ body: budgetCopySchema, permission: "budgets:write" }, async ({ ctx, body }) => copyPreviousMonth(ctx, body));
