/** Tipos de resposta da API de orçamentos (espelham src/server/modules/budgets/service.ts). */
export interface BudgetCategory {
  id: string;
  name: string;
  color: string;
  icon: string;
}

export interface BudgetItem {
  budgetId: string;
  category: BudgetCategory;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  percentUsed: number;
  projectedCents: number;
  projectionIsEstimate: boolean;
  alertsTriggered: number[];
}

export interface BudgetList {
  month: string;
  regime: "ACCRUAL" | "CASH";
  items: BudgetItem[];
  totalLimitCents: number;
  totalSpentCents: number;
  totalAvailableCents: number;
  daysElapsed?: number;
  daysTotal?: number;
  unbudgetedCategories: BudgetCategory[];
}

export interface BudgetHistoryPoint {
  month: string;
  limitCents: number | null;
  spentCents: number;
  percentUsed: number | null;
}

export interface BudgetHistory {
  regime: "ACCRUAL" | "CASH";
  months: string[];
  series: Array<{ category: BudgetCategory; points: BudgetHistoryPoint[] }>;
  totals: Array<{ month: string; limitCents: number; spentCents: number; percentUsed: number | null }>;
}
