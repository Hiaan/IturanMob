"use client";

import { useState } from "react";
import { CopyPlus, ListChecks, PiggyBank, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { formatBRL } from "@/lib/money";
import { formatMonthBR, monthKey, todayISO } from "@/lib/dates";
import { REGIME_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";
import { AddBudgetDialog, BulkBudgetDialog } from "./budget-dialogs";
import { BudgetHistoryChart } from "./budget-history-chart";
import { BudgetRow } from "./budget-row";
import { MonthSwitcher } from "./month-switcher";
import { useBudgetMutations, useBudgets } from "./use-budgets";
import type { BudgetList } from "./types";

function SummaryTile({ label, value, children, className }: { label: string; value: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("p-5", className)}>
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold leading-none tracking-tight">{value}</p>
      {children && <div className="mt-2 text-xs text-muted-foreground">{children}</div>}
    </Card>
  );
}

function Summary({ data, isCurrentMonth, isPastMonth }: { data: BudgetList; isCurrentMonth: boolean; isPastMonth: boolean }) {
  const limit = data.totalLimitCents;
  const spent = data.totalSpentCents;
  const remaining = limit - spent;
  const percent = limit ? Math.round((spent / limit) * 1000) / 10 : 0;
  const projected = data.items.reduce((s, i) => s + i.projectedCents, 0);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryTile label="Limite total" value={formatBRL(limit)}>
        {data.items.length} {data.items.length === 1 ? "categoria" : "categorias"} com orçamento
      </SummaryTile>
      <SummaryTile label="Utilizado" value={formatBRL(spent)}>
        <Progress value={Math.min(100, percent)} indicatorClassName={percent >= 100 ? "bg-warning" : "bg-brand"} aria-label={`${percent}% do limite total utilizado`} className="mb-1.5" />
        <span className="tabular">{percent.toLocaleString("pt-BR")}% do limite total</span>
      </SummaryTile>
      <SummaryTile label={remaining >= 0 ? "Restante" : "Acima do limite total"} value={<span className={cn(remaining < 0 && "text-warning")}>{formatBRL(Math.abs(remaining))}</span>}>
        {data.daysTotal && isCurrentMonth && data.daysElapsed !== undefined
          ? `${data.daysTotal - data.daysElapsed} ${data.daysTotal - data.daysElapsed === 1 ? "dia restante" : "dias restantes"} no mês`
          : `Disponível nas categorias: ${formatBRL(data.totalAvailableCents)}`}
      </SummaryTile>
      <SummaryTile
        label={isCurrentMonth ? "Projeção até o fim do mês" : isPastMonth ? "Total do mês" : "Projeção"}
        value={isCurrentMonth || isPastMonth ? formatBRL(isCurrentMonth ? projected : spent) : "—"}
      >
        {isCurrentMonth ? (
          <span className="flex items-center gap-1.5">
            <Badge variant="muted">estimativa</Badge> ritmo atual de gastos
          </span>
        ) : isPastMonth ? (
          "Mês encerrado"
        ) : (
          "Disponível a partir do início do mês"
        )}
      </SummaryTile>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando orçamentos">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-96 rounded-xl lg:col-span-2" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}

export function BudgetsView() {
  const me = useMe();
  const tz = me.data?.household.timezone;
  const canEdit = useCan("budgets:write");
  const current = monthKey(todayISO(tz));
  const [month, setMonth] = useState(current);
  const q = useBudgets(month);
  const { copyPrevious } = useBudgetMutations();
  const [addOpen, setAddOpen] = useState(false);
  const [addCategory, setAddCategory] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const data = q.data;
  const isCurrentMonth = month === current;
  const isPastMonth = month < current;
  const openAdd = (categoryId: string | null = null) => {
    setAddCategory(categoryId);
    setAddOpen(true);
  };

  const actions = canEdit && (
    <>
      <Button variant="outline" onClick={() => copyPrevious.mutate(month)} loading={copyPrevious.isPending} title="Copiar os orçamentos do mês anterior (sem sobrescrever)">
        <CopyPlus /> Copiar anterior
      </Button>
      <Button variant="outline" onClick={() => setBulkOpen(true)}>
        <ListChecks /> Em lote
      </Button>
      <Button variant="brand" onClick={() => openAdd()}>
        <Plus /> Novo orçamento
      </Button>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Orçamentos"
        description={data ? `Limites por categoria · regime de ${REGIME_LABELS[data.regime].toLowerCase()}` : "Limites de gastos por categoria"}
        actions={
          <>
            <MonthSwitcher month={month} onChange={setMonth} timezone={tz} />
            {data && data.items.length > 0 && actions}
          </>
        }
      />

      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={PiggyBank}
          title={`Nenhum orçamento em ${formatMonthBR(month)}`}
          description="Defina limites por categoria para acompanhar quanto já foi usado e quanto ainda resta no mês."
          action={
            canEdit ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={() => copyPrevious.mutate(month)} loading={copyPrevious.isPending}>
                  <CopyPlus /> Copiar do mês anterior
                </Button>
                <Button variant="outline" onClick={() => setBulkOpen(true)}>
                  <ListChecks /> Definir em lote
                </Button>
                <Button variant="brand" onClick={() => openAdd()}>
                  <Plus /> Novo orçamento
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className={cn("space-y-6 transition-opacity", q.isFetching && "opacity-70")}>
          <Summary data={data} isCurrentMonth={isCurrentMonth} isPastMonth={isPastMonth} />
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Por categoria</CardTitle>
                <CardDescription className="text-xs">Despesas confirmadas do mês comparadas ao limite definido.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {data.items.map((item) => (
                    <BudgetRow key={item.budgetId} item={item} month={month} isCurrentMonth={isCurrentMonth} canEdit={canEdit} />
                  ))}
                </ul>
              </CardContent>
            </Card>
            <div className="space-y-4">
              <BudgetHistoryChart month={month} />
              {canEdit && data.unbudgetedCategories.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Categorias sem orçamento</CardTitle>
                    <CardDescription className="text-xs">Defina um limite para acompanhar também estas categorias.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="flex flex-wrap gap-2">
                      {data.unbudgetedCategories.map((c) => (
                        <li key={c.id}>
                          <Button variant="outline" size="sm" onClick={() => openAdd(c.id)} aria-label={`Definir orçamento para ${c.name}`}>
                            <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                            {c.name}
                            <Plus className="text-muted-foreground" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      )}

      <AddBudgetDialog open={addOpen} onOpenChange={setAddOpen} month={month} categories={data?.unbudgetedCategories ?? []} initialCategoryId={addCategory} />
      <BulkBudgetDialog open={bulkOpen} onOpenChange={setBulkOpen} month={month} items={data?.items ?? []} />
    </div>
  );
}
