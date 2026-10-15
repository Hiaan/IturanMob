import { splitEvenly } from "@/lib/money";
import { addMonths, daysInMonth, makeISO, monthKey, type ISODate, type MonthKey } from "@/lib/dates";

/**
 * Regras de faturamento de cartão de crédito (funções puras).
 *
 * - Fechamento: no "dia de fechamento" do mês (ajustado ao último dia quando o mês é mais curto).
 * - Compras feitas ANTES do dia de fechamento entram na fatura que fecha naquele mês;
 *   compras feitas NO dia de fechamento ou depois entram na fatura seguinte
 *   (o dia de fechamento é o "melhor dia de compra").
 * - Vencimento: se o dia de vencimento é maior que o de fechamento, vence no mesmo mês do
 *   fechamento; caso contrário, no mês seguinte.
 * - Mês de referência da fatura = mês do vencimento (ex.: "fatura de novembro").
 * - Parcela k (1..N) cai na k-ésima fatura a partir da fatura da compra.
 * - O resto da divisão em centavos fica na primeira parcela.
 */

export interface CardBillingConfig {
  closingDay: number;
  dueDay: number;
}

export interface StatementPeriod {
  referenceMonth: MonthKey;
  closingDate: ISODate;
  dueDate: ISODate;
}

function clampDay(year: number, month: number, day: number): ISODate {
  return makeISO(year, month, Math.min(day, daysInMonth(year, month)));
}

/** Fatura cujo fechamento ocorre no mês (ano, mês) informado. */
export function statementForClosingMonth(year: number, month: number, card: CardBillingConfig): StatementPeriod {
  const closingDate = clampDay(year, month, card.closingDay);
  const dueBase = card.dueDay > card.closingDay ? `${makeISO(year, month, 1)}` : addMonths(makeISO(year, month, 1), 1);
  const [dy, dm] = dueBase.split("-").map(Number) as [number, number];
  const dueDate = clampDay(dy, dm, card.dueDay);
  return { referenceMonth: monthKey(dueDate), closingDate, dueDate };
}

/** Fatura em que uma compra feita na data informada é lançada. */
export function statementForPurchase(purchaseDate: ISODate, card: CardBillingConfig): StatementPeriod {
  const [y, m] = purchaseDate.split("-").map(Number) as [number, number];
  const thisMonth = statementForClosingMonth(y, m, card);
  if (purchaseDate < thisMonth.closingDate) return thisMonth;
  const next = addMonths(makeISO(y, m, 1), 1);
  const [ny, nm] = next.split("-").map(Number) as [number, number];
  return statementForClosingMonth(ny, nm, card);
}

/** Fatura N meses após a fatura informada. */
export function shiftStatement(period: StatementPeriod, months: number, card: CardBillingConfig): StatementPeriod {
  const closingMonthStart = addMonths(`${period.closingDate.slice(0, 7)}-01`, months);
  const [y, m] = closingMonthStart.split("-").map(Number) as [number, number];
  return statementForClosingMonth(y, m, card);
}

/** Fatura cujo mês de referência (mês de vencimento) é o informado. */
export function statementForReferenceMonth(referenceMonth: MonthKey, card: CardBillingConfig): StatementPeriod {
  // O fechamento ocorre no mesmo mês do vencimento (dueDay > closingDay) ou no mês anterior.
  const refStart = `${referenceMonth}-01`;
  const closingMonth = card.dueDay > card.closingDay ? refStart : addMonths(refStart, -1);
  const [y, m] = closingMonth.split("-").map(Number) as [number, number];
  return statementForClosingMonth(y, m, card);
}

export interface InstallmentPlanItem extends StatementPeriod {
  number: number;
  totalInstallments: number;
  amountCents: number;
}

/** Plano de parcelas de uma compra no crédito. */
export function buildInstallmentPlan(
  totalCents: number,
  installments: number,
  purchaseDate: ISODate,
  card: CardBillingConfig,
): InstallmentPlanItem[] {
  if (!Number.isInteger(installments) || installments < 1 || installments > 72) {
    throw new Error("Quantidade de parcelas inválida");
  }
  const amounts = splitEvenly(totalCents, installments);
  const first = statementForPurchase(purchaseDate, card);
  return amounts.map((amountCents, i) => ({
    ...shiftStatement(first, i, card),
    number: i + 1,
    totalInstallments: installments,
    amountCents,
  }));
}

export type StatementStatus = "FUTURE" | "OPEN" | "CLOSED" | "PAID" | "PARTIAL" | "OVERDUE";

/** Status derivado da fatura a partir das datas e dos valores. */
export function statementStatus(params: {
  today: ISODate;
  closingDate: ISODate;
  dueDate: ISODate;
  totalCents: number;
  paidCents: number;
  isCurrent?: boolean;
}): StatementStatus {
  const { today, closingDate, dueDate, totalCents, paidCents } = params;
  if (totalCents > 0 && paidCents >= totalCents) return "PAID";
  if (today < closingDate) {
    return params.isCurrent ? "OPEN" : "FUTURE";
  }
  if (totalCents <= 0) return "PAID";
  if (today > dueDate) return paidCents > 0 ? "PARTIAL" : "OVERDUE";
  return paidCents > 0 ? "PARTIAL" : "CLOSED";
}
