"use client";

import { useState } from "react";
import { BarChart3, Table2 } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/shared/error-state";

/**
 * Cartão de gráfico com alternância para tabela (equivalente acessível).
 * Em recarregamentos mantém o conteúdo anterior com opacidade reduzida (sem "piscar").
 */
export function ChartCard({
  title,
  description,
  action,
  isLoading,
  isFetching,
  error,
  onRetry,
  empty,
  table,
  children,
  className,
  height = 260,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: React.ReactNode | false;
  table?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  height?: number;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex-row items-start gap-3">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}
        </div>
        <CardAction>
          {action}
          {table && !isLoading && !error && !empty && (
            <button
              type="button"
              onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
              className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={view === "chart" ? "Ver como tabela" : "Ver como gráfico"}
              title={view === "chart" ? "Ver como tabela" : "Ver como gráfico"}
            >
              {view === "chart" ? <Table2 className="size-4" /> : <BarChart3 className="size-4" />}
            </button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex-1">
        {isLoading ? (
          <Skeleton className="w-full rounded-lg" style={{ height }} />
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} compact />
        ) : empty ? (
          <div className="flex items-center justify-center text-center text-sm text-muted-foreground" style={{ minHeight: height * 0.6 }}>
            {empty}
          </div>
        ) : (
          <div className={cn("transition-opacity", isFetching && "opacity-60")}>{view === "table" && table ? table : children}</div>
        )}
      </CardContent>
    </Card>
  );
}
