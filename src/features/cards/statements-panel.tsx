"use client";

import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronRight, Receipt } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartTooltip, axisTick, compactBRL } from "@/components/charts/chart-tooltip";
import { ErrorState } from "@/components/shared/error-state";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { CardDTO } from "@/features/finance/types";
import { StatementStatusBadge } from "./statement-status";
import type { Commitment, StatementListItem } from "./types";

/** Lista de faturas do cartão selecionado (tabela no desktop, cartões no mobile). */
export function StatementsPanel({ card, onOpen }: { card: CardDTO; onOpen: (statementId: string) => void }) {
  const q = useQuery({ queryKey: qk.statements(card.id), queryFn: () => api.get<StatementListItem[]>(`/api/v1/cards/${card.id}/statements`) });
  // Mais recentes primeiro.
  const items = [...(q.data ?? [])].sort((a, b) => b.referenceMonth.localeCompare(a.referenceMonth));
  const currentMonth = card.currentStatement.referenceMonth;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="size-4 text-brand" aria-hidden /> Faturas — {card.name}
        </CardTitle>
        <CardDescription>Fecha todo dia {card.closingDay} e vence todo dia {card.dueDay}. Clique em uma fatura para ver as compras e pagamentos.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        ) : items.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Nenhuma fatura ainda. As faturas aparecem quando há compras neste cartão.</p>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Referência</TableHead>
                    <TableHead>Fechamento</TableHead>
                    <TableHead>Vencimento</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Pago</TableHead>
                    <TableHead className="text-right">Restante</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead className="w-8">
                      <span className="sr-only">Abrir</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => (
                    <TableRow key={s.id} className={cn("cursor-pointer", s.referenceMonth === currentMonth && "bg-accent/40")} onClick={() => onOpen(s.id)}>
                      <TableCell className="whitespace-nowrap font-medium">
                        <button type="button" className="outline-none hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); onOpen(s.id); }}>
                          {formatMonthBR(s.referenceMonth, { capitalize: true })}
                        </button>
                        {s.referenceMonth === currentMonth && <span className="ml-2 text-xs font-normal text-muted-foreground">(atual)</span>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular">{formatDateBR(s.closingDate)}</TableCell>
                      <TableCell className="whitespace-nowrap tabular">{formatDateBR(s.dueDate)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right font-medium tabular">{formatBRL(s.totalCents)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular text-muted-foreground">{formatBRL(s.paidCents)}</TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular">{formatBRL(s.remainingCents)}</TableCell>
                      <TableCell>
                        <StatementStatusBadge status={s.status} />
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="divide-y rounded-xl border md:hidden">
              {items.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onOpen(s.id)} className={cn("flex w-full items-center gap-3 px-3 py-3 text-left outline-none focus-visible:bg-muted", s.referenceMonth === currentMonth && "bg-accent/40")}>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{formatMonthBR(s.referenceMonth, { capitalize: true })}</span>
                        <StatementStatusBadge status={s.status} />
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Fecha {formatDateBR(s.closingDate)} · vence {formatDateBR(s.dueDate)}
                      </span>
                      {s.paidCents > 0 && (
                        <span className="block text-xs text-muted-foreground tabular">
                          Pago {formatBRL(s.paidCents)} · restante {formatBRL(s.remainingCents)}
                        </span>
                      )}
                    </span>
                    <span className="font-semibold tabular">{formatBRL(s.totalCents)}</span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Compromissos futuros (faturas a vencer, incluindo parcelas futuras), somando todos os cartões. */
export function CommitmentsChart() {
  const q = useQuery({ queryKey: qk.cards({ commitments: 12 }), queryFn: () => api.get<Commitment[]>("/api/v1/cards/commitments", { months: 12 }) });
  const data = (q.data ?? []).map((c) => ({ ...c, label: formatMonthBR(c.month, { short: true }) }));
  const total = data.reduce((s, d) => s + d.amountCents, 0);
  return (
    <ChartCard
      title="Compromissos futuros nos cartões"
      description={data.length ? `Faturas a vencer (com parcelas futuras) · total ${formatBRL(total)}` : "Faturas a vencer, incluindo parcelas futuras"}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      onRetry={() => q.refetch()}
      empty={!data.length && "Nenhuma fatura a vencer."}
      height={240}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fatura (mês de vencimento)</TableHead>
              <TableHead className="text-right">Valor em aberto</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((d) => (
              <TableRow key={d.month}>
                <TableCell>{formatMonthBR(d.month, { capitalize: true })}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(d.amountCents)}</TableCell>
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
          <Bar dataKey="amountCents" name="Em aberto" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

