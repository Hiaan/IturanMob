"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { invalidateFinance } from "@/features/transactions/invalidate";

/** Rendimento automático das contas de investimento/poupança (CDI, Selic, IPCA+, prefixado). */

export type YieldIndex = "CDI" | "SELIC" | "IPCA" | "PREFIXED";
export type YieldStatus = "OK" | "BEHIND" | "WAITING_RATES";

export const YIELD_INDEXES: Array<{ value: YieldIndex; label: string; hint: string }> = [
  { value: "CDI", label: "CDI", hint: "CDB, LCI, LCA" },
  { value: "SELIC", label: "Selic", hint: "Tesouro Selic" },
  { value: "IPCA", label: "IPCA+", hint: "Tesouro IPCA+" },
  { value: "PREFIXED", label: "Prefixado", hint: "taxa fixa ao ano" },
];

/** Como a taxa aparece ao redor do campo: prefixo/sufixo e exemplo, conforme o indexador. */
export const YIELD_RATE_UNIT: Record<YieldIndex, { label: string; prefix?: string; suffix: string; example: string }> = {
  CDI: { label: "Percentual do CDI", suffix: "% do CDI", example: "Ex.: 101,5 para 101,5% do CDI" },
  SELIC: { label: "Percentual do Selic", suffix: "% do Selic", example: "Ex.: 100 para 100% do Selic" },
  IPCA: { label: "Taxa acima do IPCA", prefix: "IPCA +", suffix: "% a.a.", example: "Ex.: 6 para IPCA + 6% a.a." },
  PREFIXED: { label: "Taxa prefixada", suffix: "% a.a.", example: "Ex.: 12,5 para 12,5% a.a." },
};

/** CDI/Selic são "percentual do indexador"; IPCA+ e prefixado são taxa ao ano. */
export const isPercentOfIndex = (index: YieldIndex) => index === "CDI" || index === "SELIC";

export const supportsYield = (type: string) => type === "INVESTMENT" || type === "SAVINGS";

/** 10150 → "101,5" (sem separador de milhar, para edição). */
export function bpsToPercentText(bps: number | null | undefined): string {
  if (!bps) return "";
  return (bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2, useGrouping: false });
}

/** "101,5" / "101.50" → 10150. Até 2 casas decimais; null se inválido. */
export function percentTextToBps(text: string): number | null {
  const s = text.trim().replace(/\s|%/g, "").replace(",", ".");
  if (!/^\d{1,4}(\.\d{0,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return Number.isFinite(bps) ? bps : null;
}

/** Mesmo texto do servidor ("101,5% do CDI"), para o cartão da conta sem nova consulta. */
export function describeYield(index: YieldIndex, rateBps: number): string {
  const pct = (rateBps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (index === "CDI") return `${pct}% do CDI`;
  if (index === "SELIC") return `${pct}% do Selic`;
  if (index === "IPCA") return `IPCA + ${pct}% a.a.`;
  return `${pct}% a.a. (prefixado)`;
}

export interface YieldMonth {
  month: string;
  grossCents: number;
  businessDays: number;
  accruedThrough: string;
  transactionId: string | null;
  dismissed: boolean;
}

export type AccountYield =
  | { configured: false; accountId: string; months: []; ratesThrough: string | null }
  | {
      configured: true;
      accountId: string;
      index: YieldIndex;
      rateBps: number;
      startDate: string;
      label: string;
      status: YieldStatus;
      ratesThrough: string | null;
      accruedThrough: string | null;
      grossCents: number;
      estimate: { grossGainCents: number; irCents: number; iofCents: number; netGainCents: number; exempt: boolean; note: string };
      months: YieldMonth[];
    };

export interface YieldRefreshResult {
  accounts: number;
  created: number;
  updated: number;
  removed: number;
  waiting: number;
  rateErrors: string[];
  yield: AccountYield;
}

const yieldKey = (accountId: string) => qk.accounts({ yield: accountId });

export function useAccountYield(accountId: string, enabled = true) {
  return useQuery({ queryKey: yieldKey(accountId), queryFn: () => api.get<AccountYield>(`/api/v1/accounts/${accountId}/yield`), enabled });
}

export function useRefreshYield(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<YieldRefreshResult>(`/api/v1/accounts/${accountId}/yield`),
    onSuccess: (res) => {
      qc.setQueryData(yieldKey(accountId), res.yield);
      if (res.created || res.updated || res.removed) invalidateFinance(qc);
    },
  });
}
