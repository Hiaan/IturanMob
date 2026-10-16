"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRight, Briefcase, MessageSquareText } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { describePeriod, formatDayMonthBR } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";
import { NaturalLanguageEntry } from "@/features/transactions/quick-add-dialog";
import { useMe } from "@/features/me/use-me";
import { useAccounts } from "@/features/finance/hooks";
import type { AccountDTO, ReportScope } from "@/features/finance/types";
import { useHousehold } from "@/features/settings/use-household";
import { REPORT_SCOPE_LABELS } from "@/features/transactions/nature";
import { foreignSummary } from "@/features/accounts/currency";
import { FiltersBar } from "./filters-bar";
import { filtersToParams, usePersistentFilters } from "./use-filters";
import { KpiGrid, type DashboardSummary, type KpiFxNotes } from "./kpi-grid";
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

/** Os totais do servidor já vêm em reais; a nota só explica a conversão das contas em moeda estrangeira. */
function fxNote(accounts: AccountDTO[]): string | null {
  const fx = foreignSummary(accounts);
  if (!fx.foreign.length) return null;
  if (fx.unrated.length) return `${fx.unrated.map((a) => a.name).join(", ")} sem cotação ainda: fora do total`;
  return `${fx.foreign.length === 1 ? "Conta em moeda estrangeira convertida" : "Contas em moeda estrangeira convertidas"} pela PTAX de ${formatDayMonthBR(fx.rateDate!)}`;
}

/** Resultado da empresa no período (natureza Empresa), quando o recorte não é só a empresa. */
function BusinessResultCard({ business, scope, period, onShowBusiness }: { business: NonNullable<DashboardSummary["business"]>; scope: ReportScope; period: { start: string; end: string }; onShowBusiness: () => void }) {
  const href = `/transacoes?scope=BUSINESS&start=${period.start}&end=${period.end}`;
  return (
    <Card aria-labelledby="business-result-title">
      <CardHeader className="flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle id="business-result-title" className="flex items-center gap-2">
            <Briefcase className="size-4 text-series-7" aria-hidden /> Resultado da empresa
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            Lançamentos com natureza Empresa no período · {scope === "ALL" ? "já incluídos nos totais acima (recorte Tudo)" : "fora dos totais acima (recorte Pessoal)"}. Saldo e faturas não mudam pela natureza.
          </CardDescription>
        </div>
        <CardAction className="ml-0 flex flex-wrap gap-2 sm:ml-auto">
          <Button size="sm" variant="outline" onClick={onShowBusiness}>
            <Briefcase /> Ver o painel da empresa
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link href={href}>
              Lançamentos <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Receitas</dt>
            <dd className="text-sm font-semibold break-words tabular text-positive sm:text-lg">{formatBRL(business.incomeCents)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Despesas</dt>
            <dd className="text-sm font-semibold break-words tabular sm:text-lg">{formatBRL(business.expenseCents)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Resultado</dt>
            <dd className={cn("text-sm font-semibold break-words tabular sm:text-lg", business.resultCents < 0 && "text-negative")}>{formatBRL(business.resultCents, { signed: true })}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export function DashboardView() {
  const me = useMe();
  const { filters, update, reset } = usePersistentFilters("dashboard");
  const household = useHousehold();
  const defaultScope = household.data?.settings.defaultReportScope ?? null;
  const accounts = useAccounts();
  const included = (accounts.data ?? []).filter((a) => a.includeInTotals);
  const fx: KpiFxNotes = { available: fxNote(included.filter((a) => a.type !== "INVESTMENT")), all: fxNote(included) };
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
        description={
          summary.data
            ? `Visão de ${describePeriod(summary.data.period)} · regime de ${summary.data.regime === "CASH" ? "caixa" : "competência"}${summary.data.scope ? ` · recorte ${REPORT_SCOPE_LABELS[summary.data.scope]}` : ""}`
            : "Visão geral das finanças da família"
        }
      />
      <FiltersBar filters={filters} onChange={update} onReset={reset} defaultScope={defaultScope} appliedScope={summary.data?.scope ?? null} />
      <OnboardingChecklist />
      <div className={summary.isFetching && !summary.isLoading ? "opacity-70 transition-opacity" : "transition-opacity"}>
        <KpiGrid data={summary.data} isLoading={summary.isLoading} fx={fx} />
      </div>
      {summary.data?.business && summary.data.scope && summary.data.scope !== "BUSINESS" && (
        <BusinessResultCard business={summary.data.business} scope={summary.data.scope} period={summary.data.period} onShowBusiness={() => update({ scope: "BUSINESS" })} />
      )}

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
            <NaturalLanguageEntry onDone={() => undefined} autoFocus={false} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <CategoryBreakdown filters={filters} period={summary.data?.period} scope={summary.data?.scope} />
        <BudgetVsActual filters={filters} scope={summary.data?.scope} defaultScope={defaultScope} />
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
