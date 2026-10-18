"use client";

import { Briefcase, ChevronDown, EyeOff, HelpCircle, Loader2, User, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ReportScope, TransactionDTO, TransactionNature } from "@/features/finance/types";
import { NATURES, NATURE_HINTS, NATURE_LABELS, REPORT_SCOPES, REPORT_SCOPE_HINTS, REPORT_SCOPE_LABELS, natureOf } from "./nature";

export const NATURE_ICONS: Record<TransactionNature, LucideIcon> = { PERSONAL: User, BUSINESS: Briefcase, PASSTHROUGH: EyeOff };

/** Selo "Empresa" (violeta; o "Desconsiderado"/Repasse é tracejado e cinza). */
export function BusinessBadge({ className, title }: { className?: string; title?: string }) {
  return (
    <Badge className={cn("border-transparent bg-series-7/12 text-series-7", className)} title={title ?? "Natureza Empresa: entra no recorte Empresa dos relatórios. Saldo e fatura não mudam."}>
      <Briefcase aria-hidden /> Empresa
    </Badge>
  );
}

/** Selo de natureza para a lista: só Empresa (Pessoal é o padrão; Repasse usa o selo "Desconsiderado"). */
export function NatureBadge({ tx }: { tx: Pick<TransactionDTO, "type" | "excludedFromReports"> & Partial<Pick<TransactionDTO, "nature" | "scope">> }) {
  if (tx.type !== "EXPENSE" && tx.type !== "INCOME") return null;
  return natureOf(tx) === "BUSINESS" ? <BusinessBadge /> : null;
}

/** "Escolher natureza": uma regra pediu para confirmar se é Pessoal, Empresa ou Repasse. */
export function NatureReviewBadge({ className }: { className?: string }) {
  return (
    <Badge variant="warning" className={className} title="Uma regra pediu para escolher: Pessoal, Empresa ou Repasse de cliente. Saldo e fatura não mudam.">
      <HelpCircle aria-hidden /> Escolher natureza
    </Badge>
  );
}

/**
 * Pessoal | Empresa | Repasse como botões de rádio (estado não depende só de cor: ✓ + aria-checked).
 * `value` null = nenhum escolhido (natureza pedida por regra).
 */
export function NatureSegmented({
  value,
  onChange,
  disabled,
  pending,
  label = "Natureza",
  size = "md",
  className,
}: {
  value: TransactionNature | null;
  onChange: (n: TransactionNature) => void;
  disabled?: boolean;
  /** Natureza sendo salva (mostra o carregando no botão). */
  pending?: TransactionNature | null;
  label?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid grid-cols-3 gap-1 rounded-xl bg-muted p-1", className)}>
      {NATURES.map((n) => {
        const Icon = NATURE_ICONS[n];
        const checked = value === n;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            title={NATURE_HINTS[n]}
            onClick={() => onChange(n)}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1.5 rounded-lg font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
              size === "sm" ? "h-8 px-2 text-xs" : "h-9 px-2.5 text-sm",
              checked ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {pending === n ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : <Icon className={cn("size-3.5 shrink-0", checked && n === "BUSINESS" && "text-series-7")} aria-hidden />}
            <span className="truncate">
              {NATURE_LABELS[n]}
              {n === "PASSTHROUGH" && !checked ? "…" : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Menu rápido "Escolher natureza ▾" (lista e pendências). */
export function NatureQuickMenu({
  onPick,
  disabled,
  className,
  label = "Escolher natureza",
  align = "start",
}: {
  onPick: (n: TransactionNature) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-warning/40 bg-warning/12 px-2 text-xs font-medium whitespace-nowrap text-warning outline-none transition hover:bg-warning/20 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-60",
            className,
          )}
          aria-label={`${label}: Pessoal, Empresa ou Repasse`}
        >
          <HelpCircle className="size-3" aria-hidden /> {label}
          <ChevronDown className="size-3 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Saldo e fatura não mudam</DropdownMenuLabel>
        {NATURES.map((n) => {
          const Icon = NATURE_ICONS[n];
          return (
            <DropdownMenuItem key={n} onSelect={() => onPick(n)}>
              <Icon /> {n === "PASSTHROUGH" ? "Repasse…" : NATURE_LABELS[n]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Recorte Pessoa física | Empresa | Tudo (painel de filtros). Mostra qual é o padrão da família. */
export function ReportScopeSwitch({
  value,
  defaultScope,
  onChange,
  className,
  size = "md",
}: {
  value: ReportScope;
  /** Padrão da família (marcado como "padrão" no título do botão). */
  defaultScope?: ReportScope | null;
  onChange: (s: ReportScope) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("flex items-center gap-1 rounded-lg bg-muted p-0.5", className)} role="radiogroup" aria-label="Recorte dos relatórios">
      {REPORT_SCOPES.map((s) => {
        const checked = value === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(s)}
            title={`${REPORT_SCOPE_HINTS[s]}${defaultScope === s ? " (padrão da família)" : ""}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
              size === "sm" ? "h-7 text-xs" : "h-8 text-xs",
              checked ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "BUSINESS" && <Briefcase className={cn("size-3.5", checked && "text-series-7")} aria-hidden />}
            {REPORT_SCOPE_LABELS[s]}
            {defaultScope === s && <span className="sr-only"> (padrão da família)</span>}
          </button>
        );
      })}
    </div>
  );
}
