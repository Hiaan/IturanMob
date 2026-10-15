import type { Db } from "../../db";
import { dateToISO, isoToDate, todayISO, type ISODate } from "@/lib/dates";
import { statementForPurchase, statementForReferenceMonth, statementStatus, type CardBillingConfig, type StatementPeriod } from "./billing";

/** Cria (se necessário) a fatura do período informado. */
export async function ensureStatement(db: Db, householdId: string, creditCardId: string, period: StatementPeriod) {
  return db.creditCardStatement.upsert({
    where: { creditCardId_referenceMonth: { creditCardId, referenceMonth: period.referenceMonth } },
    update: {},
    create: {
      householdId,
      creditCardId,
      referenceMonth: period.referenceMonth,
      closingDate: isoToDate(period.closingDate),
      dueDate: isoToDate(period.dueDate),
    },
  });
}

export interface StatementTotals {
  id: string;
  creditCardId: string;
  referenceMonth: string;
  closingDate: ISODate;
  dueDate: ISODate;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  installmentsCount: number;
}

/** Totais das faturas de um cartão (parcelas e pagamentos efetivos). */
export async function statementTotals(db: Db, householdId: string, filter: { creditCardId?: string; statementIds?: string[] }): Promise<StatementTotals[]> {
  const statements = await db.creditCardStatement.findMany({
    where: {
      householdId,
      ...(filter.creditCardId ? { creditCardId: filter.creditCardId } : {}),
      ...(filter.statementIds ? { id: { in: filter.statementIds } } : {}),
    },
    orderBy: { dueDate: "asc" },
  });
  if (!statements.length) return [];
  const ids = statements.map((s) => s.id);
  const [inst, pays] = await Promise.all([
    db.installment.groupBy({ by: ["statementId"], where: { statementId: { in: ids } }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.transaction.groupBy({
      by: ["statementId"],
      where: { statementId: { in: ids }, type: "CARD_PAYMENT", status: "CONFIRMED", deletedAt: null },
      _sum: { amountCents: true },
    }),
  ]);
  const instMap = new Map(inst.map((i) => [i.statementId, { sum: i._sum.amountCents ?? 0, count: i._count._all }]));
  const payMap = new Map(pays.map((p) => [p.statementId, p._sum.amountCents ?? 0]));
  return statements.map((s) => {
    const total = instMap.get(s.id)?.sum ?? 0;
    const paid = payMap.get(s.id) ?? 0;
    return {
      id: s.id,
      creditCardId: s.creditCardId,
      referenceMonth: s.referenceMonth,
      closingDate: dateToISO(s.closingDate),
      dueDate: dateToISO(s.dueDate),
      totalCents: total,
      paidCents: paid,
      remainingCents: Math.max(0, total - paid),
      installmentsCount: instMap.get(s.id)?.count ?? 0,
    };
  });
}

/**
 * Escolhe a fatura a ser paga: a fatura fechada mais antiga com saldo em aberto;
 * se não houver, a fatura atual (pagamento antecipado).
 */
export async function resolvePaymentStatement(
  db: Db,
  householdId: string,
  card: { id: string } & CardBillingConfig,
  paymentDate: ISODate,
): Promise<StatementTotals> {
  const totals = await statementTotals(db, householdId, { creditCardId: card.id });
  const closedUnpaid = totals.filter((t) => t.closingDate <= paymentDate && t.remainingCents > 0);
  if (closedUnpaid.length) return closedUnpaid[0]!;
  const current = statementForPurchase(paymentDate, card);
  const existing = totals.find((t) => t.referenceMonth === current.referenceMonth);
  if (existing) return existing;
  const created = await ensureStatement(db, householdId, card.id, current);
  return {
    id: created.id,
    creditCardId: card.id,
    referenceMonth: created.referenceMonth,
    closingDate: dateToISO(created.closingDate),
    dueDate: dateToISO(created.dueDate),
    totalCents: 0,
    paidCents: 0,
    remainingCents: 0,
    installmentsCount: 0,
  };
}

export function withStatus(t: StatementTotals, today: ISODate, currentReferenceMonth?: string) {
  return {
    ...t,
    status: statementStatus({
      today,
      closingDate: t.closingDate,
      dueDate: t.dueDate,
      totalCents: t.totalCents,
      paidCents: t.paidCents,
      isCurrent: t.referenceMonth === currentReferenceMonth,
    }),
  };
}

export function currentStatementPeriod(card: CardBillingConfig, timezone: string): StatementPeriod {
  return statementForPurchase(todayISO(timezone), card);
}

export { statementForReferenceMonth };
