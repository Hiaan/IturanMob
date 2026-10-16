import { z } from "zod";
import type { AccountingRegime, Prisma, RecurrenceFrequency, Report } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError, ValidationError } from "../../errors";
import {
  addDays,
  addMonthsToKey,
  dateToISO,
  describePeriod,
  formatDateBR,
  formatMonthBR,
  isMonthKey,
  isoToDate,
  minISO,
  monthKey,
  monthRange,
  monthsBetween,
  previousPeriod,
  startOfWeek,
  todayISO,
  type ISODate,
  type Period,
} from "@/lib/dates";
import { formatBRL, percentChange, percentOf } from "@/lib/money";
import { RECURRENCE_FREQUENCY_LABELS, REGIME_DESCRIPTIONS, REGIME_LABELS } from "@/lib/labels";
import { audit } from "../audit/service";
import {
  budgetOverview,
  compareCategories,
  expensesByCategory,
  monthlyIncomeExpense,
  recognizedRows,
  resolveScope,
  resolveRegime,
  topExpenses,
} from "../analytics/service";
import { listAccounts } from "../accounts/service";
import { futureCommitments, listCards } from "../cards/service";
import { statementTotals } from "../cards/statements";
import { getVisibilityScope, visibleAccountWhere, visibleCardWhere } from "../visibility/scope";
import { isoDateSchema } from "../transactions/schemas";
import { collectTransactionRows } from "../exports/service";
import { renderReportPdf } from "./pdf";
import { renderReportXlsx } from "./xlsx";
import { renderReportCsv } from "./csv";
import { nextOccurrence } from "./schedule";
import type {
  CalculationOrigin,
  MonthlyReportData,
  ReportCategoryItem,
  ReportData,
  ReportPeriodComparison,
  ReportScope,
  ReportTopExpense,
  ReportUpcomingBill,
  ReportView,
  WeeklyReportData,
} from "./types";

export type { ReportData, ReportView, WeeklyReportData, MonthlyReportData } from "./types";

// -----------------------------------------------------------------------------
// Escopo dos relatórios
// -----------------------------------------------------------------------------

/**
 * Identificador sentinela de "membro" usado para relatórios da família: com ele, a visibilidade
 * oculta TODAS as contas e cartões privados (relatórios compartilhados não expõem dados privados).
 */
export const FAMILY_SCOPE_MEMBER_ID = "__family_report__";

export function familyScopeContext(householdId: string, timezone: string): ServiceContext {
  return {
    householdId,
    memberId: FAMILY_SCOPE_MEMBER_ID,
    userId: null,
    role: "VIEWER",
    actorType: "SYSTEM",
    timezone,
    canViewOthersPrivate: false,
  };
}

export function isFamilyScopeContext(ctx: ServiceContext): boolean {
  return ctx.memberId === FAMILY_SCOPE_MEMBER_ID;
}

/** O usuário enxerga alguma conta ou cartão privado? (define o escopo padrão do relatório) */
async function hasPrivateVisibility(ctx: ServiceContext): Promise<boolean> {
  if (!ctx.memberId || isFamilyScopeContext(ctx)) return false;
  const [accounts, cards] = await Promise.all([
    prisma.account.count({ where: { AND: [visibleAccountWhere(ctx), { visibility: "PRIVATE" }] } }),
    prisma.creditCard.count({ where: { AND: [visibleCardWhere(ctx), { visibility: "PRIVATE" }] } }),
  ]);
  return accounts + cards > 0;
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sumRows(rows: Array<{ type: "EXPENSE" | "INCOME"; amountCents: number }>, type: "EXPENSE" | "INCOME") {
  return rows.reduce((s, r) => (r.type === type ? s + r.amountCents : s), 0);
}

function categoryItems(items: Array<{ categoryId: string | null; name: string; color: string; amountCents: number; percent: number }>): ReportCategoryItem[] {
  return items.map((i) => ({ categoryId: i.categoryId, name: i.name, color: i.color, amountCents: i.amountCents, percent: i.percent }));
}

function topExpenseItems(items: Awaited<ReturnType<typeof topExpenses>>["items"]): ReportTopExpense[] {
  return items.map((t) => ({
    transactionId: t.transactionId,
    description: t.description,
    date: t.date,
    amountCents: t.amountCents,
    categoryName: t.category?.name ?? null,
    installmentCount: t.installmentCount,
  }));
}

function comparisonOf(previous: Period, income: number, expense: number, prevIncome: number, prevExpense: number): ReportPeriodComparison {
  return {
    previousPeriod: previous,
    previousIncomeCents: prevIncome,
    previousExpenseCents: prevExpense,
    previousResultCents: prevIncome - prevExpense,
    incomeChangePct: percentChange(income, prevIncome),
    expenseChangePct: percentChange(expense, prevExpense),
    resultChangeCents: income - expense - (prevIncome - prevExpense),
  };
}

function scopeOf(ctx: ServiceContext, explicit?: ReportScope): ReportScope {
  return explicit ?? (isFamilyScopeContext(ctx) || !ctx.memberId ? "FAMILY" : "PERSONAL");
}

function originOf(regime: AccountingRegime, scope: ReportScope, extra: { confirmed: string[]; projections: string[]; partialUntil?: ISODate | null }): CalculationOrigin {
  const confirmed = [
    "Receitas e despesas: somente lançamentos confirmados e não excluídos (lançamentos aguardando confirmação não entram nos totais).",
    "Transferências entre contas e pagamentos de fatura de cartão não são receita nem despesa — a compra no cartão é a despesa (sem dupla contagem).",
    scope === "FAMILY"
      ? "Escopo da família: contas e cartões privados não entram neste relatório."
      : "Escopo pessoal: inclui as contas e cartões privados visíveis para quem gerou o relatório.",
    ...extra.confirmed,
  ];
  if (extra.partialUntil) confirmed.push(`Período em andamento: valores parciais, registrados até ${formatDateBR(extra.partialUntil)}.`);
  return {
    regime,
    regimeLabel: REGIME_LABELS[regime],
    summary: `Valores calculados pelo regime de ${REGIME_LABELS[regime].toLowerCase()}. ${REGIME_DESCRIPTIONS[regime]}`,
    confirmed,
    projections: extra.projections,
  };
}

function monthlyEquivalent(amountCents: number, frequency: RecurrenceFrequency, interval: number): number {
  const n = Math.max(1, interval);
  switch (frequency) {
    case "WEEKLY":
      return Math.round((amountCents * 52) / 12);
    case "BIWEEKLY":
      return Math.round((amountCents * 26) / 12);
    case "MONTHLY":
      return amountCents;
    case "QUARTERLY":
      return Math.round(amountCents / 3);
    case "SEMIANNUAL":
      return Math.round(amountCents / 6);
    case "YEARLY":
      return Math.round(amountCents / 12);
    case "CUSTOM_DAYS":
      return Math.round((amountCents * 365) / 12 / n);
    case "CUSTOM_MONTHS":
      return Math.round(amountCents / n);
  }
}

// -----------------------------------------------------------------------------
// Contas a vencer (semanal)
// -----------------------------------------------------------------------------

async function upcomingBills(ctx: ServiceContext, from: ISODate, to: ISODate) {
  const visibility = await getVisibilityScope(ctx);
  const items: ReportUpcomingBill[] = [];
  const scheduled = await prisma.scheduledPayment.findMany({
    where: {
      householdId: ctx.householdId,
      type: "EXPENSE",
      status: "PENDING",
      // Assinaturas no cartão entram pela fatura (evita contar duas vezes).
      creditCardId: null,
      dueDate: { gte: isoToDate(addDays(from, -60)), lte: isoToDate(to) },
    },
    orderBy: { dueDate: "asc" },
    take: 200,
  });
  for (const s of scheduled) {
    if (s.accountId && visibility.hiddenAccountIds.includes(s.accountId)) continue;
    const due = dateToISO(s.dueDate);
    items.push({ date: due, description: s.description, amountCents: s.amountCents, kind: "SCHEDULED", overdue: due < from, certainty: s.isEstimate ? "PROJECTION" : "CONFIRMED" });
  }

  const cards = await listCards(ctx);
  if (cards.length) {
    const statements = await prisma.creditCardStatement.findMany({
      where: { householdId: ctx.householdId, creditCardId: { in: cards.map((c) => c.id) }, dueDate: { gte: isoToDate(addDays(from, -60)), lte: isoToDate(to) } },
      select: { id: true, creditCardId: true },
    });
    if (statements.length) {
      const totals = await statementTotals(prisma, ctx.householdId, { statementIds: statements.map((s) => s.id) });
      for (const t of totals) {
        if (t.remainingCents <= 0) continue;
        const card = cards.find((c) => c.id === t.creditCardId);
        items.push({
          date: t.dueDate,
          description: `Fatura ${card?.name ?? "do cartão"} (${formatMonthBR(t.referenceMonth, { short: true })})`,
          amountCents: t.remainingCents,
          kind: "CARD_STATEMENT",
          overdue: t.dueDate < from,
          certainty: t.closingDate <= from ? "CONFIRMED" : "PROJECTION",
        });
      }
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || b.amountCents - a.amountCents);
  return {
    from,
    to,
    items,
    totalCents: items.reduce((s, i) => s + i.amountCents, 0),
    overdueCount: items.filter((i) => i.overdue).length,
  };
}

// -----------------------------------------------------------------------------
// Construção dos relatórios
// -----------------------------------------------------------------------------

export interface BuildReportOptions {
  regime?: AccountingRegime;
  scope?: ReportScope;
  /** Natureza dos totais: Pessoal, Empresa ou Tudo (padrão da família). */
  natureScope?: "PERSONAL" | "BUSINESS" | "ALL";
  /** Instante de referência (testes). */
  now?: Date;
}

async function householdName(householdId: string): Promise<string> {
  const hh = await prisma.household.findUnique({ where: { id: householdId }, select: { name: true } });
  if (!hh) throw new NotFoundError("Família");
  return hh.name;
}

/** Relatório semanal (segunda a domingo da semana que contém `weekStartISO`). */
export async function buildWeeklyReport(ctx: ServiceContext, weekStartISO: ISODate, opts: BuildReportOptions = {}): Promise<WeeklyReportData> {
  const now = opts.now ?? new Date();
  const today = todayISO(ctx.timezone, now);
  const start = startOfWeek(weekStartISO);
  const period: Period = { start, end: addDays(start, 6) };
  const previous = previousPeriod(period);
  const regime = await resolveRegime(ctx, opts.regime);
  const scope = scopeOf(ctx, opts.scope);
  const natureScope = await resolveScope(ctx, opts.natureScope);
  const nf = { scope: natureScope };

  const [name, rows, prevRows, categories, top, bills] = await Promise.all([
    householdName(ctx.householdId),
    recognizedRows(ctx, period, regime, nf),
    recognizedRows(ctx, previous, regime, nf),
    expensesByCategory(ctx, { period, regime, filters: nf }),
    topExpenses(ctx, { period, regime, limit: 5, filters: nf }),
    upcomingBills(ctx, today, addDays(today, 7)),
  ]);
  const income = sumRows(rows, "INCOME");
  const expense = sumRows(rows, "EXPENSE");
  const partial = period.end > today;

  return {
    version: 1,
    type: "WEEKLY",
    natureScope,
    householdName: name,
    scope,
    period,
    periodLabel: `Semana de ${formatDateBR(period.start)} a ${formatDateBR(period.end)}`,
    isPartial: partial,
    regime,
    regimeLabel: REGIME_LABELS[regime],
    timezone: ctx.timezone,
    generatedAt: now.toISOString(),
    totals: { incomeCents: income, expenseCents: expense, resultCents: income - expense },
    topCategories: categoryItems(categories.items.slice(0, 5)),
    topExpenses: topExpenseItems(top.items),
    recognizedTransactions: new Set(rows.map((r) => r.transactionId)).size,
    comparison: comparisonOf(previous, income, expense, sumRows(prevRows, "INCOME"), sumRows(prevRows, "EXPENSE")),
    upcomingBills: bills,
    origin: originOf(regime, scope, {
      confirmed: [`Comparação com a semana anterior (${describePeriod(previous)}), pelo mesmo regime.`],
      projections: [
        `Contas a vencer de ${formatDateBR(bills.from)} a ${formatDateBR(bills.to)}: contas previstas cadastradas e faturas de cartão com saldo em aberto. Faturas ainda não fechadas podem receber novas compras; contas marcadas como estimativa podem variar.`,
      ],
      partialUntil: partial ? minISO(today, period.end) : null,
    }),
  };
}

/** Relatório mensal completo (mês no formato AAAA-MM). */
export async function buildMonthlyReport(ctx: ServiceContext, month: string, opts: BuildReportOptions = {}): Promise<MonthlyReportData> {
  if (!isMonthKey(month)) throw new ValidationError("Mês inválido (use AAAA-MM).");
  const now = opts.now ?? new Date();
  const today = todayISO(ctx.timezone, now);
  const period = monthRange(month);
  const previous = previousPeriod(period);
  const regime = await resolveRegime(ctx, opts.regime);
  const scope = scopeOf(ctx, opts.scope);
  const visibility = await getVisibilityScope(ctx);
  const balanceAsOf = minISO(period.end, today);
  const natureScope = await resolveScope(ctx, opts.natureScope);
  const nf = { scope: natureScope };

  const [name, rows, expenseCats, incomeCats, evolution, top, compare, budget, accounts, commitments] = await Promise.all([
    householdName(ctx.householdId),
    recognizedRows(ctx, period, regime, nf),
    expensesByCategory(ctx, { period, regime, type: "EXPENSE", filters: nf }),
    expensesByCategory(ctx, { period, regime, type: "INCOME", filters: nf }),
    monthlyIncomeExpense(ctx, { startMonth: addMonthsToKey(month, -5), endMonth: month, regime, filters: nf }),
    topExpenses(ctx, { period, regime, limit: 10, filters: nf }),
    compareCategories(ctx, { current: period, previous, regime, scope: natureScope }),
    budgetOverview(ctx, month, regime, natureScope),
    listAccounts(ctx, { asOf: balanceAsOf }),
    futureCommitments(ctx, 12),
  ]);
  const income = sumRows(rows, "INCOME");
  const expense = sumRows(rows, "EXPENSE");
  // Natureza: o relatório segue o recorte escolhido (ou o padrão da família); a empresa aparece à parte.
  const businessRows = natureScope === "BUSINESS" ? rows : await recognizedRows(ctx, period, regime, { scope: "BUSINESS" });
  const businessIncome = sumRows(businessRows, "INCOME");
  const businessExpense = sumRows(businessRows, "EXPENSE");

  // Meses anteriores (média dos 3 meses antes do mês do relatório, considerando meses com movimento).
  const prevItems = evolution.items.filter((i) => i.month < month).slice(-3);
  const withData = prevItems.filter((i) => i.incomeCents || i.expenseCents);
  const avg = (key: "incomeCents" | "expenseCents") => (withData.length ? Math.round(withData.reduce((s, i) => s + i[key], 0) / withData.length) : 0);
  const prevMonth = evolution.items.find((i) => i.month === addMonthsToKey(month, -1));

  // Despesas recorrentes ativas no mês.
  const recurring = await prisma.recurringTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      active: true,
      type: "EXPENSE",
      startDate: { lte: isoToDate(period.end) },
      OR: [{ endDate: null }, { endDate: { gte: isoToDate(period.start) } }],
    },
    include: { category: { select: { name: true } } },
    orderBy: { amountCents: "desc" },
    take: 200,
  });
  const recurringItems = recurring
    .filter((r) => !(r.accountId && visibility.hiddenAccountIds.includes(r.accountId)) && !(r.creditCardId && visibility.hiddenCardIds.includes(r.creditCardId)))
    .map((r) => ({
      id: r.id,
      description: r.description,
      amountCents: r.amountCents,
      frequency: r.frequency,
      frequencyLabel: RECURRENCE_FREQUENCY_LABELS[r.frequency],
      monthlyEquivalentCents: monthlyEquivalent(r.amountCents, r.frequency, r.interval),
      isEstimate: r.isVariableAmount,
      categoryName: r.category?.name ?? null,
    }));

  // Metas: valor acumulado (contribuições − resgates) até o fim do mês.
  const goals = await prisma.financialGoal.findMany({
    where: { householdId: ctx.householdId, status: { in: ["ACTIVE", "COMPLETED"] }, createdAt: { lte: new Date(isoToDate(period.end).getTime() + 86_400_000) } },
    orderBy: { createdAt: "asc" },
  });
  const visibleGoals = goals.filter((g) => !(g.accountId && visibility.hiddenAccountIds.includes(g.accountId)));
  const goalIds = visibleGoals.map((g) => g.id);
  const [savedSums, periodSums] = goalIds.length
    ? await Promise.all([
        prisma.goalContribution.groupBy({ by: ["goalId"], where: { goalId: { in: goalIds }, deletedAt: null, date: { lte: isoToDate(period.end) } }, _sum: { amountCents: true } }),
        prisma.goalContribution.groupBy({
          by: ["goalId"],
          where: { goalId: { in: goalIds }, deletedAt: null, date: { gte: isoToDate(period.start), lte: isoToDate(period.end) } },
          _sum: { amountCents: true },
        }),
      ])
    : [[], []];
  const goalItems = visibleGoals.map((g) => {
    const saved = savedSums.find((s) => s.goalId === g.id)?._sum.amountCents ?? 0;
    const inPeriod = periodSums.find((s) => s.goalId === g.id)?._sum.amountCents ?? 0;
    const deadline = g.deadline ? dateToISO(g.deadline) : null;
    let monthlyNeeded: number | null = null;
    if (deadline && saved < g.targetCents && monthKey(deadline) > month) {
      const monthsLeft = monthsBetween(addMonthsToKey(month, 1), monthKey(deadline)).length;
      monthlyNeeded = Math.ceil((g.targetCents - saved) / Math.max(1, monthsLeft));
    }
    return {
      id: g.id,
      name: g.name,
      targetCents: g.targetCents,
      savedCents: saved,
      contributedInPeriodCents: inPeriod,
      percent: Math.min(100, percentOf(saved, g.targetCents) ?? 0),
      deadline,
      status: g.status,
      monthlyNeededCents: monthlyNeeded,
    };
  });

  const partial = period.end > today;
  const commitmentsTotal = commitments.reduce((s, c) => s + c.amountCents, 0);
  const included = accounts.filter((a) => a.includeInTotals);

  return {
    version: 1,
    type: "MONTHLY",
    month,
    natureScope,
    business: businessRows.length ? { incomeCents: businessIncome, expenseCents: businessExpense, resultCents: businessIncome - businessExpense } : null,
    householdName: name,
    scope,
    period,
    periodLabel: formatMonthBR(month, { capitalize: true }),
    isPartial: partial,
    regime,
    regimeLabel: REGIME_LABELS[regime],
    timezone: ctx.timezone,
    generatedAt: now.toISOString(),
    totals: { incomeCents: income, expenseCents: expense, resultCents: income - expense },
    topCategories: categoryItems(expenseCats.items),
    incomeCategories: categoryItems(incomeCats.items),
    topExpenses: topExpenseItems(top.items),
    recognizedTransactions: new Set(rows.map((r) => r.transactionId)).size,
    balance: {
      availableCents: included.filter((a) => a.type !== "INVESTMENT").reduce((s, a) => s + (a.balanceBrlCents ?? 0), 0),
      investmentsCents: included.filter((a) => a.type === "INVESTMENT").reduce((s, a) => s + (a.balanceBrlCents ?? 0), 0),
      asOf: balanceAsOf,
      certainty: "CONFIRMED",
    },
    evolution: evolution.items.map((i) => ({ month: i.month, incomeCents: i.incomeCents, expenseCents: i.expenseCents, resultCents: i.resultCents })),
    previousMonths: { averageIncomeCents: avg("incomeCents"), averageExpenseCents: avg("expenseCents"), months: withData.length },
    comparison: comparisonOf(previous, income, expense, prevMonth?.incomeCents ?? 0, prevMonth?.expenseCents ?? 0),
    categoryComparison: {
      previousPeriod: compare.previous,
      totalCurrentCents: compare.totalCurrentCents,
      totalPreviousCents: compare.totalPreviousCents,
      totalChangePct: compare.totalChangePct,
      items: compare.items.slice(0, 15),
      method: compare.method,
    },
    recurringExpenses: {
      items: recurringItems,
      monthlyTotalCents: recurringItems.reduce((s, i) => s + i.monthlyEquivalentCents, 0),
      certainty: "PROJECTION",
    },
    futureInstallments: { items: commitments, totalCents: commitmentsTotal, asOf: todayISO(ctx.timezone, now), certainty: "PROJECTION" },
    budget: {
      month,
      items: budget.items.map((b) => ({
        categoryId: b.category.id,
        name: b.category.name,
        color: b.category.color,
        limitCents: b.limitCents,
        spentCents: b.spentCents,
        remainingCents: b.remainingCents,
        percentUsed: b.percentUsed,
        projectedCents: b.projectedCents,
        projectionIsEstimate: b.projectionIsEstimate,
      })),
      totalLimitCents: budget.totalLimitCents,
      totalSpentCents: budget.totalSpentCents,
      totalAvailableCents: budget.totalAvailableCents,
    },
    goals: goalItems,
    origin: originOf(regime, scope, {
      confirmed: [
        `Saldo disponível: saldo inicial + movimentos registrados até ${formatDateBR(balanceAsOf)} nas contas incluídas nos totais (investimentos à parte).`,
        "Evolução mensal e comparações: mesmos critérios, mês a mês.",
        "Metas: soma das contribuições menos resgates registrados até o fim do mês.",
      ],
      projections: [
        "Despesas recorrentes: valor mensal equivalente das recorrências ativas; recorrências de valor variável são estimativas.",
        `Parcelamentos futuros: saldo em aberto das próximas faturas dos cartões, na posição de ${formatDateBR(todayISO(ctx.timezone, now))}.`,
        "Orçamento: a projeção de fim de mês usa a média diária de gastos (apenas no mês corrente).",
        "Metas: valor mensal necessário para atingir o objetivo até o prazo.",
      ],
      partialUntil: partial ? minISO(today, period.end) : null,
    }),
  };
}

// -----------------------------------------------------------------------------
// Persistência e consulta
// -----------------------------------------------------------------------------

export const generateReportSchema = z
  .object({
    type: z.enum(["WEEKLY", "MONTHLY"]),
    /** Qualquer data da semana desejada (relatório semanal) ou do mês desejado. */
    periodStart: isoDateSchema.optional(),
    month: z
      .string()
      .refine((v) => isMonthKey(v), "Mês inválido (use AAAA-MM)")
      .optional(),
    scope: z.enum(["FAMILY", "PERSONAL"]).optional(),
    regime: z.enum(["ACCRUAL", "CASH"]).optional(),
    /** Natureza dos totais: Pessoal, Empresa ou Tudo (sem informar: padrão da família). */
    natureScope: z.enum(["PERSONAL", "BUSINESS", "ALL"]).optional(),
  })
  .strict();
export type GenerateReportInput = z.input<typeof generateReportSchema>;

function toView(report: Report): ReportView {
  return {
    id: report.id,
    type: report.type === "WEEKLY" ? "WEEKLY" : "MONTHLY",
    periodStart: dateToISO(report.periodStart),
    periodEnd: dateToISO(report.periodEnd),
    createdAt: report.createdAt.toISOString(),
    scheduled: Boolean(report.scheduleId) && !report.generatedById,
    generatedById: report.generatedById,
    data: report.data as unknown as ReportData,
  };
}

/** Gera e persiste um relatório. Relatórios de escopo pessoal só são visíveis para quem os gerou. */
export async function generateReport(ctx: ServiceContext, rawInput: GenerateReportInput, opts: { scheduleId?: string | null; now?: Date } = {}): Promise<ReportView> {
  assertCan(ctx, "reports:read");
  const input = generateReportSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  const today = todayISO(ctx.timezone, now);
  const scope: ReportScope = input.scope ?? (isFamilyScopeContext(ctx) ? "FAMILY" : (await hasPrivateVisibility(ctx)) ? "PERSONAL" : "FAMILY");
  const reportCtx = scope === "FAMILY" && !isFamilyScopeContext(ctx) ? familyScopeContext(ctx.householdId, ctx.timezone) : ctx;
  const data: ReportData =
    input.type === "WEEKLY"
      ? await buildWeeklyReport(reportCtx, input.periodStart ?? (input.month ? `${input.month}-01` : today), { regime: input.regime, scope, now, natureScope: input.natureScope })
      : await buildMonthlyReport(reportCtx, input.month ?? monthKey(input.periodStart ?? today), { regime: input.regime, scope, now, natureScope: input.natureScope });
  const generatedById = isFamilyScopeContext(ctx) || !ctx.memberId ? null : ctx.memberId;
  const report = await prisma.report.create({
    data: {
      householdId: ctx.householdId,
      type: input.type,
      periodStart: isoToDate(data.period.start),
      periodEnd: isoToDate(data.period.end),
      data: toJson(data),
      scheduleId: opts.scheduleId ?? null,
      generatedById,
    },
  });
  return toView(report);
}

function reportVisibilityWhere(ctx: ServiceContext): Prisma.ReportWhereInput {
  const or: Prisma.ReportWhereInput[] = [{ generatedById: null }, { data: { path: ["scope"], equals: "FAMILY" } }];
  if (ctx.memberId && !isFamilyScopeContext(ctx)) or.push({ generatedById: ctx.memberId });
  return { householdId: ctx.householdId, OR: or };
}

export const listReportsSchema = z.object({
  type: z.enum(["WEEKLY", "MONTHLY"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listReports(ctx: ServiceContext, filters: z.input<typeof listReportsSchema> = {}) {
  assertCan(ctx, "reports:read");
  const f = listReportsSchema.parse(filters);
  const reports = await prisma.report.findMany({
    where: { AND: [reportVisibilityWhere(ctx), f.type ? { type: f.type } : { type: { in: ["WEEKLY", "MONTHLY"] } }] },
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
    take: f.limit,
  });
  return reports.map((r) => {
    const view = toView(r);
    return {
      id: view.id,
      type: view.type,
      periodStart: view.periodStart,
      periodEnd: view.periodEnd,
      periodLabel: view.data.periodLabel,
      createdAt: view.createdAt,
      scheduled: view.scheduled,
      scope: view.data.scope,
      regime: view.data.regime,
      isPartial: view.data.isPartial,
      totals: view.data.totals,
    };
  });
}

export async function getReport(ctx: ServiceContext, id: string): Promise<ReportView> {
  assertCan(ctx, "reports:read");
  const report = await prisma.report.findFirst({ where: { AND: [{ id }, reportVisibilityWhere(ctx)] } });
  if (!report) throw new NotFoundError("Relatório");
  return toView(report);
}

// -----------------------------------------------------------------------------
// Exportação (PDF, XLSX, CSV)
// -----------------------------------------------------------------------------

export type ReportExportFormat = "pdf" | "xlsx" | "csv";

const CONTENT_TYPES: Record<ReportExportFormat, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

export function reportFileBaseName(report: ReportView): string {
  return report.type === "WEEKLY" ? `relatorio-semanal-${report.periodStart}` : `relatorio-mensal-${report.periodStart.slice(0, 7)}`;
}

/** Lançamentos do período do relatório, no mesmo escopo de visibilidade do relatório. */
export async function reportTransactions(ctx: ServiceContext, report: ReportView) {
  const reportCtx = report.data.scope === "FAMILY" ? familyScopeContext(ctx.householdId, ctx.timezone) : ctx;
  const { rows } = await collectTransactionRows(reportCtx, {
    start: report.periodStart,
    end: report.periodEnd,
    dateField: report.data.regime === "ACCRUAL" ? "competenceDate" : "date",
    sort: "date_asc",
  });
  return rows;
}

export async function exportReport(ctx: ServiceContext, id: string, format: ReportExportFormat) {
  const report = await getReport(ctx, id);
  let content: Buffer;
  if (format === "pdf") {
    content = await renderReportPdf(report);
  } else {
    const rows = await reportTransactions(ctx, report);
    content = format === "xlsx" ? await renderReportXlsx(report, rows) : renderReportCsv(rows);
  }
  await audit(ctx, { action: "EXPORT", entityType: "Report", entityId: report.id, metadata: { format, type: report.type, periodStart: report.periodStart } });
  return { content, contentType: CONTENT_TYPES[format], fileName: `${reportFileBaseName(report)}.${format}` };
}

// -----------------------------------------------------------------------------
// Agendamentos
// -----------------------------------------------------------------------------

export const scheduleUpdateSchema = z
  .object({
    enabled: z.boolean(),
    dayOfWeek: z.number().int().min(0).max(6),
    dayOfMonth: z.number().int().min(1).max(31),
    hour: z.number().int().min(0).max(23),
    sendWhatsApp: z.boolean(),
    notifyInApp: z.boolean(),
  })
  .partial()
  .strict();
export type ScheduleUpdateInput = z.input<typeof scheduleUpdateSchema>;

async function ensureSchedules(householdId: string) {
  await prisma.reportSchedule.upsert({
    where: { householdId_type: { householdId, type: "WEEKLY" } },
    update: {},
    create: { householdId, type: "WEEKLY", dayOfWeek: 1, hour: 8 },
  });
  await prisma.reportSchedule.upsert({
    where: { householdId_type: { householdId, type: "MONTHLY" } },
    update: {},
    create: { householdId, type: "MONTHLY", dayOfMonth: 1, hour: 8 },
  });
}

function scheduleDTO(s: Prisma.ReportScheduleGetPayload<object>) {
  return {
    id: s.id,
    type: s.type,
    enabled: s.enabled,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    hour: s.hour,
    sendWhatsApp: s.sendWhatsApp,
    notifyInApp: s.notifyInApp,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
  };
}

export async function listReportSchedules(ctx: ServiceContext) {
  assertCan(ctx, "reports:read");
  await ensureSchedules(ctx.householdId);
  const schedules = await prisma.reportSchedule.findMany({ where: { householdId: ctx.householdId, type: { in: ["WEEKLY", "MONTHLY"] } }, orderBy: { type: "asc" } });
  const result = [];
  for (const s of schedules) {
    let current = s;
    if (s.enabled && !s.nextRunAt) {
      const next = nextOccurrence({ type: s.type === "WEEKLY" ? "WEEKLY" : "MONTHLY", dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, hour: s.hour }, ctx.timezone);
      current = await prisma.reportSchedule.update({ where: { id: s.id }, data: { nextRunAt: next } });
    }
    result.push(scheduleDTO(current));
  }
  return result;
}

export async function updateReportSchedule(ctx: ServiceContext, type: "WEEKLY" | "MONTHLY", rawInput: ScheduleUpdateInput) {
  assertCan(ctx, "settings:manage");
  const input = scheduleUpdateSchema.parse(rawInput);
  await ensureSchedules(ctx.householdId);
  const current = await prisma.reportSchedule.findUniqueOrThrow({ where: { householdId_type: { householdId: ctx.householdId, type } } });
  const merged = {
    enabled: input.enabled ?? current.enabled,
    dayOfWeek: type === "WEEKLY" ? input.dayOfWeek ?? current.dayOfWeek ?? 1 : null,
    dayOfMonth: type === "MONTHLY" ? input.dayOfMonth ?? current.dayOfMonth ?? 1 : null,
    hour: input.hour ?? current.hour,
    sendWhatsApp: input.sendWhatsApp ?? current.sendWhatsApp,
    notifyInApp: input.notifyInApp ?? current.notifyInApp,
  };
  const updated = await prisma.reportSchedule.update({
    where: { id: current.id },
    data: {
      ...merged,
      nextRunAt: merged.enabled ? nextOccurrence({ type, dayOfWeek: merged.dayOfWeek, dayOfMonth: merged.dayOfMonth, hour: merged.hour }, ctx.timezone) : null,
    },
  });
  await audit(ctx, { action: "SETTINGS_CHANGE", entityType: "ReportSchedule", entityId: updated.id, before: scheduleDTO(current), after: scheduleDTO(updated) });
  return scheduleDTO(updated);
}

// -----------------------------------------------------------------------------
// Resumo em texto (WhatsApp e notificações)
// -----------------------------------------------------------------------------

function pct(value: number | null): string {
  if (value === null) return "sem base de comparação";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

/** Resumo curto e neutro do relatório (texto puro). */
export function reportSummaryText(data: ReportData): string {
  const lines: string[] = [];
  const title = data.type === "WEEKLY" ? `Resumo semanal — ${formatDateBR(data.period.start)} a ${formatDateBR(data.period.end)}` : `Resumo de ${data.periodLabel.toLowerCase()}`;
  lines.push(title);
  lines.push(`Recebido: ${formatBRL(data.totals.incomeCents)}`);
  lines.push(`Gasto: ${formatBRL(data.totals.expenseCents)}`);
  lines.push(`Resultado: ${formatBRL(data.totals.resultCents, { signed: true })}`);
  const cats = data.topCategories.slice(0, 3);
  if (cats.length) lines.push(`Maiores categorias: ${cats.map((c) => `${c.name} ${formatBRL(c.amountCents)}`).join(" · ")}`);
  if (data.type === "WEEKLY") {
    lines.push(`Gastos vs. semana anterior: ${pct(data.comparison.expenseChangePct)}`);
    const bills = data.upcomingBills.items.filter((b) => !b.overdue);
    if (bills.length) lines.push(`Contas nos próximos 7 dias: ${bills.length} (${formatBRL(bills.reduce((s, b) => s + b.amountCents, 0))})`);
    if (data.upcomingBills.overdueCount) lines.push(`Contas vencidas em aberto: ${data.upcomingBills.overdueCount}`);
  } else {
    lines.push(`Gastos vs. mês anterior: ${pct(data.comparison.expenseChangePct)}`);
    if (data.budget.items.length) lines.push(`Orçamento: ${formatBRL(data.budget.totalSpentCents)} de ${formatBRL(data.budget.totalLimitCents)} previstos`);
    if (data.futureInstallments.totalCents) lines.push(`Parcelas futuras no cartão: ${formatBRL(data.futureInstallments.totalCents)}`);
  }
  lines.push(`Regime: ${data.regimeLabel.toLowerCase()}. Relatório completo no painel.`);
  return lines.join("\n");
}
