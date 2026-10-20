"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { ReportScope } from "@/features/finance/types";
import type { FixedExpensesOverview, SubscriptionCandidateDTO } from "./types";

/**
 * Gastos fixos (recorrências, parcelas e projeção). Fica sob o prefixo "analytics": é invalidado
 * junto com lançamentos, cartões, contas a pagar, categorias e recorrências.
 * `scope` ausente = recorte padrão da família (o servidor devolve qual aplicou).
 */
export function useFixedExpenses(scope: ReportScope | undefined, months = 12, enabled = true) {
  const params = { scope, months };
  return useQuery({
    queryKey: qk.analytics("fixed-expenses", params),
    queryFn: () => api.get<FixedExpensesOverview>("/api/v1/fixed-expenses", params),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Cobranças mensais encontradas (OPEN = sugestões; IGNORED = as que a pessoa pediu para não sugerir). */
export function useSubscriptionCandidates(status: "OPEN" | "IGNORED", enabled = true) {
  return useQuery({
    queryKey: qk.analytics("subscriptions", { status }),
    queryFn: () => api.get<SubscriptionCandidateDTO[]>("/api/v1/fixed-expenses/subscriptions", status === "IGNORED" ? { status } : undefined),
    enabled,
  });
}

export function useSubscriptionMutations() {
  const qc = useQueryClient();
  const onError = (err: unknown) => toast.error(errorMessage(err));
  const refreshList = () => qc.invalidateQueries({ queryKey: ["analytics", "subscriptions"] });

  const reopen = useMutation({
    mutationFn: (c: SubscriptionCandidateDTO) => api.post(`/api/v1/fixed-expenses/subscriptions/${c.id}/reopen`),
    onSuccess: (_, c) => {
      toast.success("Voltou para as sugestões", { description: c.merchantName });
      refreshList();
    },
    onError,
  });

  const ignore = useMutation({
    mutationFn: (c: SubscriptionCandidateDTO) => api.post(`/api/v1/fixed-expenses/subscriptions/${c.id}/ignore`),
    onSuccess: (_, c) => {
      toast.success("Cobrança ignorada", { description: c.merchantName, action: { label: "Desfazer", onClick: () => reopen.mutate(c) } });
      refreshList();
    },
    onError,
  });

  const accept = useMutation({
    mutationFn: (c: SubscriptionCandidateDTO) => api.post<{ recurring: unknown; linkedTransactions: number }>(`/api/v1/fixed-expenses/subscriptions/${c.id}/accept`, {}),
    onSuccess: (res, c) => {
      const linked = res.linkedTransactions;
      toast.success("Cadastrada nos gastos fixos", {
        description: linked ? `${c.merchantName} · ${linked} ${linked === 1 ? "lançamento ligado" : "lançamentos ligados"} à recorrência` : c.merchantName,
      });
      // Gastos fixos e a lista de sugestões ficam sob "analytics"; a recorrência também aparece em Contas a pagar.
      ["analytics", "recurring", "bills"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError,
  });

  return { accept, ignore, reopen };
}
