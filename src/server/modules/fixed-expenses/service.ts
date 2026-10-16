import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { addMonthsToKey, dateToISO, monthKey, monthRange, todayISO } from "@/lib/dates";
import { resolveScope, type ReportScopeValue } from "../analytics/service";
import { listRecurring } from "../recurring/service";
import { occurrencesBetween, type RecurrenceRule } from "../recurring/schedule";
import { getVisibilityScope, visibleTransactionWhere } from "../visibility/scope";

/**
 * Gastos fixos: contas recorrentes (aluguel, financiamento, assinaturas…), compras parceladas em
 * andamento nos cartões e a projeção mês a mês do que já está comprometido — quando cada
 * parcelamento acaba e quanto "libera" no mês seguinte.
 *
 * Respeita a natureza (Pessoal | Empresa | Tudo, padrão da família) e deixa Repasse de fora.
 * Só leitura: nada aqui altera saldo, fatura ou lançamentos.
 */

export const fixedExpensesQuerySchema = z.object({
  scope: z.enum(["PERSONAL", "BUSINESS", "ALL"]).optional(),
  months: z.coerce.number().int().min(1).max(24).default(12),
});

type Scope = ReportScopeValue;
const inScope = (scope: Scope, value: string) => scope === "ALL" || value === scope;

export interface FixedRecurringItem {
  id: string;
  description: string;
  amountCents: number;
  isEstimate: boolean;
  frequencyLabel: string;
  scheduleLabel: string;
  dayOfMonth: number | null;
  nextDueDate: string | null;
  monthlyEquivalentCents: number;
  scope: "PERSONAL" | "BUSINESS";
  category: { id: string; name: string; color: string } | null;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string } | null;
}

export interface InstallmentPlanItem {
  transactionId: string;
  description: string;
  purchaseDate: string;
  card: { id: string; name: string; color: string };
  category: { id: string; name: string; color: string } | null;
  scope: "PERSONAL" | "BUSINESS";
  totalAmountCents: number;
  installmentAmountCents: number;
  totalInstallments: number;
  /** Próxima parcela a vencer (a "atual"). */
  currentNumber: number;
  remainingCount: number;
  remainingCents: number;
  /** Mês (AAAA-MM) da última parcela. */
  endsMonth: string;
}

export async function fixedExpensesOverview(ctx: ServiceContext, raw: z.input<typeof fixedExpensesQuerySchema> = {}) {
  assertCan(ctx, "transactions:read");
  const q = fixedExpensesQuerySchema.parse(raw);
  const scope = await resolveScope(ctx, q.scope);
  const today = todayISO(ctx.timezone);
  const firstMonth = monthKey(today);
  const months = Array.from({ length: q.months }, (_, i) => addMonthsToKey(firstMonth, i));
  const horizonEnd = monthRange(months[months.length - 1]!).end;

  // a) Contas fixas: recorrências de despesa ativas.
  const recurring = (await listRecurring(ctx, { active: true, type: "EXPENSE" })).items.filter((r) => inScope(scope, r.scope));
  const recurringItems: FixedRecurringItem[] = recurring
    .map((r) => ({
      id: r.id,
      description: r.description,
      amountCents: r.amountCents,
      isEstimate: r.isVariableAmount,
      frequencyLabel: r.frequencyLabel,
      scheduleLabel: r.scheduleLabel,
      dayOfMonth: r.dayOfMonth,
      nextDueDate: r.nextOccurrence,
      monthlyEquivalentCents: r.monthlyEquivalentCents,
      scope: r.scope,
      category: r.category ? { id: r.category.id, name: r.category.name, color: r.category.color } : null,
      account: r.account ? { id: r.account.id, name: r.account.name } : null,
      creditCard: r.creditCard ? { id: r.creditCard.id, name: r.creditCard.name } : null,
    }))
    .sort((a, b) => (a.dayOfMonth ?? 99) - (b.dayOfMonth ?? 99) || a.description.localeCompare(b.description, "pt-BR"));
  const rules = new Map<string, RecurrenceRule>(
    recurring.map((r) => [r.id, { frequency: r.frequency as RecurrenceRule["frequency"], interval: r.interval, dayOfMonth: r.dayOfMonth, startDate: r.startDate, endDate: r.endDate }]),
  );

  // b) Parcelas do cartão: compras parceladas com parcelas a vencer (de hoje em diante).
  const vis = await getVisibilityScope(ctx);
  const where: Prisma.TransactionWhereInput = {
    householdId: ctx.householdId,
    type: "EXPENSE",
    status: "CONFIRMED",
    deletedAt: null,
    excludedFromReports: false,
    creditCardId: { not: null },
    installmentCount: { gt: 1 },
    ...(scope === "ALL" ? {} : { scope }),
    installments: { some: { dueDate: { gte: new Date(`${today}T00:00:00Z`) } } },
    ...visibleTransactionWhere(vis),
  };
  const purchases = await prisma.transaction.findMany({
    where,
    select: {
      id: true,
      description: true,
      date: true,
      amountCents: true,
      installmentCount: true,
      scope: true,
      creditCard: { select: { id: true, name: true, color: true } },
      category: { select: { id: true, name: true, color: true } },
      installments: { orderBy: { number: "asc" }, select: { number: true, amountCents: true, dueDate: true } },
    },
    take: 2000,
  });
  const installmentItems: InstallmentPlanItem[] = [];
  /** Parcelas a vencer por mês e cartão. */
  const dueByMonthCard = new Map<string, Map<string, number>>();
  /** Valor da parcela que deixa de existir depois do mês (último mês de cada compra). */
  const endingByMonth = new Map<string, { count: number; cents: number }>();
  for (const p of purchases) {
    if (!p.creditCard) continue;
    const future = p.installments.filter((i) => dateToISO(i.dueDate) >= today);
    if (!future.length) continue;
    const last = p.installments[p.installments.length - 1]!;
    const endsMonth = monthKey(dateToISO(last.dueDate));
    installmentItems.push({
      transactionId: p.id,
      description: p.description,
      purchaseDate: dateToISO(p.date),
      card: p.creditCard,
      category: p.category,
      scope: p.scope,
      totalAmountCents: p.amountCents,
      installmentAmountCents: future[0]!.amountCents,
      totalInstallments: p.installmentCount,
      currentNumber: future[0]!.number,
      remainingCount: future.length,
      remainingCents: future.reduce((s, i) => s + i.amountCents, 0),
      endsMonth,
    });
    for (const i of future) {
      const m = monthKey(dateToISO(i.dueDate));
      const byCard = dueByMonthCard.get(m) ?? new Map<string, number>();
      byCard.set(p.creditCard.id, (byCard.get(p.creditCard.id) ?? 0) + i.amountCents);
      dueByMonthCard.set(m, byCard);
    }
    const end = endingByMonth.get(endsMonth) ?? { count: 0, cents: 0 };
    endingByMonth.set(endsMonth, { count: end.count + 1, cents: end.cents + last.amountCents });
  }
  installmentItems.sort((a, b) => a.endsMonth.localeCompare(b.endsMonth) || a.card.name.localeCompare(b.card.name, "pt-BR") || b.remainingCents - a.remainingCents);

  const cardsById = new Map<string, { id: string; name: string; color: string }>();
  for (const i of installmentItems) cardsById.set(i.card.id, i.card);
  const byCard = [...cardsById.values()]
    .map((card) => {
      const items = installmentItems.filter((i) => i.card.id === card.id);
      return {
        card,
        count: items.length,
        remainingCents: items.reduce((s, i) => s + i.remainingCents, 0),
        // Soma das parcelas da próxima fatura de cada compra.
        nextInstallmentsCents: items.reduce((s, i) => s + i.installmentAmountCents, 0),
        endsMonth: items.reduce((m, i) => (i.endsMonth > m ? i.endsMonth : m), ""),
      };
    })
    .sort((a, b) => a.card.name.localeCompare(b.card.name, "pt-BR"));

  // c) Projeção mês a mês.
  const projection = months.map((m) => {
    const { start, end } = monthRange(m);
    let recurringCents = 0;
    let recurringOnCardCents = 0;
    for (const r of recurring) {
      const rule = rules.get(r.id)!;
      // O mês inteiro (inclusive o que já venceu no mês atual): é o compromisso do mês.
      const count = occurrencesBetween(rule, start, end > horizonEnd ? horizonEnd : end, 40).length;
      if (!count) continue;
      const cents = count * r.amountCents;
      if (r.creditCard) recurringOnCardCents += cents;
      else recurringCents += cents;
    }
    const cardMap = dueByMonthCard.get(m) ?? new Map<string, number>();
    const installmentsByCard = [...cardMap.entries()]
      .map(([cardId, amountCents]) => ({ cardId, cardName: cardsById.get(cardId)?.name ?? "Cartão", amountCents }))
      .sort((a, b) => a.cardName.localeCompare(b.cardName, "pt-BR"));
    const installmentsCents = installmentsByCard.reduce((s, c) => s + c.amountCents, 0);
    const ending = endingByMonth.get(m) ?? { count: 0, cents: 0 };
    return {
      month: m,
      recurringCents,
      recurringOnCardCents,
      installmentsByCard,
      installmentsCents,
      totalCents: recurringCents + recurringOnCardCents + installmentsCents,
      /** Parcelamentos que terminam neste mês e quanto deixam de pesar a partir do mês seguinte. */
      endingCount: ending.count,
      releasesNextMonthCents: ending.cents,
    };
  });

  return {
    scope,
    generatedAt: new Date().toISOString(),
    today,
    recurring: {
      items: recurringItems,
      monthlyTotalCents: recurringItems.reduce((s, r) => s + r.monthlyEquivalentCents, 0),
      estimatedCount: recurringItems.filter((r) => r.isEstimate).length,
    },
    installments: {
      items: installmentItems,
      byCard,
      totalRemainingCents: installmentItems.reduce((s, i) => s + i.remainingCents, 0),
      nextInstallmentsCents: installmentItems.reduce((s, i) => s + i.installmentAmountCents, 0),
    },
    projection,
    assumptions: [
      "Contas fixas: recorrências de despesa ativas (valor estimado quando a conta é variável).",
      "Parcelas: compras parceladas no cartão com parcelas a vencer, pela data de vencimento da fatura.",
      "Repasses de clientes ficam de fora; a natureza segue o recorte escolhido.",
      "Não inclui gastos do dia a dia ainda não lançados.",
    ],
  };
}
