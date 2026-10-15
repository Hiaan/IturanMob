"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import type { RecurringDTO, RecurringList } from "./types";

export function useRecurringList() {
  return useQuery({ queryKey: qk.recurring({}), queryFn: () => api.get<RecurringList>("/api/v1/recurring"), placeholderData: keepPreviousData });
}

export type RecurringInput = Record<string, unknown>;

export function useRecurringMutations() {
  const qc = useQueryClient();
  const invalidate = () => ["recurring", "bills", "analytics"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const create = useMutation({
    mutationFn: (body: RecurringInput) => api.post<RecurringDTO>("/api/v1/recurring", body),
    onSuccess: (r) => {
      toast.success("Recorrência criada", { description: `${r.description} · ${formatBRL(r.amountCents)} · ${r.scheduleLabel}` });
      invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: RecurringInput & { id: string }) => api.patch<RecurringDTO>(`/api/v1/recurring/${id}`, body),
    onSuccess: (r) => {
      toast.success("Recorrência atualizada", { description: "As próximas ocorrências previstas foram ajustadas; as já pagas não mudam." });
      invalidate();
      return r;
    },
    onError,
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.post<RecurringDTO>(`/api/v1/recurring/${v.id}/toggle`, { active: v.active }),
    onSuccess: (r) => {
      toast.success(r.active ? "Recorrência ativada" : "Recorrência desativada", {
        description: r.active ? "As próximas ocorrências voltaram para contas a pagar." : "As ocorrências futuras previstas foram canceladas.",
      });
      invalidate();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ removedOccurrences: number }>(`/api/v1/recurring/${id}`),
    onSuccess: (res) => {
      toast.success("Recorrência excluída", { description: `${res.removedOccurrences} ${res.removedOccurrences === 1 ? "ocorrência futura removida" : "ocorrências futuras removidas"}; o histórico pago foi mantido.` });
      invalidate();
    },
    onError,
  });

  return { create, update, toggle, remove };
}
