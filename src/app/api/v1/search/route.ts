import { z } from "zod";
import { authed } from "@/server/api/handler";
import { prisma } from "@/server/db";
import { listTransactions } from "@/server/modules/transactions/service";
import { visibleAccountWhere, visibleCardWhere } from "@/server/modules/visibility/scope";

/** Busca global: transações, contas, cartões, categorias e metas. */
export const GET = authed({ query: z.object({ term: z.string().trim().min(1).max(80) }) }, async ({ ctx, query }) => {
  const term = query.term;
  const [tx, accounts, cards, categories, goals] = await Promise.all([
    listTransactions(ctx, { search: term, pageSize: 8 }),
    prisma.account.findMany({ where: { ...visibleAccountWhere(ctx), name: { contains: term, mode: "insensitive" } }, take: 5, select: { id: true, name: true, color: true } }),
    prisma.creditCard.findMany({ where: { ...visibleCardWhere(ctx), name: { contains: term, mode: "insensitive" } }, take: 5, select: { id: true, name: true, color: true } }),
    prisma.category.findMany({
      where: { householdId: ctx.householdId, archivedAt: null, OR: [{ name: { contains: term, mode: "insensitive" } }, { subcategories: { some: { name: { contains: term, mode: "insensitive" } } } }] },
      take: 5,
      select: { id: true, name: true, color: true, kind: true },
    }),
    prisma.financialGoal.findMany({ where: { householdId: ctx.householdId, name: { contains: term, mode: "insensitive" } }, take: 5, select: { id: true, name: true, color: true } }),
  ]);
  return { transactions: tx.items, accounts, cards, categories, goals };
});
