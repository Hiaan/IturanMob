"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronRight } from "lucide-react";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartTooltip, axisTick, compactBRL } from "@/components/charts/chart-tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDayMonthBR, formatMonthBR } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { ReportScope, TransactionList } from "@/features/finance/types";
import { useCards } from "@/features/finance/hooks";
import { BusinessBadge } from "@/features/transactions/nature-control";
import { REPORT_SCOPE_LABELS } from "@/features/transactions/nature";
import { useFixedExpenses } from "@/features/fixed-expenses/use-fixed-expenses";
import { filtersToParams, type DashboardFilters } from "./use-filters";

const SERIES = {
  income: "var(--series-3)",
  expense: "var(--series-2)",
  primary: "var(--series-1)",
  cumulative: "var(--series-7)",
};

function useAnalytics<T>(name: string, path: string, params: Record<string, unknown>) {
  return useQuery({ queryKey: qk.analytics(name, params), queryFn: () => api.get<T>(path, params), placeholderData: keepPreviousData });
}

const MAX_CATEGORIES = 8;

// -----------------------------------------------------------------------------
// 1. Despesas por categoria (barras ranqueadas + detalhamento)
// -----------------------------------------------------------------------------

interface ByCategory {
  totalCents: number;
  items: Array<{ categoryId: string | null; name: string; color: string; amountCents: number; percent: number }>;
}

/** Filtro local de "Despesas por categoria": todas as formas, só cartão de crédito ou um cartão. */
type PaymentFilter = "all" | "CREDIT_CARD" | `card:${string}`;
interface PaymentOverride {
  paymentMethod?: "CREDIT_CARD";
  creditCardId?: string;
}

function paymentOverride(v: PaymentFilter): PaymentOverride {
  if (v === "CREDIT_CARD") return { paymentMethod: "CREDIT_CARD" };
  if (v.startsWith("card:")) return { creditCardId: v.slice(5) };
  return {};
}

export function CategoryBreakdown({ filters, period, scope }: { filters: DashboardFilters; period?: { start: string; end: string }; scope?: ReportScope }) {
  const cards = useCards();
  const [payment, setPayment] = useState<PaymentFilter>("all");
  // Com o filtro de cartão do painel ativo, ele já define o recorte: o seletor local fica oculto.
  const globalCard = Boolean(filters.creditCardId);
  const cardList = cards.data ?? [];
  const effective: PaymentFilter = globalCard || (payment.startsWith("card:") && cards.data && !cardList.some((c) => `card:${c.id}` === payment)) ? "all" : payment;
  const override = paymentOverride(effective);
  const params = { ...filtersToParams(filters), ...override };
  const q = useAnalytics<ByCategory>("by-category", "/api/v1/analytics/by-category", params);
  const [selected, setSelected] = useState<{ id: string | null; name: string } | null>(null);
  const paymentLabel = effective === "CREDIT_CARD" ? "só cartão de crédito" : override.creditCardId ? `cartão ${cardList.find((c) => c.id === override.creditCardId)?.name ?? ""}`.trim() : null;
  const items = q.data?.items ?? [];
  const shown = items.slice(0, MAX_CATEGORIES);
  const rest = items.slice(MAX_CATEGORIES);
  const restTotal = rest.reduce((s, i) => s + i.amountCents, 0);
  const max = Math.max(1, ...shown.map((i) => i.amountCents), restTotal);

  return (
    <>
      <ChartCard
        title="Despesas por categoria"
        description={q.data ? `Total ${formatBRL(q.data.totalCents)}${paymentLabel ? ` · ${paymentLabel}` : ""} · clique para ver as transações` : undefined}
        action={
          !globalCard && (
            <Select value={effective} onValueChange={(v) => setPayment(v as PaymentFilter)}>
              <SelectTrigger className="h-8 w-[112px] shrink-0 gap-1 px-2.5 text-xs" aria-label="Forma de pagamento" title="Filtrar por forma de pagamento ou cartão">
                <SelectValue>{effective === "all" ? "Todas" : effective === "CREDIT_CARD" ? "Só cartão" : (cardList.find((c) => `card:${c.id}` === effective)?.name ?? "Cartão")}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">Todas as formas</SelectItem>
                <SelectItem value="CREDIT_CARD">Só cartão de crédito</SelectItem>
                {cardList.length > 0 && (
                  <SelectGroup>
                    <SelectLabel className="text-xs text-muted-foreground">Cartões</SelectLabel>
                    {cardList.map((c) => (
                      <SelectItem key={c.id} value={`card:${c.id}`}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          )
        }
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        onRetry={() => q.refetch()}
        empty={!items.length && (paymentLabel ? `Nenhuma despesa no período (${paymentLabel}).` : "Nenhuma despesa no período.")}
        table={
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Categoria</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.categoryId ?? "none"}>
                  <TableCell>{i.name}</TableCell>
                  <TableCell className="text-right tabular">{formatBRL(i.amountCents)}</TableCell>
                  <TableCell className="text-right tabular">{i.percent.toLocaleString("pt-BR")}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        }
      >
        <ul className="space-y-2.5">
          {shown.map((i) => (
            <li key={i.categoryId ?? "none"}>
              <button type="button" onClick={() => setSelected({ id: i.categoryId, name: i.name })} className="group w-full rounded-lg p-1 text-left transition hover:bg-muted/60">
                <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.color }} />
                    <span className="truncate">{i.name}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground tabular">{i.percent.toLocaleString("pt-BR")}%</span>
                    <span className="w-24 text-right font-medium tabular">{formatBRL(i.amountCents)}</span>
                    <ChevronRight className="size-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${(i.amountCents / max) * 100}%`, backgroundColor: i.color }} />
                </div>
              </button>
            </li>
          ))}
          {restTotal > 0 && (
            <li className="flex items-center justify-between px-1 pt-1 text-sm text-muted-foreground">
              <span>Outras ({rest.length})</span>
              <span className="tabular">{formatBRL(restTotal)}</span>
            </li>
          )}
        </ul>
      </ChartCard>
      <CategoryTransactionsSheet category={selected} onClose={() => setSelected(null)} period={period} filters={filters} scope={scope ?? filters.scope} payment={override} paymentLabel={paymentLabel} />
    </>
  );
}

function CategoryTransactionsSheet({
  category,
  onClose,
  period,
  filters,
  scope,
  payment = {},
  paymentLabel,
}: {
  category: { id: string | null; name: string } | null;
  onClose: () => void;
  period?: { start: string; end: string };
  filters: DashboardFilters;
  /** Recorte aplicado no painel: a lista mostra o mesmo (repasses nunca entram). */
  scope?: ReportScope;
  /** Filtro local de forma de pagamento / cartão do cartão de categorias. */
  payment?: PaymentOverride;
  paymentLabel?: string | null;
}) {
  const creditCardId = payment.creditCardId ?? filters.creditCardId;
  const params = {
    start: period?.start,
    end: period?.end,
    dateField: filters.regime === "CASH" ? "date" : "competenceDate",
    types: ["EXPENSE"],
    status: "CONFIRMED",
    ...(category?.id ? { categoryIds: [category.id] } : { uncategorized: true }),
    memberId: filters.memberId,
    accountId: filters.accountId,
    creditCardId,
    paymentMethods: payment.paymentMethod ? [payment.paymentMethod] : undefined,
    excluded: "hide",
    scope: scope && scope !== "ALL" ? scope : undefined,
    sort: "amount_desc",
    pageSize: 100,
  };
  const q = useQuery({ queryKey: qk.transactions(params), queryFn: () => api.get<TransactionList>("/api/v1/transactions", params), enabled: Boolean(category && period) });
  return (
    <Sheet open={Boolean(category)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{category?.name}</SheetTitle>
          <SheetDescription>
            {period ? `${formatDateBR(period.start)} a ${formatDateBR(period.end)}` : ""}
            {scope && ` · recorte ${REPORT_SCOPE_LABELS[scope]}`}
            {paymentLabel && ` · ${paymentLabel}`}
            {filters.regime === "CASH" && " · compras no cartão listadas pela data da compra"}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {q.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>
          ) : !q.data?.items.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma transação.</p>
          ) : (
            <ul className="divide-y">
              {q.data.items.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateBR(t.date)}
                      {t.subcategory && ` · ${t.subcategory.name}`}
                      {t.installmentCount > 1 && ` · ${t.installmentCount}x`}
                    </p>
                  </div>
                  <span className="font-medium tabular">{formatBRL(t.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`/transacoes?${new URLSearchParams({
              ...(category?.id ? { categoryId: category.id } : { uncategorized: "1" }),
              ...(scope && scope !== "ALL" ? { scope } : {}),
              ...(period ? { start: period.start, end: period.end } : {}),
              ...(creditCardId ? { creditCardId } : {}),
              ...(payment.paymentMethod ? { paymentMethod: payment.paymentMethod } : {}),
            }).toString()}`}
            className="mt-4 inline-block text-sm font-medium text-brand hover:underline"
          >
            Abrir em Transações
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// 2 e 3. Receitas x despesas por mês e evolução de 12 meses
// -----------------------------------------------------------------------------

interface Monthly {
  items: Array<{ month: string; incomeCents: number; expenseCents: number; resultCents: number; cumulativeCents: number }>;
}

export function MonthlyIncomeExpense({ filters }: { filters: DashboardFilters }) {
  const params = { ...filtersToParams(filters), preset: undefined };
  const q = useAnalytics<Monthly>("monthly", "/api/v1/analytics/monthly", params);
  const data = (q.data?.items ?? []).map((i) => ({ ...i, label: formatMonthBR(i.month, { short: true }) }));
  const empty = data.every((d) => !d.incomeCents && !d.expenseCents);
  return (
    <ChartCard
      title="Receitas e despesas por mês"
      description="Últimos 12 meses"
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={empty && "Ainda não há movimentações suficientes."}
      table={<MonthlyTable data={data} />}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} barGap={2} barCategoryGap="22%" margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="incomeCents" name="Receitas" fill={SERIES.income} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="expenseCents" name="Despesas" fill={SERIES.expense} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function MonthlyTable({ data }: { data: Array<{ month: string; incomeCents: number; expenseCents: number; resultCents: number; cumulativeCents: number }> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Mês</TableHead>
          <TableHead className="text-right">Receitas</TableHead>
          <TableHead className="text-right">Despesas</TableHead>
          <TableHead className="text-right">Resultado</TableHead>
          <TableHead className="text-right">Acumulado</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((d) => (
          <TableRow key={d.month}>
            <TableCell>{formatMonthBR(d.month, { short: true })}</TableCell>
            <TableCell className="text-right tabular">{formatBRL(d.incomeCents)}</TableCell>
            <TableCell className="text-right tabular">{formatBRL(d.expenseCents)}</TableCell>
            <TableCell className="text-right tabular">{formatBRL(d.resultCents)}</TableCell>
            <TableCell className="text-right tabular">{formatBRL(d.cumulativeCents)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function FinancialEvolution({ filters }: { filters: DashboardFilters }) {
  const params = { ...filtersToParams(filters), preset: undefined };
  const q = useAnalytics<Monthly>("monthly", "/api/v1/analytics/monthly", params);
  const data = (q.data?.items ?? []).map((i) => ({ ...i, label: formatMonthBR(i.month, { short: true }) }));
  const empty = data.every((d) => !d.incomeCents && !d.expenseCents);
  return (
    <ChartCard
      title="Evolução financeira (12 meses)"
      description="Resultado mensal e resultado acumulado no período"
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={empty && "Ainda não há movimentações suficientes."}
      table={<MonthlyTable data={data} />}
    >
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
          <Tooltip content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="resultCents" name="Resultado do mês" stroke={SERIES.primary} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
          <Line type="monotone" dataKey="cumulativeCents" name="Acumulado" stroke={SERIES.cumulative} strokeWidth={2} dot={false} activeDot={{ r: 5 }} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// -----------------------------------------------------------------------------
// 4. Orçamento x realizado (medidores)
// -----------------------------------------------------------------------------

interface BudgetOverview {
  month: string;
  items: Array<{ budgetId: string; category: { id: string; name: string; color: string }; limitCents: number; spentCents: number; remainingCents: number; percentUsed: number; projectedCents: number }>;
  totalLimitCents: number;
  totalSpentCents: number;
}

export function BudgetVsActual({ filters }: { filters: DashboardFilters }) {
  // O realizado do orçamento segue o recorte do painel (Pessoal | Empresa | Tudo; sem escolher, o padrão da família).
  const params = { regime: filters.regime, scope: filters.scope };
  const q = useAnalytics<BudgetOverview>("budget", "/api/v1/analytics/budget", params);
  const items = q.data?.items ?? [];
  return (
    <ChartCard
      title="Orçamento x realizado"
      description={q.data ? `${formatMonthBR(q.data.month, { capitalize: true })} · projeção até o fim do mês é estimada` : undefined}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={
        !items.length && (
          <span>
            Nenhum orçamento definido para o mês.{" "}
            <Link href="/orcamentos" className="font-medium text-brand hover:underline">
              Definir orçamento
            </Link>
          </span>
        )
      }
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Categoria</TableHead>
              <TableHead className="text-right">Limite</TableHead>
              <TableHead className="text-right">Utilizado</TableHead>
              <TableHead className="text-right">Restante</TableHead>
              <TableHead className="text-right">Projeção</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={i.budgetId}>
                <TableCell>{i.category.name}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(i.limitCents)}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(i.spentCents)}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(i.remainingCents)}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(i.projectedCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ul className="space-y-3.5">
        {items.map((i) => (
          <li key={i.budgetId}>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: i.category.color }} />
                {i.category.name}
              </span>
              <span className="text-xs text-muted-foreground tabular">
                {formatBRL(i.spentCents)} de {formatBRL(i.limitCents)}
              </span>
            </div>
            <Progress value={Math.min(100, i.percentUsed)} indicatorClassName={cn(i.percentUsed >= 100 ? "bg-warning" : "bg-brand")} aria-label={`${i.category.name}: ${i.percentUsed}% utilizado`} />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {i.percentUsed.toLocaleString("pt-BR")}% utilizado · {i.remainingCents >= 0 ? `restam ${formatBRL(i.remainingCents)}` : `${formatBRL(-i.remainingCents)} acima do limite`}
            </p>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

// -----------------------------------------------------------------------------
// 5 e 6. Por pessoa e por forma de pagamento
// -----------------------------------------------------------------------------

interface ByPerson {
  totalCents: number;
  byResponsibility: Array<{ id: string; name: string; color: string; amountCents: number; percent: number }>;
  byPayer: Array<{ id: string; name: string; color: string; amountCents: number; percent: number }>;
}

function RankedBars({ items, color }: { items: Array<{ key: string; label: string; amountCents: number; percent: number; dot?: string }>; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.amountCents));
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {i.dot && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.dot }} />}
              <span className="truncate">{i.label}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular">{i.percent.toLocaleString("pt-BR")}%</span>
              <span className="w-24 text-right font-medium tabular">{formatBRL(i.amountCents)}</span>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${(i.amountCents / max) * 100}%`, backgroundColor: i.dot ?? color ?? SERIES.primary }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ExpensesByPerson({ filters }: { filters: DashboardFilters }) {
  const params = filtersToParams(filters);
  const q = useAnalytics<ByPerson>("by-person", "/api/v1/analytics/by-person", params);
  const [mode, setMode] = useState<"responsibility" | "payer">("responsibility");
  const items = (mode === "responsibility" ? q.data?.byResponsibility : q.data?.byPayer) ?? [];
  return (
    <ChartCard
      title="Despesas por pessoa"
      description={mode === "responsibility" ? "Por responsabilidade econômica (rateios considerados)" : "Por quem efetivamente pagou"}
      action={
        <div className="flex rounded-md bg-muted p-0.5 text-[11px]">
          {(["responsibility", "payer"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={cn("rounded px-2 py-1 font-medium", mode === m ? "bg-card shadow-sm" : "text-muted-foreground")}>
              {m === "responsibility" ? "Responsável" : "Pagador"}
            </button>
          ))}
        </div>
      }
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={!items.length && "Nenhuma despesa no período."}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pessoa</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead className="text-right">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={i.id}>
                <TableCell>{i.name}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(i.amountCents)}</TableCell>
                <TableCell className="text-right tabular">{i.percent.toLocaleString("pt-BR")}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <RankedBars items={items.map((i) => ({ key: i.id, label: i.name, amountCents: i.amountCents, percent: i.percent, dot: i.color }))} />
    </ChartCard>
  );
}

interface ByMethod {
  totalCents: number;
  items: Array<{ method: string; amountCents: number; percent: number }>;
}

export function ExpensesByPaymentMethod({ filters }: { filters: DashboardFilters }) {
  const params = filtersToParams(filters);
  const q = useAnalytics<ByMethod>("by-payment-method", "/api/v1/analytics/by-payment-method", params);
  const items = q.data?.items ?? [];
  const label = (m: string) => (m === "UNKNOWN" ? "Não informada" : labelOf(PAYMENT_METHOD_LABELS, m));
  return (
    <ChartCard
      title="Formas de pagamento"
      description="Distribuição das despesas do período"
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={!items.length && "Nenhuma despesa no período."}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Forma</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead className="text-right">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={i.method}>
                <TableCell>{label(i.method)}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(i.amountCents)}</TableCell>
                <TableCell className="text-right tabular">{i.percent.toLocaleString("pt-BR")}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <RankedBars items={items.map((i) => ({ key: i.method, label: label(i.method), amountCents: i.amountCents, percent: i.percent }))} color={SERIES.primary} />
    </ChartCard>
  );
}

// -----------------------------------------------------------------------------
// 7. Projeção de contas futuras (cartão + contas previstas)
// -----------------------------------------------------------------------------

interface Cashflow {
  startBalanceCents: number;
  endBalanceCents: number;
  lowestPoint: { date: string; balanceCents: number };
  events: Array<{ date: string; description: string; amountCents: number; kind: string; certainty: string }>;
  points: Array<{ date: string; balanceCents: number }>;
  assumptions: string[];
  uncertainty: string;
}

export function FutureBillsProjection() {
  const q = useQuery({ queryKey: qk.analytics("cashflow", { days: 180 }), queryFn: () => api.get<Cashflow>("/api/v1/analytics/cashflow", { days: 180 }), placeholderData: keepPreviousData });
  const byMonth = new Map<string, { card: number; bills: number }>();
  for (const e of q.data?.events ?? []) {
    if (e.amountCents >= 0) continue;
    const m = e.date.slice(0, 7);
    const cur = byMonth.get(m) ?? { card: 0, bills: 0 };
    if (e.kind === "CARD_STATEMENT") cur.card += -e.amountCents;
    else cur.bills += -e.amountCents;
    byMonth.set(m, cur);
  }
  const data = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, label: formatMonthBR(month, { short: true }), cardCents: v.card, billsCents: v.bills }));
  return (
    <ChartCard
      title="Projeção de contas futuras"
      description="Faturas de cartão (inclui parcelas futuras) e contas previstas — próximos 6 meses"
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={!data.length && "Nenhum compromisso futuro registrado."}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mês</TableHead>
              <TableHead className="text-right">Cartões</TableHead>
              <TableHead className="text-right">Contas previstas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((d) => (
              <TableRow key={d.month}>
                <TableCell>{d.label}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(d.cardCents)}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(d.billsCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} barCategoryGap="28%" margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="cardCents" name="Faturas de cartão" stackId="a" fill={SERIES.primary} stroke="var(--card)" strokeWidth={2} maxBarSize={36} />
          <Bar dataKey="billsCents" name="Contas previstas" stackId="a" fill={SERIES.expense} stroke="var(--card)" strokeWidth={2} radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// -----------------------------------------------------------------------------
// 8. Evolução do saldo disponível
// -----------------------------------------------------------------------------

export function BalanceEvolution({ filters }: { filters: DashboardFilters }) {
  // Saldo não muda com o recorte (natureza só afeta relatórios): o recorte não vai na consulta.
  const params = { ...filtersToParams(filters), scope: undefined, preset: filters.preset === "today" || filters.preset === "yesterday" ? "last30" : filters.preset };
  const q = useAnalytics<{ points: Array<{ date: string; balanceCents: number }> }>("balance-history", "/api/v1/accounts/balance-history", params);
  const points = q.data?.points ?? [];
  const step = Math.max(1, Math.ceil(points.length / 120));
  const data = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => ({ ...p, label: formatDayMonthBR(p.date) }));
  return (
    <ChartCard
      title="Evolução do saldo disponível"
      description="Saldo diário das contas incluídas nos totais"
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={!data.length && "Cadastre uma conta para acompanhar o saldo."}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead className="text-right">Saldo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((d) => (
              <TableRow key={d.date}>
                <TableCell>{formatDateBR(d.date)}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(d.balanceCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-3)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--series-3)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
          <Tooltip content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Area type="monotone" dataKey="balanceCents" name="Saldo" stroke="var(--series-3)" strokeWidth={2} fill="url(#balanceFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// -----------------------------------------------------------------------------
// 9. Gastos recorrentes
// -----------------------------------------------------------------------------

/** Contas fixas (recorrências de despesa ativas) no recorte do painel; o detalhe e a projeção ficam em Gastos fixos. */
export function RecurringExpenses({ filters }: { filters: DashboardFilters }) {
  const q = useFixedExpenses(filters.scope);
  const data = q.data?.recurring;
  const items = data?.items ?? [];
  const scope = q.data?.scope;
  return (
    <ChartCard
      title="Gastos recorrentes"
      description={items.length ? `${items.length} ativos · equivalente mensal ${formatBRL(data?.monthlyTotalCents ?? 0)}${scope ? ` · recorte ${REPORT_SCOPE_LABELS[scope]}` : ""}` : undefined}
      action={
        <Link href="/gastos-fixos" className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-brand hover:underline">
          Gastos fixos e projeção <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      }
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={
        !items.length && (
          <span>
            Nenhuma despesa recorrente{scope && scope !== "ALL" ? ` no recorte ${REPORT_SCOPE_LABELS[scope]}` : " cadastrada"}.{" "}
            <Link href="/contas-a-pagar?aba=recorrencias" className="font-medium text-brand hover:underline">
              Cadastrar
            </Link>
          </span>
        )
      }
    >
      <ul className="divide-y">
        {items.slice(0, 8).map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{r.description}</p>
              <p className="text-xs text-muted-foreground">
                {r.category?.name ?? "Sem categoria"}
                {r.nextDueDate && ` · próximo ${formatDateBR(r.nextDueDate)}`}
              </p>
            </div>
            <span className="flex items-center gap-2">
              {scope !== "BUSINESS" && r.scope === "BUSINESS" && <BusinessBadge />}
              {r.isEstimate && <Badge variant="muted">estimado</Badge>}
              <span className="font-medium tabular">{formatBRL(r.amountCents)}</span>
            </span>
          </li>
        ))}
      </ul>
      {items.length > 8 && (
        <Link href="/gastos-fixos" className="mt-2 inline-block text-sm font-medium text-brand hover:underline">
          Ver todas as {items.length}
        </Link>
      )}
    </ChartCard>
  );
}

// -----------------------------------------------------------------------------
// 10. Maiores despesas
// -----------------------------------------------------------------------------

interface TopExpenses {
  items: Array<{ transactionId: string; description: string; date: string; amountCents: number; category: { name: string; color: string } | null; installmentCount: number }>;
}

export function TopExpensesList({ filters }: { filters: DashboardFilters }) {
  const params = { ...filtersToParams(filters), limit: 8 };
  const q = useAnalytics<TopExpenses>("top-expenses", "/api/v1/analytics/top-expenses", params);
  const items = q.data?.items ?? [];
  return (
    <ChartCard title="Maiores despesas do período" isLoading={q.isLoading} isFetching={q.isFetching} error={q.error} onRetry={() => q.refetch()} empty={!items.length && "Nenhuma despesa no período."}>
      <ol className="divide-y">
        {items.map((t, idx) => (
          <li key={t.transactionId} className="flex items-center gap-3 py-2.5 text-sm">
            <span className="w-5 text-xs text-muted-foreground tabular">{idx + 1}</span>
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: t.category?.color ?? "#94a3b8" }} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{t.description}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateBR(t.date)} · {t.category?.name ?? "Sem categoria"}
                {t.installmentCount > 1 && ` · ${t.installmentCount}x`}
              </p>
            </div>
            <span className="font-medium tabular">{formatBRL(t.amountCents)}</span>
          </li>
        ))}
      </ol>
    </ChartCard>
  );
}
