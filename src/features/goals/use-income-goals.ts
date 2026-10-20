"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import type { IncomeGoalInput, IncomeGoalProgress } from "./types";

/** Metas de ganho com o progresso do mês corrente (inativas só quando pedido). */
export function useIncomeGoals(opts: { includeInactive?: boolean } = {}) {
  const includeInactive = Boolean(opts.includeInactive);
  return useQuery({
    queryKey: qk.incomeGoals({ includeInactive }),
    // A rota espera o texto "true"/"false" em includeInactive.
    queryFn: () => api.get<IncomeGoalProgress[]>("/api/v1/income-goals", includeInactive ? { includeInactive: "true" } : undefined),
    placeholderData: keepPreviousData,
  });
}

/** O servidor devolve o registro da meta (sem o progresso): os toasts usam só o valor. */
interface IncomeGoalRecord {
  id: string;
  targetCents: number;
  active: boolean;
}

/**
 * Criação, edição, ativação e exclusão. Erros de validação (ex.: já existe meta ativa para o recorte)
 * ficam com quem chama: o formulário mostra a mensagem no próprio diálogo.
 */
export function useIncomeGoalMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["income-goals"] });

  const create = useMutation({
    mutationFn: (body: IncomeGoalInput) => api.post<IncomeGoalRecord>("/api/v1/income-goals", body),
    onSuccess: (g) => {
      toast.success("Meta de ganho criada", { description: `${formatBRL(g.targetCents)} por mês` });
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: Partial<IncomeGoalInput> & { id: string }) => api.patch<IncomeGoalRecord>(`/api/v1/income-goals/${id}`, body),
    onSuccess: (g, vars) => {
      const onlyActive = Object.keys(vars).every((k) => k === "id" || k === "active");
      toast.success(onlyActive ? (g.active ? "Meta de ganho ativada" : "Meta de ganho desativada") : "Meta de ganho atualizada", { description: `${formatBRL(g.targetCents)} por mês` });
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/income-goals/${id}`),
    onSuccess: () => {
      toast.success("Meta de ganho excluída");
      invalidate();
    },
  });

  return { create, update, remove };
}
