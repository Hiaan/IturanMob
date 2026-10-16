"use client";

import { Briefcase, EyeOff, User, X } from "lucide-react";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { TransactionNature } from "@/features/finance/types";
import { NATURE_LABELS } from "@/features/transactions/nature";
import type { CategorySlice } from "./types";

/** Chave estável de uma categoria da fatura ("none" = sem categoria). */
export const sliceKey = (c: Pick<CategorySlice, "categoryId">) => c.categoryId ?? "none";

const pct = (n: number) => `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

/** Barra segmentada por categoria (proporção do total), com 2px de respiro entre os segmentos. */
export function CategoryBar({ items, selected, className }: { items: CategorySlice[]; selected?: string | null; className?: string }) {
  const total = items.reduce((s, i) => s + i.amountCents, 0);
  if (!total) return null;
  return (
    <div className={cn("flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted", className)} aria-hidden>
      {items
        .filter((i) => i.amountCents > 0)
        .map((i) => (
          <span
            key={sliceKey(i)}
            className={cn("h-full min-w-0.5 transition-opacity", selected && selected !== sliceKey(i) && "opacity-30")}
            style={{ width: `${(i.amountCents / total) * 100}%`, backgroundColor: i.color }}
          />
        ))}
    </div>
  );
}

/**
 * Resumo da fatura por categoria: barra segmentada + lista com valor e %.
 * Com `onSelect`, cada categoria vira um filtro (botão com aria-pressed) e aparece o chip "Limpar".
 */
export function CategorySummary({
  items,
  selected = null,
  onSelect,
  twoColumns = false,
}: {
  items: CategorySlice[];
  selected?: string | null;
  onSelect?: (key: string | null) => void;
  /** Lista em duas colunas a partir de sm (para áreas largas). */
  twoColumns?: boolean;
}) {
  const active = items.find((i) => sliceKey(i) === selected) ?? null;
  return (
    <div className="space-y-3">
      <CategoryBar items={items} selected={selected} />
      <ul className={cn("grid gap-0.5", twoColumns && "sm:grid-cols-2")} aria-label="Categorias da fatura">
        {items.map((i) => {
          const key = sliceKey(i);
          const pressed = selected === key;
          const content = (
            <>
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
                <span className={cn("truncate", !i.categoryId && "text-muted-foreground")}>{i.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular">({i.count})</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="text-xs text-muted-foreground tabular">{pct(i.percent)}</span>
                <span className="font-medium tabular">{formatBRL(i.amountCents)}</span>
              </span>
            </>
          );
          return (
            <li key={key}>
              {onSelect ? (
                <button
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => onSelect(pressed ? null : key)}
                  title={pressed ? "Mostrar todas as categorias" : `Mostrar só ${i.name}`}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    pressed ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                    selected && !pressed && "opacity-60",
                  )}
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {onSelect && active && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Filtrando por</span>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-2.5 font-medium outline-none transition hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/40"
            aria-label={`Limpar filtro: ${active.name}`}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: active.color }} aria-hidden />
            {active.name}
            <X className="size-3" aria-hidden />
            <span aria-hidden>limpar</span>
          </button>
        </div>
      )}
    </div>
  );
}

const NATURE_ICON = { PERSONAL: User, BUSINESS: Briefcase, PASSTHROUGH: EyeOff } as const;

/** Quanto da fatura é Pessoal, Empresa ou Repasse (só aparece quando há Empresa ou Repasse). */
export function NatureBreakdown({ byNature, label, className }: { byNature: Record<TransactionNature, number> | undefined; label?: string; className?: string }) {
  if (!byNature || (!byNature.BUSINESS && !byNature.PASSTHROUGH)) return null;
  return (
    <div className={cn("rounded-xl border bg-muted/30 px-3 py-2.5", className)}>
      {label && <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>}
      <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {(["PERSONAL", "BUSINESS", "PASSTHROUGH"] as const)
          .filter((n) => byNature[n] > 0)
          .map((n) => {
            const Icon = NATURE_ICON[n];
            return (
              <div key={n} className="flex items-center gap-1.5">
                <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Icon className={cn("size-3.5", n === "BUSINESS" && "text-series-7")} aria-hidden />
                  {NATURE_LABELS[n]}
                </dt>
                <dd className="font-medium tabular">{formatBRL(byNature[n])}</dd>
              </div>
            );
          })}
      </dl>
      <p className="mt-1 text-xs text-muted-foreground">A fatura cobra tudo; a natureza só muda relatórios (Repasse fica fora deles).</p>
    </div>
  );
}
