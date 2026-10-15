"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartTooltip, axisTick, compactBRL } from "@/components/charts/chart-tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { formatMonthBR } from "@/lib/dates";
import { useBudgetHistory } from "./use-budgets";

const ALL = "__all__";
const SERIES = { limit: "var(--series-1)", spent: "var(--series-2)" };

/** Evolução temporal: limite × realizado por mês (todas as categorias com orçamento ou uma categoria). */
export function BudgetHistoryChart({ month }: { month: string }) {
  const q = useBudgetHistory(month, 6);
  const [categoryId, setCategoryId] = useState(ALL);
  const series = q.data?.series ?? [];
  const selected = categoryId === ALL ? null : series.find((s) => s.category.id === categoryId) ?? null;
  const points = selected
    ? selected.points.map((p) => ({ month: p.month, limitCents: p.limitCents, spentCents: p.spentCents, percentUsed: p.percentUsed }))
    : (q.data?.totals ?? []).map((t) => ({ month: t.month, limitCents: t.limitCents || null, spentCents: t.spentCents, percentUsed: t.percentUsed }));
  const data = points.map((p) => ({ ...p, label: formatMonthBR(p.month, { short: true }) }));
  const empty = !series.length || data.every((d) => !d.limitCents && !d.spentCents);

  return (
    <ChartCard
      title="Limite × realizado"
      description={selected ? `${selected.category.name} · últimos 6 meses` : "Categorias com orçamento · últimos 6 meses"}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={empty && "Defina orçamentos para acompanhar a evolução mês a mês."}
      action={
        series.length > 0 ? (
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="h-8 w-32 text-xs" aria-label="Categoria do gráfico">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={ALL}>Todas</SelectItem>
              {series.map((s) => (
                <SelectItem key={s.category.id} value={s.category.id}>
                  {s.category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mês</TableHead>
              <TableHead className="text-right">Limite</TableHead>
              <TableHead className="text-right">Realizado</TableHead>
              <TableHead className="text-right">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((d) => (
              <TableRow key={d.month}>
                <TableCell>{formatMonthBR(d.month, { short: true })}</TableCell>
                <TableCell className="text-right tabular">{d.limitCents ? formatBRL(d.limitCents) : "—"}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(d.spentCents)}</TableCell>
                <TableCell className="text-right tabular">{d.percentUsed !== null ? `${d.percentUsed.toLocaleString("pt-BR")}%` : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} barGap={2} barCategoryGap="24%" margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="limitCents" name="Limite" fill={SERIES.limit} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="spentCents" name="Realizado" fill={SERIES.spent} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
