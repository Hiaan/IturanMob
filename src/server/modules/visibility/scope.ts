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

/**
 * Filtro Prisma para transações visíveis (seguro para NULL — "NOT IN" com coluna nula
 * resultaria em NULL e ocultaria lançamentos sem conta/cartão).
 * Visível quando: não movimenta conta, ou movimenta ao menos uma conta visível;
 * e não é despesa em cartão oculto.
 */
export function visibleTransactionWhere(scope: VisibilityScope): Prisma.TransactionWhereInput {
  const conds: Prisma.TransactionWhereInput[] = [];
  if (scope.hiddenAccountIds.length) {
    const hidden = scope.hiddenAccountIds;
    conds.push({
      OR: [{ accountId: null, destinationAccountId: null }, { accountId: { notIn: hidden } }, { destinationAccountId: { notIn: hidden } }],
    });
  }
  if (scope.hiddenCardIds.length) {
    conds.push({ OR: [{ creditCardId: null }, { creditCardId: { notIn: scope.hiddenCardIds } }, { type: { not: "EXPENSE" } }] });
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
      Prisma.sql`((${a}."accountId" IS NULL AND ${a}."destinationAccountId" IS NULL) OR (${a}."accountId" IS NOT NULL AND ${a}."accountId" NOT IN (${hidden})) OR (${a}."destinationAccountId" IS NOT NULL AND ${a}."destinationAccountId" NOT IN (${hidden})))`,
    );
  }
  if (scope.hiddenCardIds.length) {
    const hiddenCards = Prisma.join(scope.hiddenCardIds);
    parts.push(Prisma.sql`(${a}."creditCardId" IS NULL OR ${a}."creditCardId" NOT IN (${hiddenCards}) OR ${a}."type" <> 'EXPENSE')`);
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
