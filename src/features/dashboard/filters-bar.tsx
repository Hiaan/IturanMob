"use client";

import { Info, RotateCcw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PERIOD_PRESET_LABELS, type PeriodPreset } from "@/lib/dates";
import { REGIME_DESCRIPTIONS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAccounts, useCards, useCategories, useMembers } from "@/features/finance/hooks";
import type { DashboardFilters } from "./use-filters";

const ALL = "__all__";
const PRESETS: PeriodPreset[] = ["today", "yesterday", "last7", "thisMonth", "lastMonth", "last3Months", "thisYear", "last12Months", "custom"];

export function FiltersBar({
  filters,
  onChange,
  onReset,
  showRegime = true,
  className,
}: {
  filters: DashboardFilters;
  onChange: (patch: Partial<DashboardFilters>) => void;
  onReset?: () => void;
  showRegime?: boolean;
  className?: string;
}) {
  const members = useMembers();
  const accounts = useAccounts();
  const cards = useCards();
  const categories = useCategories();
  // O recorte Pessoa física | Empresa | Tudo fica na barra do topo da página (não é limpo aqui).
  const hasExtra = Boolean(filters.memberId || filters.accountId || filters.creditCardId || filters.categoryIds?.length || filters.preset !== "thisMonth");

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} role="group" aria-label="Filtros">
      <Select value={filters.preset} onValueChange={(v) => onChange({ preset: v as PeriodPreset })}>
        <SelectTrigger className="h-9 w-auto min-w-[130px] max-w-[220px]" aria-label="Período">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESETS.map((p) => (
            <SelectItem key={p} value={p}>
              {PERIOD_PRESET_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filters.preset === "custom" && (
        <div className="flex items-center gap-1">
          <Input type="date" className="h-9 w-[150px]" value={filters.start ?? ""} onChange={(e) => onChange({ start: e.target.value })} aria-label="Data inicial" />
          <span className="text-xs text-muted-foreground">a</span>
          <Input type="date" className="h-9 w-[150px]" value={filters.end ?? ""} onChange={(e) => onChange({ end: e.target.value })} aria-label="Data final" />
        </div>
      )}
      {showRegime && (
        <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
          {(["ACCRUAL", "CASH"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onChange({ regime: r })}
              aria-pressed={(filters.regime ?? "ACCRUAL") === r}
              className={cn(
                "h-8 rounded-md px-3 text-xs font-medium transition",
                (filters.regime ?? "ACCRUAL") === r ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r === "ACCRUAL" ? "Competência" : "Caixa"}
            </button>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="px-1.5 text-muted-foreground" aria-label="Sobre os regimes">
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm">
              <p className="mb-1">{REGIME_DESCRIPTIONS.ACCRUAL}</p>
              <p>{REGIME_DESCRIPTIONS.CASH}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      <Select value={filters.memberId ?? ALL} onValueChange={(v) => onChange({ memberId: v === ALL ? undefined : v })}>
        <SelectTrigger className="h-9 w-auto min-w-[130px] max-w-[220px]" aria-label="Responsável">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todas as pessoas</SelectItem>
          {(members.data ?? []).map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.accountId ?? ALL} onValueChange={(v) => onChange({ accountId: v === ALL ? undefined : v })}>
        <SelectTrigger className="h-9 w-auto min-w-[130px] max-w-[220px]" aria-label="Conta">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todas as contas</SelectItem>
          {(accounts.data ?? []).map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.creditCardId ?? ALL} onValueChange={(v) => onChange({ creditCardId: v === ALL ? undefined : v })}>
        <SelectTrigger className="h-9 w-auto min-w-[130px] max-w-[220px]" aria-label="Cartão">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todos os cartões</SelectItem>
          {(cards.data ?? []).map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.categoryIds?.[0] ?? ALL} onValueChange={(v) => onChange({ categoryIds: v === ALL ? undefined : [v] })}>
        <SelectTrigger className="h-9 w-auto min-w-[130px] max-w-[220px]" aria-label="Categoria">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Todas as categorias</SelectItem>
          {(categories.data ?? [])
            .filter((c) => !c.archivedAt)
            .map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} {c.kind === "INCOME" ? "(receita)" : ""}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {hasExtra && onReset && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <RotateCcw /> Limpar
        </Button>
      )}
    </div>
  );
}
