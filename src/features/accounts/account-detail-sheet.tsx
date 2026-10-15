"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Archive, ArrowRight, EyeOff, Lock, PencilLine, Scale, Users } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartTooltip, axisTick, compactBRL } from "@/components/charts/chart-tooltip";
import { ErrorState } from "@/components/shared/error-state";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDayMonthBR } from "@/lib/dates";
import { ACCOUNT_TYPE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { AccountDTO, TransactionList } from "@/features/finance/types";
import { AmountText, TransactionIcon, categoryLabel } from "@/features/transactions/transaction-visuals";
import { AccountIcon } from "./account-icon";

const RANGES = [
  ["last30", "30 dias"],
  ["last3Months", "3 meses"],
  ["last6Months", "6 meses"],
  ["last12Months", "12 meses"],
] as const;

function BalanceChart({ account }: { account: AccountDTO }) {
  const [preset, setPreset] = useState<(typeof RANGES)[number][0]>("last3Months");
  const params = { preset, accountIds: [account.id] };
  const q = useQuery({
    queryKey: qk.accounts({ history: params }),
    queryFn: () => api.get<{ points: Array<{ date: string; balanceCents: number }> }>("/api/v1/accounts/balance-history", params),
    placeholderData: keepPreviousData,
    enabled: account.includeInTotals && !account.archivedAt,
  });
  const points = q.data?.points ?? [];
  const step = Math.max(1, Math.ceil(points.length / 120));
  const data = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => ({ ...p, label: formatDayMonthBR(p.date) }));
  const unsupported = !account.includeInTotals || Boolean(account.archivedAt);
  const gradientId = `acc-fill-${account.id}`;

  return (
    <ChartCard
      title="Evolução do saldo"
      description="Saldo ao fim de cada dia"
      isLoading={!unsupported && q.isLoading}
      isFetching={q.isFetching}
      error={unsupported ? undefined : q.error}
      onRetry={() => q.refetch()}
      height={200}
      empty={
        unsupported
          ? "O histórico de saldo considera apenas contas ativas incluídas nos totais."
          : !data.length && "Sem dados de saldo no período."
      }
      action={
        <div className="flex rounded-lg bg-muted p-0.5" role="group" aria-label="Período do gráfico">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={preset === value}
              onClick={() => setPreset(value)}
              className={cn("h-7 rounded-md px-2 text-xs font-medium transition", preset === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
      }
      table={
        <div className="max-h-[220px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...data].reverse().map((d) => (
                <TableRow key={d.date}>
                  <TableCell>{formatDateBR(d.date)}</TableCell>
                  <TableCell className="text-right tabular">{formatBRL(d.balanceCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-3)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--series-3)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={52} />
          <Tooltip cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "3 3" }} content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Area type="monotone" dataKey="balanceCents" name="Saldo" stroke="var(--series-3)" strokeWidth={2} fill={`url(#${gradientId})`} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function RecentTransactions({ account }: { account: AccountDTO }) {
  const params = { accountId: account.id, sort: "date_desc", pageSize: 10 };
  const q = useQuery({ queryKey: qk.transactions(params), queryFn: () => api.get<TransactionList>("/api/v1/transactions", params) });
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Últimas movimentações</h3>
        <Link href={`/transacoes?accountId=${account.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
          Ver todas <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
      ) : !q.data?.items.length ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Nenhuma movimentação nesta conta ainda.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {q.data.items.map((tx) => (
            <li key={tx.id}>
              <Link href={`/transacoes?id=${tx.id}`} className="flex items-center gap-3 px-3 py-2.5 text-sm transition hover:bg-muted/50">
                <TransactionIcon tx={tx} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{tx.description}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatDateBR(tx.date)} · {categoryLabel(tx)}
                    {tx.status === "PENDING" && " · pendente"}
                  </span>
                </span>
                <AmountText tx={tx} accountId={account.id} className="text-sm" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AccountDetailSheet({
  account,
  open,
  onOpenChange,
  onEdit,
  onAdjust,
  canWrite,
}: {
  account: AccountDTO | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onEdit: () => void;
  onAdjust: () => void;
  canWrite: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 sm:max-w-xl">
        {!account ? (
          <SheetHeader>
            <SheetTitle>Conta não encontrada</SheetTitle>
            <SheetDescription>Ela pode ter sido excluída ou você não tem acesso a ela.</SheetDescription>
          </SheetHeader>
        ) : (
          <>
            <SheetHeader className="pb-4">
              <div className="flex items-start gap-3">
                <AccountIcon type={account.type} icon={account.icon} color={account.color} size="lg" />
                <div className="min-w-0">
                  <SheetTitle className="break-words">{account.name}</SheetTitle>
                  <SheetDescription>
                    {[account.institution, labelOf(ACCOUNT_TYPE_LABELS, account.type), account.ownerName && `titular ${account.ownerName}`].filter(Boolean).join(" · ")}
                  </SheetDescription>
                </div>
              </div>
              <p className={cn("mt-3 text-3xl font-semibold tracking-tight tabular", account.balanceCents < 0 && "text-negative")}>{formatBRL(account.balanceCents)}</p>
              <p className="text-xs text-muted-foreground">
                Saldo atual · saldo inicial {formatBRL(account.initialBalanceCents)} em {formatDateBR(account.initialBalanceDate)}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {account.visibility === "PRIVATE" ? (
                  <Badge variant="muted">
                    <Lock aria-hidden /> Privada
                  </Badge>
                ) : (
                  <Badge variant="muted">
                    <Users aria-hidden /> Compartilhada
                  </Badge>
                )}
                {!account.includeInTotals && (
                  <Badge variant="warning">
                    <EyeOff aria-hidden /> Fora dos totais
                  </Badge>
                )}
                {account.archivedAt && (
                  <Badge variant="muted">
                    <Archive aria-hidden /> Arquivada
                  </Badge>
                )}
              </div>
            </SheetHeader>
            {canWrite && (
              <div className="flex flex-wrap gap-2 border-b px-5 pb-4">
                <Button size="sm" variant="outline" onClick={onEdit}>
                  <PencilLine /> Editar
                </Button>
                {!account.archivedAt && (
                  <Button size="sm" variant="outline" onClick={onAdjust}>
                    <Scale /> Ajustar saldo
                  </Button>
                )}
              </div>
            )}
            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              <BalanceChart account={account} />
              <RecentTransactions account={account} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
