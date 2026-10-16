"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isISODate, resolvePeriod, type PeriodPreset } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
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
  /** Natureza Pessoal ou Empresa (os repasses ficam de fora: são a natureza Repasse). */
  scope?: "PERSONAL" | "BUSINESS";
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
    f.scope,
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
  // Natureza (?scope=PERSONAL|BUSINESS) e "pedem natureza" (?natureReview=1).
  const scope = sp.get("scope");
  if ((scope === "PERSONAL" || scope === "BUSINESS") && patch.excluded !== "only") patch.scope = scope;
  if (sp.get("natureReview") === "1" || sp.get("natureReview") === "true") patch.natureReview = true;
  const start = sp.get("start");
  const end = sp.get("end");
  if (isISODate(start) && isISODate(end) && start <= end) Object.assign(patch, { preset: "custom", start, end });
  else if (sp.get("period") === "all") Object.assign(patch, { preset: "all", start: undefined, end: undefined });
  return patch;
}

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
      if (raw) stored = { ...TX_DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<TxFilters>) };
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

/** Monta os parâmetros da API de listagem a partir dos filtros + interpretação da busca. */
export function buildListParams(f: TxFilters, today: string, smart: { search: string; patch: SmartPatch }, page: number, pageSize: number) {
  const period = effectivePeriod(f, today);
  const p = smart.patch;
  const params: Record<string, unknown> = {
    start: p.start ?? period?.start,
    end: p.end ?? period?.end,
    // Só receitas e despesas têm natureza: com Pessoal/Empresa, transferências e pagamentos de fatura saem.
    types: f.scope ? natureTypes(p.types ?? f.types) : (p.types ?? f.types),
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
    // Natureza Pessoal/Empresa não inclui os repasses (desconsiderados): eles são a natureza Repasse.
    excluded: f.scope ? "hide" : f.excluded,
    scope: f.scope,
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
