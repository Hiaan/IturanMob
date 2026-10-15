"use client";

import { ArrowDownRight, ArrowUpRight, BadgeCheck, Minus, Telescope } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Certainty } from "./types";

/** Selo que diferencia dado confirmado (registrado) de projeção/estimativa — ícone + texto, nunca só cor. */
export function CertaintyBadge({ certainty, className }: { certainty: Certainty; className?: string }) {
  const confirmed = certainty === "CONFIRMED";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={confirmed ? "positive" : "info"} className={cn("cursor-help", className)}>
          {confirmed ? <BadgeCheck aria-hidden /> : <Telescope aria-hidden />}
          {confirmed ? "Confirmado" : "Projeção"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {confirmed
          ? "Calculado somente com lançamentos já registrados e confirmados."
          : "Estimativa a partir de contas previstas, recorrências, faturas em aberto ou ritmo de gastos. Pode mudar."}
      </TooltipContent>
    </Tooltip>
  );
}

/** Variação percentual com seta e texto (sem depender de cor). */
export function Delta({ pct, label = "vs. período anterior", goodWhenDown }: { pct: number | null; label?: string; goodWhenDown?: boolean }) {
  if (pct === null) return <span className="text-xs text-muted-foreground">sem base de comparação</span>;
  const up = pct > 0;
  const Icon = pct === 0 ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const good = pct === 0 ? null : goodWhenDown ? !up : up;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-0.5 text-xs font-medium", good === true ? "text-positive" : "text-muted-foreground")}>
      <Icon className="size-3.5" aria-hidden />
      <span className="tabular">
        {up ? "+" : pct < 0 ? "−" : ""}
        {Math.abs(pct).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
      </span>
      <span className="font-normal text-muted-foreground">{label}</span>
    </span>
  );
}

/** Cartão de seção do relatório com título, descrição e selo de certeza. */
export function ReportSection({
  title,
  description,
  certainty,
  action,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  certainty?: Certainty;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-w-0 flex-col", className)}>
      <CardHeader className="flex-row items-start gap-3">
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {title}
            {certainty && <CertaintyBadge certainty={certainty} />}
          </CardTitle>
          {description && <CardDescription className="mt-1 text-xs">{description}</CardDescription>}
        </div>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

/** Barras ranqueadas (largura proporcional ao maior valor) com rótulo, valor e percentual. */
export function RankedBars({
  items,
}: {
  items: Array<{ key: string; label: string; value: string; percent?: number | null; ratio: number; color: string; hint?: React.ReactNode }>;
}) {
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
              <span className="truncate">{i.label}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {i.percent !== undefined && i.percent !== null && <span className="text-xs text-muted-foreground tabular">{i.percent.toLocaleString("pt-BR")}%</span>}
              <span className="min-w-20 text-right font-medium tabular">{i.value}</span>
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, Math.min(100, i.ratio * 100))}%`, backgroundColor: i.color }} />
          </div>
          {i.hint && <p className="mt-1 text-[11px] text-muted-foreground">{i.hint}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Indicador do topo do relatório. */
export function StatTile({
  label,
  value,
  tone,
  certainty,
  children,
  emphasis,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "neutral";
  certainty?: Certainty;
  children?: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <Card
      className={cn(
        "min-w-0 p-4 sm:p-5",
        emphasis && "border-transparent bg-gradient-to-br from-[#0b2545] to-[#0e3a5c] text-white dark:from-[#0d2a4a] dark:to-[#0b3b37]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={cn("text-xs font-medium sm:text-[13px]", emphasis ? "text-white/75" : "text-muted-foreground")}>{label}</p>
        {certainty && !emphasis && <CertaintyBadge certainty={certainty} />}
      </div>
      <p
        className={cn(
          "mt-2 break-words text-xl font-semibold leading-tight tracking-tight tabular sm:text-2xl",
          !emphasis && tone === "negative" && "text-negative",
          !emphasis && tone === "positive" && "text-positive",
        )}
      >
        {value}
      </p>
      {children && <div className={cn("mt-2 text-xs", emphasis ? "text-white/70 [&_*]:text-white/75" : "text-muted-foreground")}>{children}</div>}
    </Card>
  );
}
