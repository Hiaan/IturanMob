"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, Handshake, Info } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { describePeriod, formatDateBR, formatDayMonthBR } from "@/lib/dates";
import { formatBRL, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { TransactionList } from "@/features/finance/types";
import { balanceMeaning, sameParty, usePassthrough, type PassthroughParty } from "./report-exclusion";

type Period = { start: string; end: string };

const NO_PARTY = "Sem cliente informado";

/** Link para Lançamentos com só os desconsiderados (no período, ou em todo o período). */
export function excludedListHref(period: Period | null): string {
  const sp = new URLSearchParams({ excluded: "only" });
  if (period) {
    sp.set("start", period.start);
    sp.set("end", period.end);
  } else sp.set("period", "all");
  return `/transacoes?${sp.toString()}`;
}

function Stat({ label, value, className, children, srLabel }: { label: string; value: string; className?: string; children?: React.ReactNode; srLabel?: boolean }) {
  return (
    <div className="min-w-0">
      {/* Rótulo visível só no celular (no computador, o cabeçalho da tabela diz o que é). */}
      <p className={cn("text-[11px] text-muted-foreground", srLabel ? "sr-only" : "sm:sr-only")}>{label}</p>
      <p className={cn("truncate text-sm font-semibold tabular", className)}>{value}</p>
      {children}
    </div>
  );
}

/** Saldo do repasse com o significado (a receber / recebido a mais), sem depender só de cor. */
export function PassthroughBalance({ cents, className, srLabel }: { cents: number; className?: string; srLabel?: boolean }) {
  const m = balanceMeaning(cents);
  return (
    <Stat label="Saldo" srLabel={srLabel} value={formatBRL(Math.abs(cents))} className={cn(m.tone === "receivable" ? "text-warning" : m.tone === "surplus" ? "text-info" : "text-muted-foreground", className)}>
      <p className="text-[11px] leading-tight text-muted-foreground" title={m.detail ?? undefined}>
        <span className="font-medium text-foreground/80">{m.label}</span>
        {m.detail && <span className="sr-only"> ({m.detail})</span>}
      </p>
    </Stat>
  );
}

/** Lançamentos do cliente (carregados ao expandir; os desconsiderados do período, filtrados pelo cliente). */
function PartyItems({ party, period }: { party: string | null; period: Period | null }) {
  const params = { excluded: "only", status: "CONFIRMED", types: ["INCOME", "EXPENSE"], start: period?.start, end: period?.end, sort: "date_desc", page: 1, pageSize: 500 };
  const q = useQuery({ queryKey: qk.transactions(params), queryFn: () => api.get<TransactionList>("/api/v1/transactions", params) });
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.error) return <p className="text-xs text-destructive">Não foi possível carregar os lançamentos.</p>;
  const items = (q.data?.items ?? []).filter((t) => t.exclusion?.reason === "CLIENT_PASSTHROUGH" && sameParty(t.exclusion.party, party));
  if (!items.length) return <p className="text-xs text-muted-foreground">Nenhum lançamento encontrado.</p>;
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {items.map((t) => (
        <li key={t.id}>
          <Link href={`/transacoes?id=${t.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm transition hover:bg-muted/50">
            <span className="min-w-0">
              <span className="block truncate">{t.description}</span>
              <span className="block text-xs text-muted-foreground">
                {formatDateBR(t.date)} · {t.creditCard?.name ?? t.account?.name ?? "sem conta"}
              </span>
            </span>
            <span className={cn("shrink-0 whitespace-nowrap font-medium tabular", t.type === "INCOME" && "text-positive")}>
              {t.type === "INCOME" ? "+" : "−"}
              {formatMoney(t.amountCents, t.currency)}
            </span>
          </Link>
        </li>
      ))}
      {(q.data?.total ?? 0) > 500 && <li className="px-3 py-2 text-xs text-muted-foreground">Mostrando os 500 desconsiderados mais recentes do período.</li>}
    </ul>
  );
}

function PartyRow({ p, period }: { p: PassthroughParty; period: Period | null }) {
  const [open, setOpen] = useState(false);
  const name = p.party ?? NO_PARTY;
  const id = `pt-${(p.party ?? "none").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <li className="py-3">
      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_9rem] sm:items-center sm:gap-3">
        <div className="min-w-0">
          <p className={cn("truncate text-sm font-medium", !p.party && "italic text-muted-foreground")}>{name}</p>
          <p className="text-xs text-muted-foreground">
            {p.count} {p.count === 1 ? "lançamento" : "lançamentos"}
            {p.firstDate && ` · ${p.firstDate === p.lastDate ? formatDayMonthBR(p.firstDate) : `${formatDayMonthBR(p.firstDate)} a ${formatDayMonthBR(p.lastDate)}`}`}
          </p>
          {p.missingFx > 0 && <p className="text-[11px] text-warning">{p.missingFx} em moeda estrangeira ainda sem cotação (fora da soma)</p>}
        </div>
        <div className="grid grid-cols-3 gap-2 sm:contents">
          <Stat label="Recebido" value={p.receivedCents ? `+${formatBRL(p.receivedCents)}` : formatBRL(0)} className={p.receivedCents ? "text-positive" : "text-muted-foreground"} />
          <Stat label="Gasto" value={p.spentCents ? `−${formatBRL(p.spentCents)}` : formatBRL(0)} className={!p.spentCents ? "text-muted-foreground" : undefined} />
          <PassthroughBalance cents={p.balanceCents} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-self-end max-sm:-mx-2 max-sm:w-fit"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          aria-label={`${open ? "Ocultar" : "Ver"} lançamentos de ${name}`}
        >
          <ChevronDown className={cn("transition", open && "rotate-180")} aria-hidden /> {open ? "Ocultar" : "Ver lançamentos"}
        </Button>
      </div>
      {open && (
        <div id={id} className="mt-2">
          <PartyItems party={p.party} period={period} />
        </div>
      )}
    </li>
  );
}

/**
 * "Repasses de clientes": por cliente, quanto entrou (Pix do cliente), quanto saiu (gastos feitos
 * para ele) e o saldo. Some quando a família não tem nenhum repasse.
 */
export function PassthroughCard({
  period,
  allowAllTime = true,
  showListLink = true,
  description,
  className,
}: {
  /** Período da tela (null = desde o início). */
  period: Period | null;
  /** Mostra a escolha "Neste período / Desde o início". */
  allowAllTime?: boolean;
  /** Link para Lançamentos filtrado nos desconsiderados. */
  showListLink?: boolean;
  description?: React.ReactNode;
  className?: string;
}) {
  const [scope, setScope] = useState<"period" | "all">("period");
  const effective = scope === "all" || !period ? null : period;
  // Desde o início: decide se o cartão aparece (famílias sem repasse não veem nada).
  const all = usePassthrough(null);
  const q = usePassthrough(effective, Boolean(effective));
  const data = effective ? q.data : all.data;
  const loading = effective ? q.isLoading : all.isLoading;

  if (!all.data?.parties.length) return null;

  const totals = data?.totals;
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Handshake className="size-4 text-brand" aria-hidden /> Repasses de clientes
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            {description ?? "Valores desconsiderados como repasse de cliente: ficam fora das receitas e despesas, mas continuam no saldo e na fatura."}{" "}
            {effective ? `Período: ${describePeriod(effective)}.` : "Desde o início."}
          </CardDescription>
        </div>
        {allowAllTime && period && (
          <CardAction className="ml-0 shrink-0 sm:ml-auto">
            <div className="inline-flex whitespace-nowrap rounded-lg border p-0.5" role="group" aria-label="Período dos repasses">
              {(
                [
                  ["period", "Neste período"],
                  ["all", "Desde o início"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={scope === v}
                  onClick={() => setScope(v)}
                  className={cn(
                    "h-7 rounded-md px-2.5 text-xs font-medium transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    scope === v ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-24" />
        ) : !data?.parties.length ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">Nenhum repasse de cliente neste período.</p>
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_9rem] gap-3 border-b pb-2 text-xs font-medium text-muted-foreground sm:grid" aria-hidden>
              <span>Cliente</span>
              <span>Recebido</span>
              <span>Gasto</span>
              <span>Saldo</span>
              <span />
            </div>
            <ul className="divide-y" aria-label="Saldo por cliente">
              {data.parties.map((p) => (
                <PartyRow key={p.party ?? "__none__"} p={p} period={effective} />
              ))}
            </ul>
            {data.parties.length > 1 && totals && (
              <div className="flex flex-col gap-2 border-t pt-3 sm:grid sm:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_9rem] sm:items-center sm:gap-3">
                <p className="text-sm font-semibold">Total ({totals.count})</p>
                <div className="grid grid-cols-3 gap-2 sm:contents">
                  <Stat label="Recebido" value={`+${formatBRL(totals.receivedCents)}`} className="text-positive" />
                  <Stat label="Gasto" value={`−${formatBRL(totals.spentCents)}`} />
                  <PassthroughBalance cents={totals.balanceCents} />
                </div>
                <span className="hidden sm:block" aria-hidden />
              </div>
            )}
          </>
        )}
        <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p className="flex gap-1.5">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>Saldo = recebido − gasto. Negativo: a receber do cliente. Positivo: recebido a mais (ainda a gastar ou devolver).</span>
          </p>
          {showListLink && (
            <Link href={excludedListHref(effective)} className="inline-flex shrink-0 items-center gap-1 font-medium text-brand hover:underline">
              Ver desconsiderados em Lançamentos <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
