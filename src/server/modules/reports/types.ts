import type { AccountingRegime } from "@prisma/client";
import type { ISODate, Period } from "@/lib/dates";

/**
 * Estrutura persistida em Report.data (versão 1). Todos os valores em centavos.
 * `certainty` distingue dados confirmados (registrados) de projeções/estimativas.
 */

export type ReportScope = "FAMILY" | "PERSONAL";
export type Certainty = "CONFIRMED" | "PROJECTION";

export interface ReportCategoryItem {
  categoryId: string | null;
  name: string;
  color: string;
  amountCents: number;
  percent: number;
}

export interface ReportTopExpense {
  transactionId: string;
  description: string;
  date: ISODate;
  amountCents: number;
  categoryName: string | null;
  installmentCount: number;
}

export interface ReportPeriodComparison {
  previousPeriod: Period;
  previousIncomeCents: number;
  previousExpenseCents: number;
  previousResultCents: number;
  incomeChangePct: number | null;
  expenseChangePct: number | null;
  resultChangeCents: number;
}

export interface ReportUpcomingBill {
  date: ISODate;
  description: string;
  amountCents: number;
  kind: "SCHEDULED" | "CARD_STATEMENT";
  overdue: boolean;
  certainty: Certainty;
}

export interface CalculationOrigin {
  regime: AccountingRegime;
  regimeLabel: string;
  summary: string;
  confirmed: string[];
  projections: string[];
}

interface ReportBase {
  version: 1;
  householdName: string;
  scope: ReportScope;
  period: Period;
  periodLabel: string;
  /** Período ainda em andamento (valores parciais). */
  isPartial: boolean;
  regime: AccountingRegime;
  regimeLabel: string;
  timezone: string;
  generatedAt: string;
  totals: { incomeCents: number; expenseCents: number; resultCents: number };
  /** Recorte de natureza dos totais (Pessoal, Empresa ou Tudo). Opcional em relatórios antigos. */
  natureScope?: "PERSONAL" | "BUSINESS" | "ALL";
  topCategories: ReportCategoryItem[];
  topExpenses: ReportTopExpense[];
  recognizedTransactions: number;
  origin: CalculationOrigin;
}

export interface WeeklyReportData extends ReportBase {
  type: "WEEKLY";
  comparison: ReportPeriodComparison;
  upcomingBills: { from: ISODate; to: ISODate; items: ReportUpcomingBill[]; totalCents: number; overdueCount: number };
}

export interface MonthlyReportData extends ReportBase {
  type: "MONTHLY";
  month: string;
  /** Resultado da empresa no mês (natureza Empresa), quando houver lançamentos. */
  business?: { incomeCents: number; expenseCents: number; resultCents: number } | null;
  incomeCategories: ReportCategoryItem[];
  balance: { availableCents: number; investmentsCents: number; asOf: ISODate; certainty: Certainty };
  evolution: Array<{ month: string; incomeCents: number; expenseCents: number; resultCents: number }>;
  previousMonths: { averageIncomeCents: number; averageExpenseCents: number; months: number };
  comparison: ReportPeriodComparison;
  categoryComparison: {
    previousPeriod: Period;
    totalCurrentCents: number;
    totalPreviousCents: number;
    totalChangePct: number | null;
    items: Array<{ categoryId: string | null; name: string; color: string; currentCents: number; previousCents: number; differenceCents: number; changePct: number | null }>;
    method: string;
  };
  recurringExpenses: {
    items: Array<{ id: string; description: string; amountCents: number; frequency: string; frequencyLabel: string; monthlyEquivalentCents: number; isEstimate: boolean; categoryName: string | null }>;
    monthlyTotalCents: number;
    certainty: Certainty;
  };
  futureInstallments: { items: Array<{ month: string; amountCents: number }>; totalCents: number; asOf: ISODate; certainty: Certainty };
  budget: {
    month: string;
    items: Array<{ categoryId: string; name: string; color: string; limitCents: number; spentCents: number; remainingCents: number; percentUsed: number; projectedCents: number; projectionIsEstimate: boolean }>;
    totalLimitCents: number;
    totalSpentCents: number;
    totalAvailableCents: number;
  };
  goals: Array<{
    id: string;
    name: string;
    targetCents: number;
    savedCents: number;
    contributedInPeriodCents: number;
    percent: number;
    deadline: ISODate | null;
    status: string;
    /** Valor mensal necessário para atingir a meta no prazo (projeção). */
    monthlyNeededCents: number | null;
  }>;
}

export type ReportData = WeeklyReportData | MonthlyReportData;

export interface ReportView {
  id: string;
  type: "WEEKLY" | "MONTHLY";
  periodStart: ISODate;
  periodEnd: ISODate;
  createdAt: string;
  scheduled: boolean;
  generatedById: string | null;
  data: ReportData;
}
