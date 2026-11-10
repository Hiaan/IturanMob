"use client";

import { useCallback, useEffect, useState } from "react";
import type { PeriodPreset } from "@/lib/dates";
import type { ReportScope } from "@/features/finance/types";

export interface DashboardFilters {
  preset: PeriodPreset;
  start?: string;
  end?: string;
  regime?: "ACCRUAL" | "CASH";
  memberId?: string;
  accountId?: string;
  creditCardId?: string;
  categoryIds?: string[];
  /** Recorte Pessoal | Empresa | Tudo. Ausente = padrão da família (definido em Configurações). */
  scope?: ReportScope;
}

const DEFAULTS: DashboardFilters = { preset: "thisMonth" };

/** Filtros persistentes por página (localStorage), com fallback seguro. */
export function usePersistentFilters(key: string, defaults: DashboardFilters = DEFAULTS) {
  const [filters, setFilters] = useState<DashboardFilters>(defaults);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`fa:filters:${key}`);
      if (raw) setFilters({ ...defaults, ...(JSON.parse(raw) as DashboardFilters) });
    } catch {
      // armazenamento indisponível
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = useCallback(
    (patch: Partial<DashboardFilters>) => {
      setFilters((prev) => {
        const next = { ...prev, ...patch };
        try {
          localStorage.setItem(`fa:filters:${key}`, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    [key],
  );

  const reset = useCallback(() => {
    setFilters(defaults);
    try {
      localStorage.removeItem(`fa:filters:${key}`);
    } catch {
      // ignore
    }
  }, [key, defaults]);

  return { filters, update, reset, loaded };
}

export function filtersToParams(f: DashboardFilters): Record<string, unknown> {
  return {
    preset: f.preset,
    ...(f.preset === "custom" ? { start: f.start, end: f.end } : {}),
    regime: f.regime,
    memberId: f.memberId,
    accountId: f.accountId,
    creditCardId: f.creditCardId,
    categoryIds: f.categoryIds,
    scope: f.scope,
  };
}

/**
 * Link para Transações com o mesmo período e filtros do painel ("Este mês" abre em "Este mês").
 * `extra` acrescenta o que o clique escolheu (tipo, categoria…).
 */
export function transactionsHref(f: DashboardFilters, period: { start: string; end: string } | null | undefined, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams();
  // Período com nome ("Este mês") vai pelo nome, para Transações mostrar o mesmo; personalizado, pelas datas.
  if (f.preset !== "custom") qs.set("preset", f.preset);
  else if (period) {
    qs.set("start", period.start);
    qs.set("end", period.end);
  }
  if (f.memberId) qs.set("memberId", f.memberId);
  if (f.accountId) qs.set("accountId", f.accountId);
  if (f.creditCardId) qs.set("creditCardId", f.creditCardId);
  if (f.categoryIds?.[0]) qs.set("categoryId", f.categoryIds[0]);
  for (const [k, v] of Object.entries(extra)) qs.set(k, v);
  return `/transacoes?${qs.toString()}`;
}
