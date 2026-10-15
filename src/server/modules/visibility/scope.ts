import { Prisma } from "@prisma/client";
import type { Db } from "../../db";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";

/**
 * Escopo de visibilidade: contas e cartões PRIVADOS só são visíveis ao titular
 * (ou a membros com permissão explícita "canViewOthersPrivate").
 * Uma transação é ocultada quando todas as contas/cartões que ela movimenta estão ocultos.
 */
export interface VisibilityScope {
  hiddenAccountIds: string[];
  hiddenCardIds: string[];
}

export async function getVisibilityScope(ctx: ServiceContext, db: Db = prisma): Promise<VisibilityScope> {
  if (ctx.canViewOthersPrivate || !ctx.memberId) return { hiddenAccountIds: [], hiddenCardIds: [] };
  const [accounts, cards] = await Promise.all([
    db.account.findMany({
      where: {
        householdId: ctx.householdId,
        visibility: "PRIVATE",
        OR: [{ ownerMemberId: null }, { ownerMemberId: { not: ctx.memberId } }],
      },
      select: { id: true },
    }),
    db.creditCard.findMany({
      where: {
        householdId: ctx.householdId,
        visibility: "PRIVATE",
        OR: [{ holderMemberId: null }, { holderMemberId: { not: ctx.memberId } }],
      },
      select: { id: true },
    }),
  ]);
  return { hiddenAccountIds: accounts.map((a) => a.id), hiddenCardIds: cards.map((c) => c.id) };
}

/** Filtro Prisma para transações visíveis. */
export function visibleTransactionWhere(scope: VisibilityScope): Prisma.TransactionWhereInput {
  const conds: Prisma.TransactionWhereInput[] = [];
  if (scope.hiddenAccountIds.length) {
    const hidden = scope.hiddenAccountIds;
    // Oculta se a conta de origem está oculta E (não há destino OU o destino também está oculto).
    conds.push({
      NOT: {
        AND: [
          { accountId: { in: hidden } },
          { OR: [{ destinationAccountId: null }, { destinationAccountId: { in: hidden } }] },
        ],
      },
    });
    conds.push({ NOT: { AND: [{ accountId: null }, { destinationAccountId: { in: hidden } }] } });
  }
  if (scope.hiddenCardIds.length) {
    conds.push({ NOT: { AND: [{ creditCardId: { in: scope.hiddenCardIds } }, { type: "EXPENSE" }] } });
  }
  return conds.length ? { AND: conds } : {};
}

/** Fragmento SQL equivalente (para agregações em SQL). Alias padrão "t". */
export function visibleTransactionSql(scope: VisibilityScope, alias = "t"): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  const a = Prisma.raw(`"${alias}"`);
  if (scope.hiddenAccountIds.length) {
    const hidden = Prisma.join(scope.hiddenAccountIds);
    parts.push(
      Prisma.sql`NOT (${a}."accountId" IN (${hidden}) AND (${a}."destinationAccountId" IS NULL OR ${a}."destinationAccountId" IN (${hidden})))`,
    );
    parts.push(Prisma.sql`NOT (${a}."accountId" IS NULL AND ${a}."destinationAccountId" IS NOT NULL AND ${a}."destinationAccountId" IN (${hidden}))`);
  }
  if (scope.hiddenCardIds.length) {
    const hiddenCards = Prisma.join(scope.hiddenCardIds);
    parts.push(Prisma.sql`NOT (${a}."type" = 'EXPENSE' AND ${a}."creditCardId" IS NOT NULL AND ${a}."creditCardId" IN (${hiddenCards}))`);
  }
  if (!parts.length) return Prisma.sql`TRUE`;
  return Prisma.join(parts, " AND ");
}

export function visibleAccountWhere(ctx: ServiceContext): Prisma.AccountWhereInput {
  if (ctx.canViewOthersPrivate || !ctx.memberId) return { householdId: ctx.householdId };
  return { householdId: ctx.householdId, OR: [{ visibility: "SHARED" }, { ownerMemberId: ctx.memberId }] };
}

export function visibleCardWhere(ctx: ServiceContext): Prisma.CreditCardWhereInput {
  if (ctx.canViewOthersPrivate || !ctx.memberId) return { householdId: ctx.householdId };
  return { householdId: ctx.householdId, OR: [{ visibility: "SHARED" }, { holderMemberId: ctx.memberId }] };
}
