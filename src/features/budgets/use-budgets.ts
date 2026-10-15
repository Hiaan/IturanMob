"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { BudgetHistory, BudgetList } from "./types";

export function useBudgets(month: string) {
  return useQuery({
    queryKey: qk.budgets({ month }),
    queryFn: () => api.get<BudgetList>("/api/v1/budgets", { month }),
    placeholderData: keepPreviousData,
  });
}

export function useBudgetHistory(endMonth: string, months = 6) {
  return useQuery({
    queryKey: qk.budgets({ history: true, endMonth, months }),
    queryFn: () => api.get<BudgetHistory>("/api/v1/budgets/history", { endMonth, months }),
    placeholderData: keepPreviousData,
  });
}

/** Invalida tudo o que depende de orçamentos. */
export function useInvalidateBudgets() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["budgets"] });
    qc.invalidateQueries({ queryKey: ["analytics"] });
  };
}

export function useBudgetMutations() {
  const invalidate = useInvalidateBudgets();
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const upsert = useMutation({
    mutationFn: (body: { categoryId: string; month: string; limitCents: number }) => api.post("/api/v1/budgets", body),
    onSuccess: () => {
      toast.success("Orçamento salvo");
      invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: (v: { id: string; limitCents: number }) => api.patch(`/api/v1/budgets/${v.id}`, { limitCents: v.limitCents }),
    onSuccess: () => {
      toast.success("Limite atualizado");
      invalidate();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/budgets/${id}`),
    onSuccess: () => {
      toast.success("Orçamento excluído");
      invalidate();
    },
    onError,
  });

  const copyPrevious = useMutation({
    mutationFn: (month: string) => api.post<{ copied: number; skipped: number }>("/api/v1/budgets/copy-previous", { month }),
    onSuccess: (res) => {
      if (res.copied === 0) toast.info("Nada a copiar", { description: res.skipped ? "As categorias do mês anterior já têm orçamento neste mês." : "O mês anterior não tem orçamentos." });
      else toast.success(`${res.copied} ${res.copied === 1 ? "orçamento copiado" : "orçamentos copiados"}`, res.skipped ? { description: `${res.skipped} já existiam e foram mantidos.` } : undefined);
      invalidate();
    },
    onError,
  });

  const bulk = useMutation({
    mutationFn: (body: { month: string; items: Array<{ categoryId: string; limitCents: number | null }> }) =>
      api.post<{ upserted: number; removed: number }>("/api/v1/budgets/bulk", body),
    onSuccess: (res) => {
      toast.success("Orçamentos atualizados", { description: `${res.upserted} definidos ou alterados · ${res.removed} removidos` });
      invalidate();
    },
    onError,
  });

  return { upsert, update, remove, copyPrevious, bulk };
}
