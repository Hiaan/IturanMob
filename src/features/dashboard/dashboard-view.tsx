"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MessageSquareText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { describePeriod } from "@/lib/dates";
import { NaturalLanguageEntry } from "@/features/transactions/quick-add-dialog";
import { useMe } from "@/features/me/use-me";
import { FiltersBar } from "./filters-bar";
import { filtersToParams, usePersistentFilters } from "./use-filters";
import { KpiGrid, type DashboardSummary } from "./kpi-grid";
import { OnboardingChecklist } from "./onboarding";
import {
  BalanceEvolution,
  BudgetVsActual,
  CategoryBreakdown,
  ExpensesByPaymentMethod,
  ExpensesByPerson,
  FinancialEvolution,
  FutureBillsProjection,
  MonthlyIncomeExpense,
  RecurringExpenses,
  TopExpensesList,
} from "./dashboard-charts";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export function DashboardView() {
  const me = useMe();
  const { filters, update, reset } = usePersistentFilters("dashboard");
  const params = filtersToParams(filters);
  const summary = useQuery({
    queryKey: qk.analytics("summary", params),
    queryFn: () => api.get<DashboardSummary>("/api/v1/analytics/summary", params),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={me.data ? `${greeting()}, ${me.data.member.displayName.split(" ")[0]}` : "Dashboard"}
        description={summary.data ? `Visão de ${describePeriod(summary.data.period)} · regime de ${summary.data.regime === "CASH" ? "caixa" : "competência"}` : "Visão geral das finanças da família"}
      />
      <FiltersBar filters={filters} onChange={update} onReset={reset} />
      <OnboardingChecklist />
      <div className={summary.isFetching && !summary.isLoading ? "opacity-70 transition-opacity" : "transition-opacity"}>
        <KpiGrid data={summary.data} isLoading={summary.isLoading} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <MonthlyIncomeExpense filters={filters} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquareText className="size-4 text-brand" /> Lançamento rápido
            </CardTitle>
            <CardDescription>Escreva como no WhatsApp — revise antes de confirmar.</CardDescription>
          </CardHeader>
          <CardContent>
            <NaturalLanguageEntry onDone={() => undefined} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <CategoryBreakdown filters={filters} period={summary.data?.period} />
        <BudgetVsActual filters={filters} />
        <ExpensesByPerson filters={filters} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <FinancialEvolution filters={filters} />
        <BalanceEvolution filters={filters} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <FutureBillsProjection />
        <ExpensesByPaymentMethod filters={filters} />
        <TopExpensesList filters={filters} />
      </div>

      <RecurringExpenses />
    </div>
  );
}
