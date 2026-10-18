"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isISODate, resolvePeriod, type PeriodPreset } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
import type { ReportScope, TransactionScope } from "@/features/finance/types";
import type { SmartPatch } from "./smart-search";

/** Formas de pagamento aceitas em ?paymentMethod= (ex.: CREDIT_CARD vindo do painel). */
const PAYMENT_METHOD_KEYS: string[] = Object.keys(PAYMENT_METHOD_LABELS);

export type TxPreset = PeriodPreset | "all";
export type TxSort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc" | "created_desc";

/** Filtros da tela de transações (persistidos por navegador). */
export interface TxFilters {
  preset: TxPreset;
  start?: string;
  end?: string;
  types?: string[];
  status?: "CONFIRMED" | "PENDING";
  categoryIds?: string[];
  subcategoryId?: string;
  uncategorized?: boolean;
  accountId?: string;
  creditCardId?: string;
  memberId?: string;
  personMode?: "any" | "payer" | "responsible";
  ownership?: "SHARED" | "INDIVIDUAL";
  paymentMethods?: string[];
  sources?: string[];
  minAmountCents?: number;
  maxAmountCents?: number;
  /** Desconsiderados nos relatórios: ocultar ou só eles (ausente = mostrar junto, o padrão). */
  excluded?: "hide" | "only";
  /** Só os que uma regra pediu para escolher a natureza. */
  natureReview?: boolean;
  sort: TxSort;
}

export const TX_DEFAULT_FILTERS: TxFilters = { preset: "thisMonth", sort: "date_desc" };

export const SORT_LABELS: Record<TxSort, string> = {
  date_desc: "Mais recentes",
  date_asc: "Mais antigas",
  amount_desc: "Maior valor",
  amount_asc: "Menor valor",
  created_desc: "Registradas por último",
};

const STORAGE_KEY = "fa:filters:transactions";

/** Quantidade de filtros avançados ativos (exceto período, ordenação e busca). */
export function countAdvanced(f: TxFilters): number {
  return [
    f.types?.length,
    f.status,
    f.categoryIds?.length || f.subcategoryId,
    f.uncategorized,
    f.accountId,
    f.creditCardId,
    f.memberId,
    f.ownership,
    f.paymentMethods?.length,
    f.sources?.length,
    f.minAmountCents != null || f.maxAmountCents != null,
    f.excluded,
    f.natureReview,
  ].filter(Boolean).length;
}

export const URL_FILTER_KEYS = ["categoryId", "subcategoryId", "type", "accountId", "creditCardId", "memberId", "status", "uncategorized", "excluded", "scope", "natureReview", "paymentMethod", "start", "end", "period"] as const;

/** Converte parâmetros da URL (links do dashboard, busca global, contas, cartões) em filtros. */
export function filtersFromUrl(sp: URLSearchParams): Partial<TxFilters> | null {
  if (!URL_FILTER_KEYS.some((k) => sp.has(k))) return null;
  const patch: Partial<TxFilters> = {};
  const categoryId = sp.get("categoryId");
  if (categoryId) patch.categoryIds = [categoryId];
  const sub = sp.get("subcategoryId");
  if (sub) patch.subcategoryId = sub;
  const type = sp.get("type");
  if (type && ["EXPENSE", "INCOME", "TRANSFER", "CARD_PAYMENT", "ADJUSTMENT"].includes(type)) patch.types = [type];
  const accountId = sp.get("accountId");
  if (accountId) patch.accountId = accountId;
  const creditCardId = sp.get("creditCardId");
  if (creditCardId) patch.creditCardId = creditCardId;
  const memberId = sp.get("memberId");
  if (memberId) patch.memberId = memberId;
  const paymentMethod = sp.get("paymentMethod");
  if (paymentMethod && PAYMENT_METHOD_KEYS.includes(paymentMethod)) patch.paymentMethods = [paymentMethod];
  const status = sp.get("status");
  if (status === "PENDING" || status === "CONFIRMED") patch.status = status;
  if (sp.get("uncategorized") === "1" || sp.get("uncategorized") === "true") patch.uncategorized = true;
  // Desconsiderados nos relatórios (?excluded=hide|only) e período (?start=&end= ou ?period=all).
  const excluded = sp.get("excluded");
  if (excluded === "hide" || excluded === "only") patch.excluded = excluded;
  // O recorte (?scope=) não é filtro da lista: vai para a barra do topo (veja scopeFromUrl).
  // "Pedem natureza" (?natureReview=1).
  if (sp.get("natureReview") === "1" || sp.get("natureReview") === "true") patch.natureReview = true;
  const start = sp.get("start");
  const end = sp.get("end");
  if (isISODate(start) && isISODate(end) && start <= end) Object.assign(patch, { preset: "custom", start, end });
  else if (sp.get("period") === "all") Object.assign(patch, { preset: "all", start: undefined, end: undefined });
  return patch;
}

/** Recorte vindo de um link (?scope=PERSONAL|BUSINESS|ALL); com ?excluded=only o recorte não se aplica. */
export function scopeFromUrl(sp: URLSearchParams): ReportScope | null {
  const scope = sp.get("scope");
  if (sp.get("excluded") === "only") return null;
  return scope === "PERSONAL" || scope === "BUSINESS" || scope === "ALL" ? scope : null;
}

/**
 * Natureza aplicada na lista a partir do recorte da barra: Pessoa física/Empresa filtram; Tudo não.
 * "Só desconsiderados" e "pedem natureza" ignoram o recorte (repasses ficam fora de qualquer recorte;
 * quem pede natureza ainda não tem uma).
 */
export function listNatureScope(f: Pick<TxFilters, "excluded" | "natureReview">, scope: ReportScope | null): TransactionScope | null {
  if (f.excluded === "only" || f.natureReview) return null;
  return scope === "PERSONAL" || scope === "BUSINESS" ? scope : null;
}

/** Tipos sem natureza (só aparecem no recorte Tudo). */
export const NON_NATURE_TYPES = ["TRANSFER", "CARD_PAYMENT", "ADJUSTMENT"];

export function usePersistentTxFilters() {
  const [filters, setFilters] = useState<TxFilters>(TX_DEFAULT_FILTERS);
  const [loaded, setLoaded] = useState(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const save = (next: TxFilters) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // armazenamento indisponível
    }
  };

  /** Carrega os filtros salvos; se a URL trouxer filtros, eles substituem os salvos (mantendo o período). */
  const init = useCallback((urlPatch: Partial<TxFilters> | null) => {
    let stored: TxFilters = TX_DEFAULT_FILTERS;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        // "scope" de versões anteriores: o recorte agora fica na barra do topo.
        const parsed = JSON.parse(raw) as Partial<TxFilters> & { scope?: unknown };
        delete parsed.scope;
        stored = { ...TX_DEFAULT_FILTERS, ...parsed };
      }
    } catch {
      // ignore
    }
    const next = urlPatch ? { ...TX_DEFAULT_FILTERS, preset: stored.preset, start: stored.start, end: stored.end, sort: stored.sort, ...urlPatch } : stored;
    setFilters(next);
    if (urlPatch) save(next);
    setLoaded(true);
  }, []);

  const update = useCallback((patch: Partial<TxFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      for (const k of Object.keys(next) as Array<keyof TxFilters>) {
        const v = next[k];
        if (v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
      }
      save(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setFilters(TX_DEFAULT_FILTERS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return { filters, update, reset, loaded, init };
}

/** Período efetivo (null = todo o período). */
export function effectivePeriod(f: TxFilters, today: string): { start: string; end: string } | null {
  if (f.preset === "all") return null;
  return resolvePeriod(f.preset, today, { start: f.start, end: f.end });
}

function natureTypes(types: string[] | undefined): string[] {
  const kept = (types ?? []).filter((t) => t === "EXPENSE" || t === "INCOME");
  return kept.length ? kept : ["EXPENSE", "INCOME"];
}

/**
 * Monta os parâmetros da API de listagem a partir dos filtros + interpretação da busca.
 * `natureScope` = natureza do recorte da barra (veja listNatureScope); null = sem filtro de natureza.
 */
export function buildListParams(f: TxFilters, today: string, smart: { search: string; patch: SmartPatch }, page: number, pageSize: number, natureScope: TransactionScope | null = null) {
  const period = effectivePeriod(f, today);
  const p = smart.patch;
  const params: Record<string, unknown> = {
    start: p.start ?? period?.start,
    end: p.end ?? period?.end,
    // Só receitas e despesas têm natureza: com Pessoa física/Empresa, transferências e pagamentos de fatura saem.
    types: natureScope ? natureTypes(p.types ?? f.types) : (p.types ?? f.types),
    status: p.status ?? f.status,
    categoryIds: p.subcategoryId ? undefined : p.categoryIds ?? f.categoryIds,
    subcategoryId: p.subcategoryId ?? f.subcategoryId,
    uncategorized: p.uncategorized ?? f.uncategorized,
    accountId: f.accountId,
    creditCardId: f.creditCardId,
    memberId: p.memberId ?? f.memberId,
    personMode: (p.memberId ?? f.memberId) ? f.personMode ?? "any" : undefined,
    ownership: f.ownership,
    paymentMethods: p.paymentMethods ?? f.paymentMethods,
    sources: p.sources ?? f.sources,
    minAmountCents: p.minAmountCents ?? f.minAmountCents,
    maxAmountCents: p.maxAmountCents ?? f.maxAmountCents,
    // Pessoa física/Empresa não incluem os repasses (desconsiderados): eles são a natureza Repasse.
    excluded: natureScope ? "hide" : f.excluded,
    scope: natureScope ?? undefined,
    natureReview: f.natureReview || undefined,
    search: smart.search || undefined,
    sort: f.sort,
    page,
    pageSize,
  };
  if (!params.uncategorized) delete params.uncategorized;
  return params;
}

export function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
