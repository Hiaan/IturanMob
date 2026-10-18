"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { ExclusionReason, ReportScope, TransactionDTO, TransactionNature } from "@/features/finance/types";
import { invalidateFinance } from "./invalidate";
import { skippedSummary, type ReportExclusionResult } from "./report-exclusion";

/**
 * Natureza do lançamento: Pessoal (padrão), Empresa ou Repasse (= desconsiderado nos relatórios).
 * Regra de ouro: a natureza NUNCA muda saldo da conta, fatura do cartão, projeção de caixa ou contas a
 * pagar — só os relatórios e as análises.
 */

export const NATURES: TransactionNature[] = ["PERSONAL", "BUSINESS", "PASSTHROUGH"];

export const NATURE_LABELS: Record<TransactionNature, string> = {
  PERSONAL: "Pessoal",
  BUSINESS: "Empresa",
  PASSTHROUGH: "Repasse",
};

/** O que cada natureza faz nos relatórios (uma linha). */
export const NATURE_HINTS: Record<TransactionNature, string> = {
  PERSONAL: "Gasto ou receita da família: entra no recorte Pessoa física.",
  BUSINESS: "Da empresa (equipe, anúncios próprios, receita de clientes): entra no recorte Empresa e no resultado da empresa.",
  PASSTHROUGH: "Repasse de cliente ou reembolso: fica fora de todos os relatórios.",
};

/** Frase-padrão (regra de ouro). */
export const NATURE_KEEPS_BALANCE = "A natureza só muda relatórios e análises: saldo da conta, fatura do cartão, projeção de caixa e contas a pagar não mudam.";

export const REPORT_SCOPES: ReportScope[] = ["PERSONAL", "BUSINESS", "ALL"];

/** Rótulos do recorte (a barra "Pessoa física | Empresa | Tudo" no topo das páginas). */
export const REPORT_SCOPE_LABELS: Record<ReportScope, string> = { PERSONAL: "Pessoa física", BUSINESS: "Empresa", ALL: "Tudo" };

export const REPORT_SCOPE_HINTS: Record<ReportScope, string> = {
  PERSONAL: "Só o que é de pessoa física (sem a empresa).",
  BUSINESS: "Só o que é da empresa: equipe, anúncios próprios e receitas de clientes.",
  ALL: "Pessoa física e Empresa juntas.",
};

/** Repasses (desconsiderados) nunca entram, em nenhum recorte. */
export const REPORT_SCOPE_PASSTHROUGH_NOTE = "Repasses de clientes e reembolsos ficam sempre de fora.";

/** Só receitas e despesas têm natureza. */
export function hasNature(t: Pick<TransactionDTO, "type" | "deletedAt">): boolean {
  return (t.type === "EXPENSE" || t.type === "INCOME") && !t.deletedAt;
}

/** Natureza mesmo em respostas antigas sem o campo (cache/otimista). */
export function natureOf(t: Pick<TransactionDTO, "excludedFromReports"> & Partial<Pick<TransactionDTO, "nature" | "scope">>): TransactionNature {
  if (t.nature) return t.nature;
  if (t.excludedFromReports) return "PASSTHROUGH";
  return t.scope === "BUSINESS" ? "BUSINESS" : "PERSONAL";
}

export interface SetNatureBody {
  transactionIds: string[];
  nature: TransactionNature;
  reason?: ExclusionReason | null;
  party?: string | null;
  note?: string | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Define a natureza de um ou vários lançamentos (POST /transactions/nature), com toasts e invalidação. */
export function useSetNature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetNatureBody) => api.post<ReportExclusionResult>("/api/v1/transactions/nature", body),
    onSuccess: (res, body) => {
      for (const item of res.items) qc.setQueryData<TransactionDTO>(qk.transaction(item.id), (old) => (old ? { ...old, ...item } : old));
      const n = res.updated;
      const label = NATURE_LABELS[body.nature];
      const skippedText = res.skipped.length ? skippedSummary(res.skipped) : undefined;
      if (n > 0) {
        toast.success(n === 1 ? `Natureza: ${label}` : `${plural(n, "lançamento marcado", "lançamentos marcados")} como ${label}`, {
          description: `Saldo e fatura não mudam.${skippedText ? ` Não alterados: ${skippedText}` : ""}`,
        });
      } else if (res.skipped.length) {
        toast.info("Nada foi alterado", { description: skippedText });
      }
      invalidateFinance(qc, ["categories", "reports"]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
