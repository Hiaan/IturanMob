import { addMonths, daysInMonth, makeISO } from "@/lib/dates";

/**
 * Mês de referência (mês de vencimento) da fatura em que uma compra cai.
 * Mesma regra do servidor: compras a partir do dia de fechamento entram na fatura seguinte.
 */
export function purchaseReferenceMonth(purchaseDate: string, card: { closingDay: number; dueDay: number }): string {
  const forClosingMonth = (y: number, m: number) => {
    const closing = makeISO(y, m, Math.min(card.closingDay, daysInMonth(y, m)));
    const dueBase = card.dueDay > card.closingDay ? makeISO(y, m, 1) : addMonths(makeISO(y, m, 1), 1);
    return { closing, referenceMonth: dueBase.slice(0, 7) };
  };
  const [y, m] = purchaseDate.split("-").map(Number) as [number, number];
  const current = forClosingMonth(y, m);
  if (purchaseDate < current.closing) return current.referenceMonth;
  const next = addMonths(makeISO(y, m, 1), 1);
  const [ny, nm] = next.split("-").map(Number) as [number, number];
  return forClosingMonth(ny, nm).referenceMonth;
}

function monthIndex(key: string): number {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return y * 12 + (m - 1);
}

/**
 * Parcela que está na fatura atual do cartão ("3/10"), limitada a 1..N.
 * Retorna null para compras à vista ou sem dados do cartão.
 */
export function currentInstallmentLabel(
  tx: { date: string; installmentCount: number; installmentOffset?: number; creditCard: { id: string } | null },
  card: { closingDay: number; dueDay: number; currentStatement: { referenceMonth: string } } | undefined,
): { label: string; title: string } | null {
  if (tx.installmentCount <= 1) return null;
  const offset = tx.installmentOffset ?? 0;
  const total = tx.installmentCount + offset;
  if (!card || !tx.creditCard) return { label: `${total}x`, title: `Parcelado em ${total} vezes` };
  const first = purchaseReferenceMonth(tx.date, card);
  const n = monthIndex(card.currentStatement.referenceMonth) - monthIndex(first) + 1;
  const k = Math.max(1, Math.min(tx.installmentCount, n));
  const title =
    n < 1
      ? `Primeira de ${tx.installmentCount} parcelas cai em fatura futura`
      : n > tx.installmentCount
        ? `Todas as ${total} parcelas já foram faturadas`
        : `Parcela ${k + offset} de ${total} na fatura atual`;
  return { label: `${k + offset}/${total}`, title };
}

type PeriodTx = { date: string; amountCents: number; amountBrlCents: number | null; periodInstallment?: { amountCents: number; date: string } };

/** Data em que a linha aparece na lista por período: a da parcela (compra parcelada) ou a do lançamento. */
export function listDate(tx: PeriodTx): string {
  return tx.periodInstallment?.date ?? tx.date;
}

/** O valor que conta no período: a parcela (compra parcelada no cartão) ou o valor do lançamento. */
export function periodAmount<T extends PeriodTx>(tx: T): T {
  const p = tx.periodInstallment;
  if (!p) return tx;
  const brl = tx.amountBrlCents != null && tx.amountCents ? Math.round((p.amountCents * tx.amountBrlCents) / tx.amountCents) : tx.amountBrlCents;
  return { ...tx, amountCents: p.amountCents, amountBrlCents: brl };
}
