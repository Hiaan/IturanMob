"use client";

import { useState } from "react";
import { CalendarClock, CalendarDays, CalendarRange, History, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDateTimeBR, formatDayMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { ReportListItem } from "./types";

const PAGE = 12;

/** Histórico de relatórios gerados (abrir para visualizar). */
export function ReportHistory({
  items,
  isLoading,
  error,
  onRetry,
  selectedId,
  onSelect,
  timezone,
}: {
  items: ReportListItem[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  timezone?: string;
}) {
  const [limit, setLimit] = useState(PAGE);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" aria-hidden /> Histórico
        </CardTitle>
        <CardDescription className="text-xs">Relatórios gerados manualmente e pelos agendamentos.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pb-3 sm:px-3">
        {isLoading ? (
          <div className="space-y-2 px-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} compact />
        ) : !items?.length ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nenhum relatório gerado ainda.</p>
        ) : (
          <>
            <ul className="space-y-1">
              {items.slice(0, limit).map((r) => {
                const Icon = r.type === "WEEKLY" ? CalendarRange : CalendarDays;
                const active = r.id === selectedId;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(r.id)}
                      aria-current={active || undefined}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active && "bg-accent hover:bg-accent",
                      )}
                    >
                      <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", active ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground")}>
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{r.type === "WEEKLY" ? `${formatDayMonthBR(r.periodStart)} a ${formatDateBR(r.periodEnd)}` : r.periodLabel}</span>
                          <span className={cn("shrink-0 text-xs font-medium tabular", r.totals.resultCents < 0 ? "text-negative" : "text-positive")}>{formatBRL(r.totals.resultCents, { signed: true })}</span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                          <span>{r.type === "WEEKLY" ? "Semanal" : "Mensal"}</span>·<span>{r.regime === "CASH" ? "Caixa" : "Competência"}</span>
                          {r.scope === "PERSONAL" && (
                            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                              <UserRound aria-hidden /> Pessoal
                            </Badge>
                          )}
                          {r.scheduled && (
                            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
                              <CalendarClock aria-hidden /> Programado
                            </Badge>
                          )}
                          {r.isPartial && <Badge variant="warning" className="px-1.5 py-0 text-[10px]">Parcial</Badge>}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">Gerado em {formatDateTimeBR(r.createdAt, timezone)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {items.length > limit && (
              <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setLimit((l) => l + PAGE)}>
                Mostrar mais ({items.length - limit})
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
