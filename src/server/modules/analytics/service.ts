import { Prisma, type AccountingRegime } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import {
  addDays,
  addMonthsToKey,
  dateToISO,
  endOfMonth,
  isoToDate,
  monthKey,
  monthRange,
  monthsBetween,
  previousPeriod,
  startOfMonth,
  todayISO,
  type ISODate,
  type Period,
} from "@/lib/dates";
import { percentChange, percentOf, splitByWeights } from "@/lib/money";
import { getVisibilityScope, visibleTransactionSql } from "../visibility/scope";
import { listAccounts } from "../accounts/service";
import { listCards } from "../cards/service";
import { getSettings } from "../households/service";

/**
 * Reconhecimento de receitas e despesas por regime (documentado em docs/REGRAS_FINANCEIRAS.md):
 *
 * COMPETÊNCIA: transação confirmada, pelo valor total, na data de competência.
 * CAIXA: débito/Pix/dinheiro na data do pagamento; compras no cartão pelo valor de cada
 *        parcela, na data de vencimento da fatura. Pagamento de fatura e transferências
 *        nunca são despesas.
 */
export interface RecognizedRow {
  transactionId: string;
  type: "EXPENSE" | "INCOME";
  date: ISODate;
  amountCents: number;
  categoryId: string | null;
  subcategoryId: string | null;
  merchantId: string | null;
  description: string;
  paymentMethod: string | null;
  accountId: string | null;
  creditCardId: string | null;
  payerMemberId: string | null;
  responsibleMemberId: string | null;
  ownership: "SHARED" | "INDIVIDUAL";
  installmentNumber: number | null;
  installmentCount: number;
}

export interface AnalyticsFilters {
  memberId?: string | null;
  accountId?: string | null;
  creditCardId?: string | null;
  categoryIds?: string[] | null;
  /** Natureza: Pessoal, Empresa ou Tudo. Sem informar, vale o padrão da família. */
  scope?: "PERSONAL" | "BUSINESS" | "ALL" | null;
  /** Forma de pagamento (ex.: só cartão de crédito). */
  paymentMethod?: string | null;
}

export type ReportScopeValue = "PERSONAL" | "BUSINESS" | "ALL";

/** Recorte de natureza em uso (informado ou o padrão da família). */
export async function resolveScope(ctx: ServiceContext, scope?: ReportScopeValue | null): Promise<ReportScopeValue> {
  if (scope) return scope;
  if (ctx.reportScope) return ctx.reportScope;
  return (await getSettings(ctx.householdId)).defaultReportScope;
}

interface RawRow {
  transactionId: string;
  type: "EXPENSE" | "INCOME";
  rdate: Date;
  amount: number;
  categoryId: string | null;
  subcategoryId: string | null;
  merchantId: string | null;
  description: string;
  paymentMethod: string | null;
  accountId: string | null;
  creditCardId: string | null;
  payerMemberId: string | null;
  responsibleMemberId: string | null;
  ownership: "SHARED" | "INDIVIDUAL";
  installmentNumber: number | null;
  installmentCount: number;
}

function filterSql(f: AnalyticsFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (f.memberId) {
    parts.push(
      Prisma.sql`(t."payerMemberId" = ${f.memberId} OR t."responsibleMemberId" = ${f.memberId} OR EXISTS (SELECT 1 FROM "TransactionAllocation" a WHERE a."transactionId" = t.id AND a."memberId" = ${f.memberId}))`,
    );
  }
  if (f.accountId) parts.push(Prisma.sql`t."accountId" = ${f.accountId}`);
  if (f.creditCardId) parts.push(Prisma.sql`t."creditCardId" = ${f.creditCardId}`);
  if (f.paymentMethod) parts.push(Prisma.sql`t."paymentMethod"::text = ${f.paymentMethod}`);
  if (f.categoryIds?.length) parts.push(Prisma.sql`t."categoryId" IN (${Prisma.join(f.categoryIds)})`);
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

export async function recognizedRows(ctx: ServiceContext, period: Period, regime: AccountingRegime, filters: AnalyticsFilters = {}): Promise<RecognizedRow[]> {
  const scope = await getVisibilityScope(ctx);
  const vis = visibleTransactionSql(scope, "t");
  const extra = filterSql(filters);
  // Natureza: Pessoal / Empresa / Tudo (repasses ficam sempre de fora — ver `base`).
  const nature = await resolveScope(ctx, filters.scope);
  const scopeSql = nature === "ALL" ? Prisma.sql`TRUE` : Prisma.sql`t.scope = ${nature}::"TransactionScope"`;
  const start = isoToDate(period.start);
  const end = isoToDate(period.end);
  const cols = Prisma.sql`t.id AS "transactionId", t.type::text AS type, t."categoryId", t."subcategoryId", t."merchantId", t.description,
    t."paymentMethod"::text AS "paymentMethod", t."accountId", t."creditCardId", t."payerMemberId", t."responsibleMemberId",
    t.ownership::text AS ownership, t."installmentCount"`;
  // Receitas/despesas em moeda estrangeira entram em reais (PTAX da data); sem cotação ainda, ficam de fora.
  // Desconsiderados (repasse de cliente, reembolso) ficam fora de todo relatório — saldo e fatura não mudam.
  const base = Prisma.sql`t."householdId" = ${ctx.householdId} AND t.status = 'CONFIRMED' AND t."deletedAt" IS NULL AND t."excludedFromReports" = false AND ${scopeSql} AND ${vis} AND ${extra} AND (t.currency = 'BRL' OR t."amountBrlCents" IS NOT NULL)`;
  const amountBrl = Prisma.sql`(CASE WHEN t.currency = 'BRL' THEN t."amountCents" ELSE t."amountBrlCents" END)`;

  let rows: RawRow[];
  if (regime === "ACCRUAL") {
    rows = await prisma.$queryRaw<RawRow[]>`
      SELECT ${cols}, t."competenceDate" AS rdate, ${amountBrl} AS amount, NULL::int AS "installmentNumber"
      FROM "Transaction" t
      WHERE ${base} AND t.type IN ('EXPENSE', 'INCOME') AND t."competenceDate" BETWEEN ${start} AND ${end}`;
  } else {
    rows = await prisma.$queryRaw<RawRow[]>`
      SELECT ${cols}, t.date AS rdate, ${amountBrl} AS amount, NULL::int AS "installmentNumber"
      FROM "Transaction" t
      WHERE ${base} AND (t.type = 'INCOME' OR (t.type = 'EXPENSE' AND t."creditCardId" IS NULL)) AND t.date BETWEEN ${start} AND ${end}
      UNION ALL
      SELECT ${cols}, i."dueDate" AS rdate, i."amountCents" AS amount, i.number AS "installmentNumber"
      FROM "Installment" i JOIN "Transaction" t ON t.id = i."transactionId"
      WHERE ${base} AND t.type = 'EXPENSE' AND i."dueDate" BETWEEN ${start} AND ${end}`;
  }
  return rows.map((r) => ({
    transactionId: r.transactionId,
    type: r.type,
    date: dateToISO(r.rdate),
    amountCents: Number(r.amount),
    categoryId: r.categoryId,
    subcategoryId: r.subcategoryId,
    merchantId: r.merchantId,
    description: r.description,
    paymentMethod: r.paymentMethod,
    accountId: r.accountId,
    creditCardId: r.creditCardId,
    payerMemberId: r.payerMemberId,
    responsibleMemberId: r.responsibleMemberId,
    ownership: r.ownership,
    installmentNumber: r.installmentNumber,
    installmentCount: Number(r.installmentCount),
  }));
}

export async function resolveRegime(ctx: ServiceContext, regime?: AccountingRegime | null): Promise<AccountingRegime> {
  if (regime) return regime;
  return (await getSettings(ctx.householdId)).defaultRegime;
}

function sumBy(rows: RecognizedRow[], type: "EXPENSE" | "INCOME") {
  return rows.reduce((s, r) => (r.type === type ? s + r.amountCents : s), 0);
}

// -----------------------------------------------------------------------------
// Cards principais
// -----------------------------------------------------------------------------

export async function dashboardSummary(ctx: ServiceContext, params: { period: Period; regime?: AccountingRegime; filters?: AnalyticsFilters; accountIds?: string[] }) {
  const regime = await resolveRegime(ctx, params.regime);
  const today = todayISO(ctx.timezone);
  const monthEnd = endOfMonth(today);
  const [rows, prevRows, accounts, cards] = await Promise.all([
    recognizedRows(ctx, params.period, regime, params.filters),
    recognizedRows(ctx, previousPeriod(params.period), regime, params.filters),
    listAccounts(ctx),
    listCards(ctx),
  ]);

  const income = sumBy(rows, "INCOME");
  const expense = sumBy(rows, "EXPENSE");
  // Resultado da empresa (receitas − despesas de natureza Empresa) no mesmo período, se houver.
  const scope = await resolveScope(ctx, params.filters?.scope);
  const businessRows = scope === "BUSINESS" ? rows : await recognizedRows(ctx, params.period, regime, { ...params.filters, scope: "BUSINESS" });
  const businessIncome = sumBy(businessRows, "INCOME");
  const businessExpense = sumBy(businessRows, "EXPENSE");
  const prevIncome = sumBy(prevRows, "INCOME");
  const prevExpense = sumBy(prevRows, "EXPENSE");

  const selectedAccounts = accounts.filter((a) => a.includeInTotals && (!params.accountIds?.length || params.accountIds.includes(a.id)));
  // Totais em reais: contas em moeda estrangeira entram pela PTAX mais recente.
  const availableBalance = selectedAccounts.filter((a) => a.type !== "INVESTMENT").reduce((s, a) => s + (a.balanceBrlCents ?? 0), 0);
  const totalAssets = accounts.filter((a) => a.includeInTotals).reduce((s, a) => s + (a.balanceBrlCents ?? 0), 0);

  // Faturas futuras: saldo em aberto de faturas que ainda vão vencer (inclui parcelas futuras).
  let futureStatements = 0;
  let cardDebt = 0;
  let statementsDueThisMonth = 0;
  for (const card of cards) {
    cardDebt += card.outstandingCents;
  }
  const statementRows = await prisma.$queryRaw<Array<{ dueDate: Date; remaining: number }>>`
    SELECT s."dueDate", GREATEST(0, COALESCE(inst.total, 0) - COALESCE(pay.total, 0))::int AS remaining
    FROM "CreditCardStatement" s
    LEFT JOIN (SELECT "statementId", SUM("amountCents") AS total FROM "Installment" GROUP BY "statementId") inst ON inst."statementId" = s.id
    LEFT JOIN (SELECT "statementId", SUM("amountCents") AS total FROM "Transaction" WHERE type = 'CARD_PAYMENT' AND status = 'CONFIRMED' AND "deletedAt" IS NULL GROUP BY "statementId") pay ON pay."statementId" = s.id
    WHERE s."householdId" = ${ctx.householdId} AND s."creditCardId" IN (${cards.length ? Prisma.join(cards.map((c) => c.id)) : Prisma.sql`NULL`})`;
  for (const s of statementRows) {
    const due = dateToISO(s.dueDate);
    if (due >= today) futureStatements += Number(s.remaining);
    if (due <= monthEnd) statementsDueThisMonth += Number(s.remaining);
  }

  const bills = await prisma.scheduledPayment.aggregate({
    where: { householdId: ctx.householdId, type: "EXPENSE", status: "PENDING", dueDate: { lte: isoToDate(monthEnd) } },
    _sum: { amountCents: true },
    _count: { _all: true },
  });
  const overdueBills = await prisma.scheduledPayment.count({
    where: { householdId: ctx.householdId, type: "EXPENSE", status: "PENDING", dueDate: { lt: isoToDate(today) } },
  });

  const budget = await budgetOverview(ctx, monthKey(today), regime);

  return {
    regime,
    scope,
    period: params.period,
    business: businessRows.length ? { incomeCents: businessIncome, expenseCents: businessExpense, resultCents: businessIncome - businessExpense } : null,
    availableBalanceCents: availableBalance,
    incomeCents: income,
    expenseCents: expense,
    resultCents: income - expense,
    comparison: {
      previousPeriod: previousPeriod(params.period),
      incomeChangePct: percentChange(income, prevIncome),
      expenseChangePct: percentChange(expense, prevExpense),
      previousIncomeCents: prevIncome,
      previousExpenseCents: prevExpense,
    },
    futureStatementsCents: futureStatements,
    billsToPay: {
      totalCents: (bills._sum.amountCents ?? 0) + statementsDueThisMonth,
      scheduledCents: bills._sum.amountCents ?? 0,
      scheduledCount: bills._count._all,
      statementsCents: statementsDueThisMonth,
      overdueCount: overdueBills,
    },
    budget: {
      month: budget.month,
      limitCents: budget.totalLimitCents,
      spentCents: budget.totalSpentCents,
      availableCents: budget.totalAvailableCents,
      hasBudgets: budget.items.length > 0,
    },
    netWorth: {
      assetsCents: totalAssets,
      cardDebtCents: cardDebt,
      netWorthCents: totalAssets - cardDebt,
    },
  };
}

// -----------------------------------------------------------------------------
// Gráficos
// -----------------------------------------------------------------------------

export async function expensesByCategory(ctx: ServiceContext, params: { period: Period; regime?: AccountingRegime; filters?: AnalyticsFilters; type?: "EXPENSE" | "INCOME" }) {
  const regime = await resolveRegime(ctx, params.regime);
  const type = params.type ?? "EXPENSE";
  const rows = (await recognizedRows(ctx, params.period, regime, params.filters)).filter((r) => r.type === type);
  const categories = await prisma.category.findMany({ where: { householdId: ctx.householdId }, select: { id: true, name: true, color: true, icon: true } });
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.categoryId ?? "none", (totals.get(r.categoryId ?? "none") ?? 0) + r.amountCents);
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  const items = [...totals.entries()]
    .map(([id, amount]) => {
      const c = id === "none" ? null : catMap.get(id);
      return {
        categoryId: id === "none" ? null : id,
        name: c?.name ?? "Sem categoria",
        color: c?.color ?? "#94a3b8",
        icon: c?.icon ?? "circle-help",
        amountCents: amount,
        percent: percentOf(amount, total) ?? 0,
      };
    })
    .sort((a, b) => b.amountCents - a.amountCents);
  return { regime, totalCents: total, items };
}

export async function monthlyIncomeExpense(ctx: ServiceContext, params: { startMonth: string; endMonth: string; regime?: AccountingRegime; filters?: AnalyticsFilters }) {
  const regime = await resolveRegime(ctx, params.regime);
  const period = { start: monthRange(params.startMonth).start, end: monthRange(params.endMonth).end };
  const rows = await recognizedRows(ctx, period, regime, params.filters);
  const months = monthsBetween(params.startMonth, params.endMonth);
  const map = new Map(months.map((m) => [m, { income: 0, expense: 0 }]));
  for (const r of rows) {
    const m = map.get(monthKey(r.date));
    if (!m) continue;
    if (r.type === "INCOME") m.income += r.amountCents;
    else m.expense += r.amountCents;
  }
  let cumulative = 0;
  return {
    regime,
    items: months.map((month) => {
      const v = map.get(month)!;
      cumulative += v.income - v.expense;
      return { month, incomeCents: v.income, expenseCents: v.expense, resultCents: v.income - v.expense, cumulativeCents: cumulative };
    }),
  };
}

export async function expensesByPerson(ctx: ServiceContext, params: { period: Period; regime?: AccountingRegime; filters?: AnalyticsFilters }) {
  const regime = await resolveRegime(ctx, params.regime);
  const rows = (await recognizedRows(ctx, params.period, regime, params.filters)).filter((r) => r.type === "EXPENSE");
  const members = await prisma.householdMember.findMany({ where: { householdId: ctx.householdId }, select: { id: true, displayName: true, color: true } });
  const sharedIds = [...new Set(rows.filter((r) => r.ownership === "SHARED").map((r) => r.transactionId))];
  const allocations = sharedIds.length
    ? await prisma.transactionAllocation.findMany({ where: { transactionId: { in: sharedIds } }, select: { transactionId: true, memberId: true, amountCents: true } })
    : [];
  const allocByTx = new Map<string, Array<{ memberId: string; amountCents: number }>>();
  for (const a of allocations) {
    const list = allocByTx.get(a.transactionId) ?? [];
    list.push(a);
    allocByTx.set(a.transactionId, list);
  }

  const responsibility = new Map<string, number>(); // memberId | "shared"
  const paidBy = new Map<string, number>();
  for (const r of rows) {
    paidBy.set(r.payerMemberId ?? "unknown", (paidBy.get(r.payerMemberId ?? "unknown") ?? 0) + r.amountCents);
    if (r.ownership === "INDIVIDUAL" && r.responsibleMemberId) {
      responsibility.set(r.responsibleMemberId, (responsibility.get(r.responsibleMemberId) ?? 0) + r.amountCents);
      continue;
    }
    const alloc = allocByTx.get(r.transactionId);
    if (alloc?.length) {
      // Parcelas de cartão: o rateio é aplicado proporcionalmente ao valor reconhecido.
      const parts = splitByWeights(r.amountCents, alloc.map((a) => a.amountCents));
      alloc.forEach((a, i) => responsibility.set(a.memberId, (responsibility.get(a.memberId) ?? 0) + parts[i]!));
    } else {
      responsibility.set("shared", (responsibility.get("shared") ?? 0) + r.amountCents);
    }
  }
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  const label = (id: string) => {
    if (id === "shared") return { name: "Família (compartilhado)", color: "#0f766e" };
    if (id === "unknown") return { name: "Não informado", color: "#94a3b8" };
    const m = members.find((x) => x.id === id);
    return { name: m?.displayName ?? "Membro removido", color: m?.color ?? "#94a3b8" };
  };
  const toItems = (map: Map<string, number>) =>
    [...map.entries()]
      .map(([id, amount]) => ({ id, ...label(id), amountCents: amount, percent: percentOf(amount, total) ?? 0 }))
      .sort((a, b) => b.amountCents - a.amountCents);
  return { regime, totalCents: total, byResponsibility: toItems(responsibility), byPayer: toItems(paidBy) };
}

export async function expensesByPaymentMethod(ctx: ServiceContext, params: { period: Period; regime?: AccountingRegime; filters?: AnalyticsFilters }) {
  const regime = await resolveRegime(ctx, params.regime);
  const rows = (await recognizedRows(ctx, params.period, regime, params.filters)).filter((r) => r.type === "EXPENSE");
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.paymentMethod ?? "UNKNOWN", (map.get(r.paymentMethod ?? "UNKNOWN") ?? 0) + r.amountCents);
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  return {
    regime,
    totalCents: total,
    items: [...map.entries()].map(([method, amount]) => ({ method, amountCents: amount, percent: percentOf(amount, total) ?? 0 })).sort((a, b) => b.amountCents - a.amountCents),
  };
}

export async function topExpenses(ctx: ServiceContext, params: { period: Period; regime?: AccountingRegime; filters?: AnalyticsFilters; limit?: number }) {
  const regime = await resolveRegime(ctx, params.regime);
  const rows = (await recognizedRows(ctx, params.period, regime, params.filters)).filter((r) => r.type === "EXPENSE");
  const byTx = new Map<string, RecognizedRow & { recognizedCents: number }>();
  for (const r of rows) {
    const cur = byTx.get(r.transactionId);
    if (cur) cur.recognizedCents += r.amountCents;
    else byTx.set(r.transactionId, { ...r, recognizedCents: r.amountCents });
  }
  const top = [...byTx.values()].sort((a, b) => b.recognizedCents - a.recognizedCents).slice(0, params.limit ?? 10);
  const cats = await prisma.category.findMany({ where: { id: { in: top.map((t) => t.categoryId).filter(Boolean) as string[] } }, select: { id: true, name: true, color: true } });
  const catMap = new Map(cats.map((c) => [c.id, c]));
  return {
    regime,
    items: top.map((t) => ({
      transactionId: t.transactionId,
      description: t.description,
      date: t.date,
      amountCents: t.recognizedCents,
      category: t.categoryId ? catMap.get(t.categoryId) ?? null : null,
      installmentCount: t.installmentCount,
    })),
  };
}

// -----------------------------------------------------------------------------
// Orçamento
// -----------------------------------------------------------------------------

export async function budgetOverview(ctx: ServiceContext, month: string, regime?: AccountingRegime, natureScope?: ReportScopeValue | null) {
  const reg = await resolveRegime(ctx, regime);
  const range = monthRange(month);
  const budgets = await prisma.budget.findMany({
    where: { householdId: ctx.householdId, month },
    include: { category: { select: { id: true, name: true, color: true, icon: true } } },
    orderBy: { category: { sortOrder: "asc" } },
  });
  if (!budgets.length) return { month, regime: reg, items: [], totalLimitCents: 0, totalSpentCents: 0, totalAvailableCents: 0 };
  const rows = (await recognizedRows(ctx, range, reg, { scope: natureScope ?? null })).filter((r) => r.type === "EXPENSE");
  const spentByCat = new Map<string, number>();
  for (const r of rows) if (r.categoryId) spentByCat.set(r.categoryId, (spentByCat.get(r.categoryId) ?? 0) + r.amountCents);

  const today = todayISO(ctx.timezone);
  const daysTotal = Number(range.end.slice(8, 10));
  const isCurrent = monthKey(today) === month;
  const daysElapsed = isCurrent ? Number(today.slice(8, 10)) : month < monthKey(today) ? daysTotal : 0;

  const items = budgets.map((b) => {
    const spent = spentByCat.get(b.categoryId) ?? 0;
    const projected = isCurrent && daysElapsed > 0 ? Math.round((spent / daysElapsed) * daysTotal) : spent;
    return {
      budgetId: b.id,
      category: b.category,
      limitCents: b.limitCents,
      spentCents: spent,
      remainingCents: b.limitCents - spent,
      percentUsed: percentOf(spent, b.limitCents) ?? 0,
      projectedCents: projected,
      projectionIsEstimate: isCurrent,
    };
  });
  const totalLimit = items.reduce((s, i) => s + i.limitCents, 0);
  const totalSpent = items.reduce((s, i) => s + i.spentCents, 0);
  return {
    month,
    regime: reg,
    items,
    totalLimitCents: totalLimit,
    totalSpentCents: totalSpent,
    totalAvailableCents: items.reduce((s, i) => s + Math.max(0, i.remainingCents), 0),
    daysElapsed,
    daysTotal,
  };
}

// -----------------------------------------------------------------------------
// Projeção de fluxo de caixa
// -----------------------------------------------------------------------------

export interface CashflowEvent {
  date: ISODate;
  description: string;
  amountCents: number;
  kind: "SCHEDULED_EXPENSE" | "SCHEDULED_INCOME" | "CARD_STATEMENT" | "RECURRING_ESTIMATE";
  certainty: "CONFIRMED" | "ESTIMATED";
}

/**
 * Projeta o saldo disponível a partir do saldo atual, contas previstas, receitas previstas,
 * faturas em aberto (incluindo parcelas futuras) e recorrências. Retorna as hipóteses.
 */
export async function cashflowProjection(ctx: ServiceContext, days = 90) {
  const today = todayISO(ctx.timezone);
  const end = addDays(today, days);
  const accounts = await listAccounts(ctx);
  const startBalance = accounts.filter((a) => a.includeInTotals && a.type !== "INVESTMENT").reduce((s, a) => s + (a.balanceBrlCents ?? 0), 0);
  const events: CashflowEvent[] = [];

  // Contas no cartão não saem do caixa no vencimento: entram pela fatura (logo abaixo). Contas de
  // contas privadas que este contexto não vê ficam de fora (o saldo delas também não entra).
  const hidden = await getVisibilityScope(ctx);
  const scheduled = await prisma.scheduledPayment.findMany({
    where: {
      householdId: ctx.householdId,
      status: "PENDING",
      dueDate: { lte: isoToDate(end) },
      creditCardId: null,
      ...(hidden.hiddenAccountIds.length ? { OR: [{ accountId: null }, { accountId: { notIn: hidden.hiddenAccountIds } }] } : {}),
    },
    orderBy: { dueDate: "asc" },
  });
  for (const s of scheduled) {
    const due = dateToISO(s.dueDate);
    events.push({
      date: due < today ? today : due,
      description: `${s.description}${due < today ? " (vencida)" : ""}`,
      amountCents: s.type === "INCOME" ? s.amountCents : -s.amountCents,
      kind: s.type === "INCOME" ? "SCHEDULED_INCOME" : "SCHEDULED_EXPENSE",
      certainty: s.isEstimate ? "ESTIMATED" : "CONFIRMED",
    });
  }

  const cards = await listCards(ctx);
  const cardIds = cards.map((c) => c.id);
  if (cardIds.length) {
    const statements = await prisma.creditCardStatement.findMany({
      where: { householdId: ctx.householdId, creditCardId: { in: cardIds }, dueDate: { lte: isoToDate(end) } },
      include: { creditCard: { select: { name: true } } },
    });
    const { statementTotals } = await import("../cards/statements");
    const totals = await statementTotals(prisma, ctx.householdId, { statementIds: statements.map((s) => s.id) });
    for (const t of totals) {
      if (t.remainingCents <= 0) continue;
      const st = statements.find((s) => s.id === t.id)!;
      events.push({
        date: t.dueDate < today ? today : t.dueDate,
        description: `Fatura ${st.creditCard.name} (${t.referenceMonth})`,
        amountCents: -t.remainingCents,
        kind: "CARD_STATEMENT",
        certainty: t.closingDate <= today ? "CONFIRMED" : "ESTIMATED",
      });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));
  let running = startBalance;
  let lowest = { date: today, balanceCents: startBalance };
  const points: Array<{ date: ISODate; balanceCents: number }> = [{ date: today, balanceCents: startBalance }];
  for (const e of events) {
    running += e.amountCents;
    points.push({ date: e.date, balanceCents: running });
    if (running < lowest.balanceCents) lowest = { date: e.date, balanceCents: running };
  }
  const estimatedShare = events.length ? events.filter((e) => e.certainty === "ESTIMATED").length / events.length : 0;
  return {
    startDate: today,
    endDate: end,
    startBalanceCents: startBalance,
    endBalanceCents: running,
    lowestPoint: lowest,
    events,
    points,
    assumptions: [
      "Saldo inicial: soma das contas incluídas nos totais (exceto investimentos).",
      "Contas a pagar e receitas previstas cadastradas em 'Contas a pagar'.",
      "Faturas de cartão pelo saldo em aberto, incluindo parcelas futuras já lançadas.",
      "Não considera gastos variáveis ainda não registrados.",
    ],
    uncertainty: estimatedShare > 0.5 ? "ALTA" : estimatedShare > 0.2 ? "MÉDIA" : "BAIXA",
  };
}

/** Comparativo entre dois períodos por categoria, com a origem do cálculo. */
export async function compareCategories(ctx: ServiceContext, params: { current: Period; previous?: Period; regime?: AccountingRegime; scope?: ReportScopeValue | null }) {
  const regime = await resolveRegime(ctx, params.regime);
  const prev = params.previous ?? previousPeriod(params.current);
  const [cur, old] = await Promise.all([
    expensesByCategory(ctx, { period: params.current, regime, filters: { scope: params.scope ?? null } }),
    expensesByCategory(ctx, { period: prev, regime, filters: { scope: params.scope ?? null } }),
  ]);
  const keys = new Set([...cur.items.map((i) => i.categoryId ?? "none"), ...old.items.map((i) => i.categoryId ?? "none")]);
  const items = [...keys].map((k) => {
    const c = cur.items.find((i) => (i.categoryId ?? "none") === k);
    const p = old.items.find((i) => (i.categoryId ?? "none") === k);
    const currentCents = c?.amountCents ?? 0;
    const previousCents = p?.amountCents ?? 0;
    return {
      categoryId: k === "none" ? null : k,
      name: c?.name ?? p?.name ?? "Sem categoria",
      color: c?.color ?? p?.color ?? "#94a3b8",
      currentCents,
      previousCents,
      differenceCents: currentCents - previousCents,
      changePct: percentChange(currentCents, previousCents),
    };
  });
  items.sort((a, b) => Math.abs(b.differenceCents) - Math.abs(a.differenceCents));
  return {
    regime,
    current: params.current,
    previous: prev,
    totalCurrentCents: cur.totalCents,
    totalPreviousCents: old.totalCents,
    totalChangePct: percentChange(cur.totalCents, old.totalCents),
    items,
    method: `Soma das despesas confirmadas por categoria (regime de ${regime === "CASH" ? "caixa" : "competência"}), período atual vs. período anterior de mesma duração.`,
  };
}

/** Gastos atípicos: transações muito acima da média da categoria nos últimos meses. */
export async function unusualExpenses(ctx: ServiceContext, params: { period: Period; minHistoryMonths?: number; scope?: ReportScopeValue | null }) {
  const historyStart = addMonthsToKey(monthKey(params.period.start), -6);
  const filters = { scope: params.scope ?? null };
  const history = await recognizedRows(ctx, { start: `${historyStart}-01`, end: addDays(params.period.start, -1) }, "ACCRUAL", filters);
  const current = (await recognizedRows(ctx, params.period, "ACCRUAL", filters)).filter((r) => r.type === "EXPENSE");
  const stats = new Map<string, number[]>();
  for (const r of history) {
    if (r.type !== "EXPENSE" || !r.categoryId) continue;
    const list = stats.get(r.categoryId) ?? [];
    list.push(r.amountCents);
    stats.set(r.categoryId, list);
  }
  const result = [];
  for (const r of current) {
    if (!r.categoryId) continue;
    const list = stats.get(r.categoryId);
    if (!list || list.length < (params.minHistoryMonths ?? 5)) continue; // dados insuficientes → sem afirmação
    const mean = list.reduce((s, v) => s + v, 0) / list.length;
    const sd = Math.sqrt(list.reduce((s, v) => s + (v - mean) ** 2, 0) / list.length);
    if (r.amountCents > mean + 2.5 * sd && r.amountCents > mean * 2) {
      result.push({ transactionId: r.transactionId, description: r.description, date: r.date, amountCents: r.amountCents, categoryAverageCents: Math.round(mean), sampleSize: list.length });
    }
  }
  return { items: result.sort((a, b) => b.amountCents - a.amountCents).slice(0, 10) };
}

export { startOfMonth };
