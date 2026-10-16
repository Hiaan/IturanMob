"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronUp, PieChart, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import { formatDayMonthBR, formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { TransactionNature } from "@/features/finance/types";
import { CategoryBar, NatureBreakdown, sliceKey } from "./category-summary";
import type { CardsSpendingByCategory, CategorySlice, StatementCategorySummary } from "./types";

const ALL = "__all__";
const MAX_ROWS = 8;

interface Row {
  key: string;
  name: string;
  color: string;
  isUncategorized: boolean;
  currentCents: number;
  previousCents: number;
}

/** União das categorias da fatura atual e da anterior, da maior (atual) para a menor. */
function compareRows(current: CategorySlice[], previous: CategorySlice[]): Row[] {
  const map = new Map<string, Row>();
  const add = (c: CategorySlice, field: "currentCents" | "previousCents") => {
    const key = sliceKey(c);
    const row = map.get(key) ?? { key, name: c.name, color: c.color, isUncategorized: !c.categoryId, currentCents: 0, previousCents: 0 };
    row[field] += c.amountCents;
    map.set(key, row);
  };
  current.forEach((c) => add(c, "currentCents"));
  previous.forEach((c) => add(c, "previousCents"));
  return [...map.values()].sort((a, b) => b.currentCents - a.currentCents || b.previousCents - a.previousCents);
}

function Change({ current, previous }: { current: number; previous: number }) {
  if (!previous && !current) return null;
  if (!previous) return <span className="text-xs font-medium text-muted-foreground">nova</span>;
  const diff = current - previous;
  if (!diff) return <span className="text-xs text-muted-foreground">igual</span>;
  const pctValue = Math.round((Math.abs(diff) / previous) * 100);
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular", diff > 0 ? "text-warning" : "text-positive")} title={`${diff > 0 ? "+" : "−"}${formatBRL(Math.abs(diff))} em relação à fatura anterior`}>
      <Icon className="size-3.5" aria-hidden />
      <span className="sr-only">{diff > 0 ? "aumento de" : "redução de"}</span>
      {pctValue}%
    </span>
  );
}

function sumNature(list: Array<StatementCategorySummary | null>): Record<TransactionNature, number> {
  const out: Record<TransactionNature, number> = { PERSONAL: 0, BUSINESS: 0, PASSTHROUGH: 0 };
  for (const s of list) if (s) for (const n of ["PERSONAL", "BUSINESS", "PASSTHROUGH"] as const) out[n] += s.byNature[n] ?? 0;
  return out;
}

/** "Gastos por categoria": fatura atual × anterior por cartão ou somando todos os cartões. */
export function CardsSpendingByCategoryCard({ onOpenStatement }: { onOpenStatement: (statementId: string) => void }) {
  const q = useQuery({ queryKey: qk.cards({ spendingByCategory: true }), queryFn: () => api.get<CardsSpendingByCategory>("/api/v1/cards/spending-by-category") });
  const [selected, setSelected] = useState<string>(ALL);
  const [expanded, setExpanded] = useState(false);
  const data = q.data;
  const cardEntry = data?.cards.find((c) => c.card.id === selected) ?? null;
  const isAll = !cardEntry;

  const current = isAll ? data?.combined.current : cardEntry.current;
  const previous = isAll ? data?.combined.previous : cardEntry.previous;
  const rows = compareRows(current?.byCategory ?? [], previous?.byCategory ?? []);
  const shown = expanded ? rows : rows.slice(0, MAX_ROWS);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.currentCents, r.previousCents)));
  const byNature = isAll ? sumNature(data?.cards.map((c) => c.current) ?? []) : cardEntry.current?.byNature;
  const currentTotal = current?.totalCents ?? 0;
  const previousTotal = previous?.totalCents ?? 0;

  return (
    <Card aria-labelledby="cards-by-category-title">
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle id="cards-by-category-title" className="flex items-center gap-2">
            <PieChart className="size-4 text-brand" aria-hidden /> Gastos por categoria
          </CardTitle>
          <CardDescription className="mt-1 text-xs">Fatura atual (em aberto) × fatura anterior, pelo que entra na cobrança (parcelas do mês).</CardDescription>
        </div>
        {data && data.cards.length > 0 && (
          <CardAction className="ml-0 w-full sm:ml-auto sm:w-auto">
            <Select
              value={selected}
              onValueChange={(v) => {
                setSelected(v);
                setExpanded(false);
              }}
            >
              <SelectTrigger className="h-9 w-full sm:w-52" aria-label="Cartão">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos os cartões</SelectItem>
                {data.cards.map((c) => (
                  <SelectItem key={c.card.id} value={c.card.id}>
                    {c.card.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : q.error || !data ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        ) : !data.cards.length ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Cadastre um cartão para ver os gastos por categoria das faturas.</p>
        ) : (
          <div className={cn("space-y-4 transition-opacity", q.isFetching && "opacity-70")}>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0 rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">
                  Fatura atual
                  {cardEntry?.current && ` · ${formatMonthBR(cardEntry.current.referenceMonth, { short: true })}, vence ${formatDayMonthBR(cardEntry.current.dueDate)}`}
                </p>
                <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-lg font-semibold tabular">
                  {formatBRL(currentTotal)}
                  <Change current={currentTotal} previous={previousTotal} />
                </p>
                {cardEntry?.current && (
                  <button type="button" onClick={() => onOpenStatement(cardEntry.current!.statementId)} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                    <Receipt className="size-3.5" aria-hidden /> Ver fatura
                  </button>
                )}
              </div>
              <div className="min-w-0 rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">
                  Anterior
                  {cardEntry?.previous && ` · ${formatMonthBR(cardEntry.previous.referenceMonth, { short: true })}, venceu ${formatDayMonthBR(cardEntry.previous.dueDate)}`}
                </p>
                <p className="mt-0.5 text-lg font-semibold text-muted-foreground tabular">{formatBRL(previousTotal)}</p>
                {cardEntry?.previous && (
                  <button type="button" onClick={() => onOpenStatement(cardEntry.previous!.statementId)} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                    <Receipt className="size-3.5" aria-hidden /> Ver fatura
                  </button>
                )}
              </div>
            </div>

            {!rows.length ? (
              <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                {isAll ? "Nenhuma compra nas faturas atual e anterior dos cartões." : `Nenhuma compra nas faturas atual e anterior do ${cardEntry.card.name}.`}
              </p>
            ) : (
              <>
                <CategoryBar items={current?.byCategory ?? []} />
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
                  <span className="flex items-center gap-1.5">
                    <span className="flex h-1.5 w-5 overflow-hidden rounded-full">
                      <span className="w-1/3 bg-series-1" />
                      <span className="w-1/3 bg-series-4" />
                      <span className="w-1/3 bg-series-3" />
                    </span>
                    Barra colorida: fatura atual
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1 w-5 rounded-full bg-muted-foreground/35" /> cinza: anterior
                  </span>
                </p>
                <ul className="grid gap-x-8 gap-y-3 lg:grid-cols-2">
                  {shown.map((r) => (
                    <li key={r.key} className="min-w-0">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />
                          <span className={cn("truncate", r.isUncategorized && "text-muted-foreground")}>{r.name}</span>
                        </span>
                        <span className="flex shrink-0 items-baseline gap-2">
                          <Change current={r.currentCents} previous={r.previousCents} />
                          <span className="font-medium tabular">{formatBRL(r.currentCents)}</span>
                        </span>
                      </div>
                      <div className="mt-1 space-y-0.5" aria-hidden>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${(r.currentCents / max) * 100}%`, backgroundColor: r.color }} />
                        </div>
                        <div className="h-1 overflow-hidden rounded-full">
                          <div className="h-full rounded-full bg-muted-foreground/35" style={{ width: `${(r.previousCents / max) * 100}%` }} />
                        </div>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground tabular">
                        anterior {formatBRL(r.previousCents)}
                        {currentTotal > 0 && r.currentCents > 0 && ` · ${((r.currentCents / currentTotal) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% da atual`}
                      </p>
                    </li>
                  ))}
                </ul>
                {rows.length > MAX_ROWS && (
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                    {expanded ? <ChevronUp /> : <ChevronDown />}
                    {expanded ? "Mostrar menos" : `Mostrar todas as ${rows.length} categorias`}
                  </Button>
                )}
              </>
            )}
            <NatureBreakdown byNature={byNature} label="Fatura atual por natureza" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
