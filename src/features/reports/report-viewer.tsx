"use client";

import { useState } from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BadgeCheck, CalendarClock, CalendarRange, Clock3, FileSpreadsheet, FileText, Repeat, Sheet as SheetIcon, Target, Telescope, Users, UserRound } from "lucide-react";
import { ChartCard } from "@/components/charts/chart-card";
import { ChartTooltip, axisTick, compactBRL } from "@/components/charts/chart-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDateTimeBR, formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CertaintyBadge, Delta, RankedBars, ReportSection, StatTile } from "./report-ui";
import { downloadWithToast } from "./use-reports";
import type { MonthlyReportData, ReportData, ReportView, WeeklyReportData } from "./types";

const SERIES = { income: "var(--series-3)", expense: "var(--series-2)", projection: "var(--series-7)" };

// -----------------------------------------------------------------------------
// Cabeçalho e exportação
// -----------------------------------------------------------------------------

function ExportButtons({ report }: { report: ReportView }) {
  const [busy, setBusy] = useState<string | null>(null);
  const base = report.type === "WEEKLY" ? `relatorio-semanal-${report.periodStart}` : `relatorio-mensal-${report.periodStart.slice(0, 7)}`;
  const run = async (format: "pdf" | "xlsx" | "csv", label: string) => {
    setBusy(format);
    await downloadWithToast(`/api/v1/reports/${report.id}/export`, { format }, `${base}.${format}`, label);
    setBusy(null);
  };
  return (
    <div className="flex shrink-0 flex-wrap gap-2" role="group" aria-label="Exportar relatório">
      <Button variant="outline" size="sm" loading={busy === "pdf"} disabled={Boolean(busy)} onClick={() => run("pdf", "PDF")}>
        <FileText /> PDF
      </Button>
      <Button variant="outline" size="sm" loading={busy === "xlsx"} disabled={Boolean(busy)} onClick={() => run("xlsx", "Planilha Excel")}>
        <FileSpreadsheet /> Excel
      </Button>
      <Button variant="outline" size="sm" loading={busy === "csv"} disabled={Boolean(busy)} onClick={() => run("csv", "CSV das transações")} title="Transações do período em CSV (pt-BR)">
        <SheetIcon /> CSV
      </Button>
    </div>
  );
}

function ReportHeader({ report }: { report: ReportView }) {
  const d = report.data;
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{d.type === "WEEKLY" ? "Relatório semanal" : "Relatório mensal"}</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{d.periodLabel}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">
              <CalendarRange aria-hidden /> {formatDateBR(d.period.start)} a {formatDateBR(d.period.end)}
            </Badge>
            <Badge variant="secondary">Regime: {d.regimeLabel}</Badge>
            <Badge variant="secondary">
              {d.scope === "FAMILY" ? <Users aria-hidden /> : <UserRound aria-hidden />}
              {d.scope === "FAMILY" ? "Família (sem contas privadas)" : "Pessoal (inclui suas contas privadas)"}
            </Badge>
            {d.isPartial && (
              <Badge variant="warning">
                <Clock3 aria-hidden /> Em andamento · valores parciais
              </Badge>
            )}
            {report.scheduled && (
              <Badge variant="muted">
                <CalendarClock aria-hidden /> Programado
              </Badge>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Gerado em {formatDateTimeBR(d.generatedAt, d.timezone)}</p>
        </div>
        <ExportButtons report={report} />
      </div>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// Blocos comuns
// -----------------------------------------------------------------------------

function TopCategories({ data, limit }: { data: ReportData; limit: number }) {
  const items = data.topCategories;
  const shown = items.slice(0, limit);
  const rest = items.slice(limit);
  const max = Math.max(1, ...shown.map((i) => i.amountCents));
  return (
    <ReportSection title={data.type === "WEEKLY" ? "Principais categorias" : "Maiores categorias de despesa"} description={`Total de despesas: ${formatBRL(data.totals.expenseCents)}`} certainty="CONFIRMED">
      {!items.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma despesa confirmada no período.</p>
      ) : (
        <>
          <RankedBars
            items={shown.map((c) => ({ key: c.categoryId ?? "none", label: c.name, value: formatBRL(c.amountCents), percent: c.percent, ratio: c.amountCents / max, color: c.color }))}
          />
          {rest.length > 0 && (
            <p className="mt-3 flex justify-between text-sm text-muted-foreground">
              <span>Outras ({rest.length})</span>
              <span className="tabular">{formatBRL(rest.reduce((s, c) => s + c.amountCents, 0))}</span>
            </p>
          )}
        </>
      )}
    </ReportSection>
  );
}

function TopExpenses({ data, compact }: { data: ReportData; compact?: boolean }) {
  const items = data.topExpenses;
  return (
    <ReportSection
      title="Maiores despesas"
      certainty="CONFIRMED"
      description={data.regime === "CASH" ? "No regime de caixa, compras parceladas aparecem pelo valor das parcelas do período." : "Pelo valor total da compra (competência)."}
    >
      {!items.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma despesa confirmada no período.</p>
      ) : (
        <>
          <div className={cn("hidden", !compact && "md:block")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((t) => (
                  <TableRow key={t.transactionId}>
                    <TableCell className="tabular text-muted-foreground">{formatDateBR(t.date)}</TableCell>
                    <TableCell className="max-w-72">
                      <span className="block truncate font-medium">{t.description}</span>
                      {t.installmentCount > 1 && <span className="text-xs text-muted-foreground">Parcelado em {t.installmentCount}x</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.categoryName ?? "Sem categoria"}</TableCell>
                    <TableCell className="text-right font-medium tabular">{formatBRL(t.amountCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className={cn("divide-y", !compact && "md:hidden")}>
            {items.map((t) => (
              <li key={t.transactionId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateBR(t.date)} · {t.categoryName ?? "Sem categoria"}
                    {t.installmentCount > 1 && ` · ${t.installmentCount}x`}
                  </p>
                </div>
                <span className="shrink-0 font-medium tabular">{formatBRL(t.amountCents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </ReportSection>
  );
}

function OriginSection({ data }: { data: ReportData }) {
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="text-[15px] font-semibold">Origem do cálculo</h3>
      <p className="mt-1 text-sm text-muted-foreground">{data.origin.summary}</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-positive/25 bg-positive/5 p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-positive">
            <BadgeCheck className="size-4" aria-hidden /> Dados confirmados
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
            {data.origin.confirmed.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-info/25 bg-info/5 p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-info">
            <Telescope className="size-4" aria-hidden /> Projeções e estimativas
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
            {data.origin.projections.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function ComparisonTable({ rows, previousLabel }: { rows: Array<{ label: string; current: number; previous: number; pct: number | null; goodWhenDown?: boolean; signed?: boolean }>; previousLabel: string }) {
  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-3 text-sm">
          <span className="font-medium">{r.label}</span>
          <span className="text-right font-semibold tabular">{formatBRL(r.current, { signed: r.signed })}</span>
          <span className="text-xs text-muted-foreground">
            {previousLabel}: <span className="tabular">{formatBRL(r.previous, { signed: r.signed })}</span>
          </span>
          <span className="text-right">
            <Delta pct={r.pct} label="" goodWhenDown={r.goodWhenDown} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// Semanal
// -----------------------------------------------------------------------------

function UpcomingBills({ data }: { data: WeeklyReportData }) {
  const bills = data.upcomingBills;
  return (
    <ReportSection
      title="Contas a vencer"
      certainty="PROJECTION"
      description={`De ${formatDateBR(bills.from)} a ${formatDateBR(bills.to)} · contas previstas e faturas de cartão em aberto`}
      action={<span className="whitespace-nowrap text-sm font-semibold tabular">{formatBRL(bills.totalCents)}</span>}
    >
      {!bills.items.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma conta prevista ou fatura em aberto para os próximos 7 dias.</p>
      ) : (
        <ul className="divide-y">
          {bills.items.map((b, i) => (
            <li key={`${b.date}-${b.description}-${i}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{b.description}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="tabular">{formatDateBR(b.date)}</span>·<span>{b.kind === "CARD_STATEMENT" ? "Fatura de cartão" : "Conta prevista"}</span>
                  {b.overdue ? (
                    <Badge variant="warning">
                      <Clock3 aria-hidden /> Vencida
                    </Badge>
                  ) : (
                    <CertaintyBadge certainty={b.certainty} />
                  )}
                </p>
              </div>
              <span className="shrink-0 font-medium tabular">{formatBRL(b.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      <Link href="/contas-a-pagar" className="mt-3 inline-block text-sm font-medium text-brand hover:underline">
        Ver contas a pagar
      </Link>
    </ReportSection>
  );
}

function WeeklyBody({ data }: { data: WeeklyReportData }) {
  const cmp = data.comparison;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatTile label="Total recebido" value={formatBRL(data.totals.incomeCents)} certainty="CONFIRMED">
          <Delta pct={cmp.incomeChangePct} label="vs. semana anterior" />
        </StatTile>
        <StatTile label="Total gasto" value={formatBRL(data.totals.expenseCents)} certainty="CONFIRMED">
          <Delta pct={cmp.expenseChangePct} label="vs. semana anterior" goodWhenDown />
        </StatTile>
        <StatTile label="Resultado da semana" value={formatBRL(data.totals.resultCents, { signed: true })} emphasis>
          {data.recognizedTransactions} lançamento(s) considerados
        </StatTile>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TopCategories data={data} limit={5} />
        <ReportSection title="Comparação com a semana anterior" certainty="CONFIRMED" description={`${formatDateBR(cmp.previousPeriod.start)} a ${formatDateBR(cmp.previousPeriod.end)}`}>
          <ComparisonTable
            previousLabel="Semana anterior"
            rows={[
              { label: "Recebido", current: data.totals.incomeCents, previous: cmp.previousIncomeCents, pct: cmp.incomeChangePct },
              { label: "Gasto", current: data.totals.expenseCents, previous: cmp.previousExpenseCents, pct: cmp.expenseChangePct, goodWhenDown: true },
              { label: "Resultado", current: data.totals.resultCents, previous: cmp.previousResultCents, pct: null, signed: true },
            ]}
          />
        </ReportSection>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <UpcomingBills data={data} />
        <TopExpenses data={data} compact />
      </div>
      <OriginSection data={data} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Mensal
// -----------------------------------------------------------------------------

function Evolution({ data }: { data: MonthlyReportData }) {
  const rows = data.evolution.map((e) => ({ ...e, label: formatMonthBR(e.month, { short: true }) }));
  const empty = rows.every((r) => !r.incomeCents && !r.expenseCents);
  return (
    <ChartCard
      title="Evolução mensal"
      description="Últimos 6 meses · receitas e despesas confirmadas"
      empty={empty && "Ainda não há movimentações suficientes."}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mês</TableHead>
              <TableHead className="text-right">Receitas</TableHead>
              <TableHead className="text-right">Despesas</TableHead>
              <TableHead className="text-right">Resultado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.month}>
                <TableCell>{formatMonthBR(r.month, { short: true })}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(r.incomeCents)}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(r.expenseCents)}</TableCell>
                <TableCell className={cn("text-right tabular", r.resultCents < 0 && "text-negative")}>{formatBRL(r.resultCents, { signed: true })}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={rows} barGap={2} barCategoryGap="24%" margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="incomeCents" name="Receitas" fill={SERIES.income} radius={[4, 4, 0, 0]} maxBarSize={24} />
          <Bar dataKey="expenseCents" name="Despesas" fill={SERIES.expense} radius={[4, 4, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function CategoryComparison({ data }: { data: MonthlyReportData }) {
  const cc = data.categoryComparison;
  const items = cc.items.slice(0, 10);
  const prevLabel = formatMonthBR(cc.previousPeriod.start.slice(0, 7));
  return (
    <ReportSection title="Comparação por categoria" certainty="CONFIRMED" description={`${data.periodLabel} × ${prevLabel} · maiores variações primeiro`}>
      {!items.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Sem despesas nos dois meses.</p>
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="text-right">Este mês</TableHead>
                  <TableHead className="text-right">Mês anterior</TableHead>
                  <TableHead className="text-right">Diferença</TableHead>
                  <TableHead className="text-right">Variação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.categoryId ?? "none"}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="size-2.5 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
                        {i.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular">{formatBRL(i.currentCents)}</TableCell>
                    <TableCell className="text-right tabular text-muted-foreground">{formatBRL(i.previousCents)}</TableCell>
                    <TableCell className="text-right tabular">{formatBRL(i.differenceCents, { signed: true })}</TableCell>
                    <TableCell className="text-right">
                      <Delta pct={i.changePct} label="" goodWhenDown />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="divide-y md:hidden">
            {items.map((i) => (
              <li key={i.categoryId ?? "none"} className="py-2.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
                    <span className="truncate font-medium">{i.name}</span>
                  </span>
                  <span className="font-medium tabular">{formatBRL(i.currentCents)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>
                    Anterior: <span className="tabular">{formatBRL(i.previousCents)}</span>
                  </span>
                  <Delta pct={i.changePct} label="" goodWhenDown />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Total: {formatBRL(cc.totalCurrentCents)} × {formatBRL(cc.totalPreviousCents)} (<Delta pct={cc.totalChangePct} label="" goodWhenDown />)
          </p>
        </>
      )}
    </ReportSection>
  );
}

function BudgetMeters({ data }: { data: MonthlyReportData }) {
  const b = data.budget;
  return (
    <ReportSection
      title="Orçamento: previsto × realizado"
      certainty="CONFIRMED"
      description={b.items.length ? `${formatBRL(b.totalSpentCents)} de ${formatBRL(b.totalLimitCents)} previstos` : undefined}
    >
      {!b.items.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nenhum orçamento definido para o mês.{" "}
          <Link href="/orcamentos" className="font-medium text-brand hover:underline">
            Definir orçamento
          </Link>
        </p>
      ) : (
        <ul className="space-y-3.5">
          {b.items.map((i) => {
            const over = i.percentUsed > 100;
            return (
              <li key={i.categoryId}>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
                    <span className="truncate">{i.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular">
                    {formatBRL(i.spentCents)} de {formatBRL(i.limitCents)}
                  </span>
                </div>
                <Progress
                  value={Math.min(100, i.percentUsed)}
                  indicatorClassName={over ? "bg-negative" : i.percentUsed >= 80 ? "bg-warning" : "bg-brand"}
                  aria-label={`${i.name}: ${i.percentUsed}% do previsto`}
                />
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span className={cn(over && "font-medium text-negative")}>
                    {i.percentUsed.toLocaleString("pt-BR")}% utilizado · {i.remainingCents >= 0 ? `restam ${formatBRL(i.remainingCents)}` : `${formatBRL(-i.remainingCents)} acima do previsto`}
                  </span>
                  {i.projectionIsEstimate && (
                    <span className="inline-flex items-center gap-1">
                      <Telescope className="size-3" aria-hidden /> projeção: {formatBRL(i.projectedCents)}
                    </span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </ReportSection>
  );
}

function Goals({ data }: { data: MonthlyReportData }) {
  return (
    <ReportSection title="Evolução das metas" certainty="CONFIRMED" description="Acumulado até o fim do mês (contribuições menos resgates)">
      {!data.goals.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nenhuma meta ativa.{" "}
          <Link href="/metas" className="font-medium text-brand hover:underline">
            Criar meta
          </Link>
        </p>
      ) : (
        <ul className="space-y-4">
          {data.goals.map((g) => (
            <li key={g.id}>
              <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  <Target className="size-4 shrink-0 text-brand" aria-hidden />
                  <span className="truncate">{g.name}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular">
                  {formatBRL(g.savedCents)} de {formatBRL(g.targetCents)}
                </span>
              </div>
              <Progress value={g.percent} indicatorClassName={g.percent >= 100 ? "bg-positive" : "bg-brand"} aria-label={`${g.name}: ${g.percent}% atingido`} />
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span className="tabular">{g.percent.toLocaleString("pt-BR")}% atingido</span>
                <span>· no mês: {g.contributedInPeriodCents ? formatBRL(g.contributedInPeriodCents, { signed: true }) : "sem contribuições"}</span>
                {g.deadline && <span>· prazo {formatDateBR(g.deadline)}</span>}
                {g.monthlyNeededCents !== null && (
                  <span className="inline-flex items-center gap-1">
                    · <Telescope className="size-3" aria-hidden /> necessário {formatBRL(g.monthlyNeededCents)}/mês
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </ReportSection>
  );
}

function Recurring({ data }: { data: MonthlyReportData }) {
  const r = data.recurringExpenses;
  return (
    <ReportSection
      title="Despesas recorrentes"
      certainty="PROJECTION"
      description="Recorrências ativas e o equivalente mensal de cada uma"
      action={<span className="whitespace-nowrap text-sm font-semibold tabular">{formatBRL(r.monthlyTotalCents)}/mês</span>}
    >
      {!r.items.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma despesa recorrente ativa.</p>
      ) : (
        <ul className="divide-y">
          {r.items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate font-medium">
                  <Repeat className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{i.description}</span>
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {i.frequencyLabel} · {formatBRL(i.amountCents)}
                  {i.categoryName && ` · ${i.categoryName}`}
                  {i.isEstimate && <Badge variant="muted">valor variável</Badge>}
                </p>
              </div>
              <span className="shrink-0 text-right font-medium tabular">
                {formatBRL(i.monthlyEquivalentCents)}
                <span className="block text-[11px] font-normal text-muted-foreground">por mês</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </ReportSection>
  );
}

function FutureInstallments({ data }: { data: MonthlyReportData }) {
  const f = data.futureInstallments;
  const rows = f.items.map((i) => ({ ...i, label: formatMonthBR(i.month, { short: true }) }));
  return (
    <ChartCard
      title="Parcelamentos futuros"
      description={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <CertaintyBadge certainty="PROJECTION" /> Faturas a vencer · posição em {formatDateBR(f.asOf)} · total {formatBRL(f.totalCents)}
        </span>
      }
      empty={!rows.length && "Nenhuma parcela futura em aberto."}
      height={220}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mês da fatura</TableHead>
              <TableHead className="text-right">Valor em aberto</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.month}>
                <TableCell>{formatMonthBR(r.month, { capitalize: true })}</TableCell>
                <TableCell className="text-right tabular">{formatBRL(r.amountCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={(p) => <ChartTooltip active={p.active} payload={p.payload as never} label={p.label as string} />} />
          <Bar dataKey="amountCents" name="Parcelas a vencer" fill={SERIES.projection} radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function MonthlyBody({ data }: { data: MonthlyReportData }) {
  const cmp = data.comparison;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatTile label="Receitas" value={formatBRL(data.totals.incomeCents)} certainty="CONFIRMED">
          <Delta pct={cmp.incomeChangePct} label="vs. mês anterior" />
        </StatTile>
        <StatTile label="Despesas" value={formatBRL(data.totals.expenseCents)} certainty="CONFIRMED">
          <Delta pct={cmp.expenseChangePct} label="vs. mês anterior" goodWhenDown />
        </StatTile>
        <StatTile label="Resultado do mês" value={formatBRL(data.totals.resultCents, { signed: true })} emphasis>
          Mês anterior: {formatBRL(cmp.previousResultCents, { signed: true })} · {data.recognizedTransactions} lançamento(s)
        </StatTile>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatTile label={`Saldo disponível em ${formatDateBR(data.balance.asOf)}`} value={formatBRL(data.balance.availableCents)} certainty="CONFIRMED" tone={data.balance.availableCents < 0 ? "negative" : "neutral"}>
          {data.balance.investmentsCents ? `Investimentos: ${formatBRL(data.balance.investmentsCents)}` : "Contas incluídas nos totais"}
        </StatTile>
        <StatTile label="Média mensal de gastos" value={data.previousMonths.months ? formatBRL(data.previousMonths.averageExpenseCents) : "—"} certainty="CONFIRMED">
          {data.previousMonths.months ? `Base: ${data.previousMonths.months} mês(es) anterior(es)` : "Sem histórico suficiente"}
        </StatTile>
        <StatTile label="Parcelas futuras no cartão" value={formatBRL(data.futureInstallments.totalCents)} certainty="PROJECTION">
          {data.futureInstallments.items.length} fatura(s) a vencer
        </StatTile>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Evolution data={data} />
        <TopCategories data={data} limit={8} />
      </div>
      <CategoryComparison data={data} />
      <div className="grid gap-4 xl:grid-cols-2">
        <BudgetMeters data={data} />
        <Goals data={data} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Recurring data={data} />
        <FutureInstallments data={data} />
      </div>
      <TopExpenses data={data} />
      <OriginSection data={data} />
    </div>
  );
}

export function ReportViewer({ report, isFetching }: { report: ReportView; isFetching?: boolean }) {
  return (
    <div className={cn("space-y-4 transition-opacity", isFetching && "opacity-60")} aria-busy={isFetching || undefined}>
      <ReportHeader report={report} />
      {report.data.type === "WEEKLY" ? <WeeklyBody data={report.data} /> : <MonthlyBody data={report.data} />}
    </div>
  );
}
