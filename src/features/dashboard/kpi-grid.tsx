"use client";

import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, CalendarClock, CreditCard, Landmark, PiggyBank, Scale, TrendingDown, TrendingUp, Wallet, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";

export interface DashboardSummary {
  regime: "ACCRUAL" | "CASH";
  period: { start: string; end: string };
  availableBalanceCents: number;
  incomeCents: number;
  expenseCents: number;
  resultCents: number;
  comparison: { incomeChangePct: number | null; expenseChangePct: number | null; previousIncomeCents: number; previousExpenseCents: number };
  futureStatementsCents: number;
  billsToPay: { totalCents: number; scheduledCents: number; scheduledCount: number; statementsCents: number; overdueCount: number };
  budget: { month: string; limitCents: number; spentCents: number; availableCents: number; hasBudgets: boolean };
  netWorth: { assetsCents: number; cardDebtCents: number; netWorthCents: number };
}

function Delta({ pct, invert }: { pct: number | null; invert?: boolean }) {
  if (pct === null) return <span className="text-xs text-muted-foreground">sem base de comparação</span>;
  const up = pct > 0;
  // Para despesas, aumento é sinalizado sem cor de alarme: apenas direção + texto.
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const good = invert ? !up : up;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", pct === 0 ? "text-muted-foreground" : good ? "text-positive" : "text-muted-foreground")}>
      <Icon className="size-3.5" aria-hidden />
      {Math.abs(pct).toLocaleString("pt-BR")}% <span className="font-normal text-muted-foreground">vs. período anterior</span>
    </span>
  );
}

function Kpi({
  label,
  value,
  icon: Icon,
  hint,
  footer,
  href,
  emphasis,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  hint: string;
  footer?: React.ReactNode;
  href?: string;
  emphasis?: boolean;
}) {
  const content = (
    <Card className={cn("group h-full p-5 transition hover:border-ring/40", emphasis && "border-transparent bg-gradient-to-br from-[#0b2545] to-[#0e3a5c] text-white dark:from-[#0d2a4a] dark:to-[#0b3b37]")}>
      <div className="flex items-start justify-between gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <p className={cn("cursor-help text-[13px] font-medium", emphasis ? "text-white/75" : "text-muted-foreground")}>{label}</p>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{hint}</TooltipContent>
        </Tooltip>
        <span className={cn("flex size-8 items-center justify-center rounded-lg", emphasis ? "bg-white/10 text-emerald-300" : "bg-accent text-accent-foreground")}>
          <Icon className="size-4" />
        </span>
      </div>
      <p className={cn("mt-3 text-[26px] font-semibold leading-none tracking-tight", value < 0 && !emphasis && "text-negative")}>{formatBRL(value)}</p>
      {footer && <div className={cn("mt-2", emphasis && "[&_*]:text-white/70")}>{footer}</div>}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {content}
    </Link>
  ) : (
    content
  );
}

export function KpiGrid({ data, isLoading }: { data?: DashboardSummary; isLoading: boolean }) {
  if (isLoading || !data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[122px] rounded-xl" />
        ))}
      </div>
    );
  }
  const budgetPct = data.budget.limitCents ? Math.round((data.budget.spentCents / data.budget.limitCents) * 100) : null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        emphasis
        label="Saldo disponível"
        value={data.availableBalanceCents}
        icon={Wallet}
        hint="Soma dos saldos das contas incluídas nos totais (exceto investimentos). Compras no cartão não reduzem o saldo até o pagamento da fatura."
        href="/contas"
        footer={<span className="text-xs">em contas e carteiras</span>}
      />
      <Kpi label="Receitas do período" value={data.incomeCents} icon={TrendingUp} hint="Receitas confirmadas no período, conforme o regime selecionado." href="/transacoes?type=INCOME" footer={<Delta pct={data.comparison.incomeChangePct} />} />
      <Kpi
        label="Despesas do período"
        value={data.expenseCents}
        icon={TrendingDown}
        hint={data.regime === "CASH" ? "Regime de caixa: débito/Pix/dinheiro na data do pagamento; cartão pelo valor das parcelas no vencimento da fatura." : "Regime de competência: valor total na data de competência (compra), inclusive parcelados."}
        href="/transacoes?type=EXPENSE"
        footer={<Delta pct={data.comparison.expenseChangePct} invert />}
      />
      <Kpi
        label="Resultado do período"
        value={data.resultCents}
        icon={Scale}
        hint="Receitas menos despesas do período. Transferências e pagamentos de fatura não entram no cálculo."
        footer={<span className="text-xs text-muted-foreground">{data.resultCents >= 0 ? "Receitas acima das despesas" : "Despesas acima das receitas"}</span>}
      />
      <Kpi
        label="Faturas futuras"
        value={data.futureStatementsCents}
        icon={CreditCard}
        hint="Saldo em aberto das faturas de cartão que ainda vão vencer, incluindo parcelas futuras já lançadas."
        href="/cartoes"
        footer={<span className="text-xs text-muted-foreground">compromissos de cartão</span>}
      />
      <Kpi
        label="Contas a pagar"
        value={data.billsToPay.totalCents}
        icon={CalendarClock}
        hint="Contas previstas pendentes até o fim do mês (inclusive vencidas) + faturas de cartão com vencimento até o fim do mês."
        href="/contas-a-pagar"
        footer={
          <span className="text-xs text-muted-foreground">
            {data.billsToPay.scheduledCount} conta(s){data.billsToPay.overdueCount > 0 ? ` · ${data.billsToPay.overdueCount} vencida(s)` : ""}
          </span>
        }
      />
      <Kpi
        label="Orçamento disponível"
        value={data.budget.availableCents}
        icon={PiggyBank}
        hint="Quanto ainda resta dentro dos limites definidos para o mês atual (soma das categorias com orçamento)."
        href="/orcamentos"
        footer={
          <span className="text-xs text-muted-foreground">{data.budget.hasBudgets ? `${budgetPct ?? 0}% de ${formatBRL(data.budget.limitCents)} utilizado` : "Nenhum orçamento definido"}</span>
        }
      />
      <Kpi
        label="Patrimônio financeiro"
        value={data.netWorth.netWorthCents}
        icon={Landmark}
        hint="Saldo de todas as contas (inclui investimentos) menos o saldo devedor dos cartões. Não confundir com renda."
        footer={<span className="text-xs text-muted-foreground">Ativos {formatBRL(data.netWorth.assetsCents, { compact: true })} · Cartões {formatBRL(data.netWorth.cardDebtCents, { compact: true })}</span>}
      />
    </div>
  );
}
