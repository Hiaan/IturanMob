"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import type { ContributeResult, ContributionDTO, GoalDTO, GoalList } from "./types";

export function useGoals(includeArchived: boolean) {
  return useQuery({
    queryKey: qk.goals({ includeArchived }),
    queryFn: () => api.get<GoalList>("/api/v1/goals", includeArchived ? { includeArchived: true } : undefined),
    placeholderData: keepPreviousData,
  });
}

export function useContributions(goalId: string | null) {
  return useQuery({
    queryKey: qk.goals({ contributions: goalId }),
    queryFn: () => api.get<{ items: ContributionDTO[]; nextCursor: string | null }>(`/api/v1/goals/${goalId}/contributions`, { limit: 100 }),
    enabled: Boolean(goalId),
  });
}

function useInvalidateGoals() {
  const qc = useQueryClient();
  return (withMoney = false) => {
    qc.invalidateQueries({ queryKey: ["goals"] });
    if (withMoney) ["accounts", "transactions", "analytics"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };
}

export interface GoalInput {
  name: string;
  targetCents: number;
  deadline: string | null;
  accountId: string | null;
  color: string;
  icon: string;
  notes: string | null;
}

export function useGoalMutations() {
  const invalidate = useInvalidateGoals();
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const create = useMutation({
    mutationFn: (body: GoalInput) => api.post<GoalDTO>("/api/v1/goals", body),
    onSuccess: (g) => {
      toast.success("Meta criada", { description: `${g.name} · ${formatBRL(g.targetCents)}` });
      invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: Partial<GoalInput> & { id: string; status?: GoalDTO["status"] }) => api.patch<GoalDTO>(`/api/v1/goals/${id}`, body),
    onSuccess: (g, vars) => {
      toast.success(vars.status === "ARCHIVED" ? "Meta arquivada" : vars.status === "ACTIVE" ? "Meta reativada" : "Meta atualizada", { description: g.name });
      invalidate();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/goals/${id}`),
    onSuccess: () => {
      toast.success("Meta excluída");
      invalidate(true);
    },
    onError,
  });

  const contribute = useMutation({
    mutationFn: ({ goalId, ...body }: { goalId: string; amountCents: number; date: string; fromAccountId: string | null; note: string | null }) =>
      api.post<ContributeResult>(`/api/v1/goals/${goalId}/contributions`, body),
    onSuccess: (res) => {
      const withdrawal = res.contribution.amountCents < 0;
      const kind = res.contribution.kind === "TRANSFER" ? "transferência registrada" : "alocação interna";
      toast.success(withdrawal ? "Resgate registrado" : "Contribuição registrada", {
        description: `${formatBRL(Math.abs(res.contribution.amountCents))} · ${kind}`,
      });
      if (res.completedNow) toast.success(`Meta atingida: ${res.goal.name}`, { description: "O valor desejado foi alcançado e a meta foi marcada como concluída." });
      invalidate(res.contribution.kind === "TRANSFER");
    },
    onError,
  });

  const removeContribution = useMutation({
    mutationFn: (c: ContributionDTO) => api.delete<{ goal: GoalDTO }>(`/api/v1/goals/contributions/${c.id}`),
    onSuccess: (_res, c) => {
      toast.success(c.amountCents < 0 ? "Resgate excluído" : "Contribuição excluída", c.kind === "TRANSFER" ? { description: "A transferência vinculada também foi excluída." } : undefined);
      invalidate(c.kind === "TRANSFER");
    },
    onError,
  });

  return { create, update, remove, contribute, removeContribution };
}
