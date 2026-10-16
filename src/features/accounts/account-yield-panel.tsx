"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowUpRight, CircleCheck, Clock, Info, RefreshCw, Scale, TrendingUp, TriangleAlert } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDayMonthBR, formatMonthBR, todayISO } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";
import type { AccountDTO } from "@/features/finance/types";
import { supportsYield, useAccountYield, useRefreshYield, type AccountYield, type YieldRefreshResult, type YieldStatus } from "./yield";

const STATUS: Record<YieldStatus, { label: string; variant: "positive" | "warning" | "info"; icon: typeof CircleCheck; hint?: string }> = {
  OK: { label: "Em dia", variant: "positive", icon: CircleCheck },
  BEHIND: { label: "Atrasado", variant: "warning", icon: TriangleAlert, hint: "A última apuração tem mais de 6 dias. O sistema tenta de novo automaticamente a cada 3 horas." },
  WAITING_RATES: { label: "Aguardando taxas", variant: "info", icon: Clock, hint: "Ainda não há taxas do Banco Central guardadas. Elas são buscadas automaticamente a cada 3 horas." },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function refreshMessage(r: YieldRefreshResult): string {
  const parts = [
    r.created && plural(r.created, "mês lançado", "meses lançados"),
    r.updated && plural(r.updated, "mês recalculado", "meses recalculados"),
    r.removed && plural(r.removed, "lançamento removido", "lançamentos removidos"),
  ].filter(Boolean);
  return parts.length ? `Rendimento atualizado: ${parts.join(", ")}.` : "Rendimento conferido: nada mudou.";
}

function Estimate({ estimate }: { estimate: Extract<AccountYield, { configured: true }>["estimate"] }) {
  return (
    <section aria-labelledby="yield-estimate-title" className="rounded-xl border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="yield-estimate-title" className="text-sm font-medium">
          Estimativa líquida
        </h4>
        <Badge variant="muted">estimativa · se resgatasse hoje</Badge>
      </div>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Rendimento bruto</dt>
        <dd className="text-right tabular">{formatBRL(estimate.grossGainCents)}</dd>
        <dt className="text-muted-foreground">IR</dt>
        <dd className="text-right tabular">{estimate.exempt ? "isento" : estimate.irCents ? `−${formatBRL(estimate.irCents)}` : formatBRL(0)}</dd>
        <dt className="text-muted-foreground">IOF</dt>
        <dd className="text-right tabular">{estimate.iofCents ? `−${formatBRL(estimate.iofCents)}` : formatBRL(0)}</dd>
        <dt className="border-t pt-1 font-medium">Líquido estimado</dt>
        <dd className="border-t pt-1 text-right font-semibold tabular">{formatBRL(estimate.netGainCents)}</dd>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">{estimate.note}</p>
    </section>
  );
}

function Months({ data, today }: { data: Extract<AccountYield, { configured: true }>; today: string }) {
  const months = [...data.months].reverse();
  return (
    <section aria-labelledby="yield-months-title" className="space-y-2">
      <h4 id="yield-months-title" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Rendimento por mês
      </h4>
      {!months.length ? (
        <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
          {data.startDate >= today
            ? `O rendimento começa a contar em ${formatDateBR(data.startDate)}.`
            : data.status === "WAITING_RATES"
              ? "Nenhum rendimento lançado ainda: assim que as taxas do Banco Central chegarem, o rendimento é lançado."
              : "Nenhum rendimento lançado ainda."}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {months.map((m) => {
            const monthName = formatMonthBR(m.month, { capitalize: true });
            return (
              <li key={m.month} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{monthName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {m.dismissed ? "excluído — não será recriado" : `${plural(m.businessDays, "dia útil", "dias úteis")} · até ${formatDayMonthBR(m.accruedThrough)}`}
                  </span>
                </span>
                <span className={cn("shrink-0 tabular", m.dismissed ? "text-muted-foreground line-through" : "font-medium text-positive")}>
                  {m.dismissed && <span className="sr-only">Excluído: </span>}
                  {formatBRL(m.grossCents)}
                </span>
                {m.transactionId && !m.dismissed ? (
                  <Link
                    href={`/transacoes?id=${m.transactionId}`}
                    className="-mr-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Ver lançamento de ${monthName.toLowerCase()}`}
                    title="Ver lançamento"
                  >
                    <ArrowUpRight className="size-4" aria-hidden />
                  </Link>
                ) : (
                  <span className="-mr-1 size-7 shrink-0" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Painel do rendimento automático no detalhe da conta (investimento/poupança). */
export function AccountYieldPanel({ account, canWrite, onConfigure, onAdjustBank }: { account: AccountDTO; canWrite: boolean; onConfigure: () => void; onAdjustBank: () => void }) {
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const eligible = supportsYield(account.type) && !account.archivedAt;
  const q = useAccountYield(account.id, eligible);
  const refresh = useRefreshYield(account.id);
  const [result, setResult] = useState<{ text: string; tone: "ok" | "info" | "error" } | null>(null);

  if (!eligible) return null;
  if (q.isLoading) return <Skeleton className="h-48 rounded-xl" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact />;
  const data = q.data;
  if (!data) return null;

  if (!data.configured) {
    if (!canWrite) return null;
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-dashed p-4 sm:flex-row sm:items-center">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <TrendingUp className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">Rendimento automático</p>
          <p className="text-xs text-muted-foreground">Informe o indexador e a taxa (ex.: 101,5% do CDI) e o rendimento é lançado todo mês com as taxas do Banco Central.</p>
        </div>
        <Button size="sm" variant="outline" className="self-start sm:self-center" onClick={onConfigure}>
          Configurar
        </Button>
      </div>
    );
  }

  const status = STATUS[data.status];
  const StatusIcon = status.icon;
  const runRefresh = () => {
    setResult(null);
    refresh.mutate(undefined, {
      onSuccess: (res) => {
        const ratesDown = res.rateErrors.length > 0;
        const text = ratesDown ? "O Banco Central não respondeu agora. O rendimento foi conferido com as taxas já guardadas e o sistema tenta de novo automaticamente." : refreshMessage(res);
        setResult({ text, tone: ratesDown ? "info" : "ok" });
        if (ratesDown) toast.info("Banco Central indisponível no momento", { description: "Usamos as taxas já guardadas. Nova tentativa automática em até 3 horas." });
        else toast.success("Rendimento atualizado", { description: refreshMessage(res) });
      },
      onError: (err) => {
        setResult({ text: errorMessage(err), tone: "error" });
        toast.error(errorMessage(err));
      },
    });
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-1.5">
            <TrendingUp className="size-4 text-brand" aria-hidden /> Rendimento automático
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            {data.label} · desde {formatDateBR(data.startDate)}
          </CardDescription>
        </div>
        <CardAction>
          <Badge variant={status.variant}>
            <StatusIcon aria-hidden /> {status.label}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">Rendimento bruto lançado</p>
          <p className="text-2xl font-semibold tracking-tight text-positive tabular">{formatBRL(data.grossCents)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.ratesThrough ? `Taxas do Banco Central até ${formatDateBR(data.ratesThrough)}` : "Ainda sem taxas do Banco Central"}
            {data.accruedThrough && ` · apurado até ${formatDateBR(data.accruedThrough)}`}
          </p>
          {status.hint && <p className="mt-1 text-xs text-muted-foreground">{status.hint}</p>}
        </div>

        <Estimate estimate={data.estimate} />
        <Months data={data} today={today} />

        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={runRefresh} loading={refresh.isPending}>
              {!refresh.isPending && <RefreshCw />} Atualizar agora
            </Button>
            <Button size="sm" variant="outline" onClick={onAdjustBank}>
              <Scale /> Ajustar ao saldo do banco
            </Button>
          </div>
        )}
        <div aria-live="polite" role="status">
          {result && (
            <p
              className={cn(
                "flex gap-2 rounded-lg px-3 py-2 text-xs",
                result.tone === "info" && "bg-info/10 text-info",
                result.tone === "ok" && "bg-muted text-muted-foreground",
                result.tone === "error" && "bg-destructive/5 text-destructive",
              )}
            >
              {result.tone === "error" ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
              {result.text}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
