"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import type { AccountDTO } from "@/features/finance/types";
import { invalidateFinance } from "@/features/transactions/invalidate";

export interface AccountInput {
  name: string;
  institution: string | null;
  type: string;
  visibility: "SHARED" | "PRIVATE";
  ownerMemberId: string | null;
  initialBalanceCents: number;
  initialBalanceDate: string;
  color: string;
  icon: string;
  includeInTotals: boolean;
}

export function useAccountMutations() {
  const qc = useQueryClient();
  const refresh = () => invalidateFinance(qc);

  const save = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: AccountInput }) =>
      id ? api.patch<AccountDTO>(`/api/v1/accounts/${id}`, input) : api.post<AccountDTO>("/api/v1/accounts", input),
    onSuccess: (acc, vars) => {
      toast.success(vars.id ? "Conta atualizada" : "Conta criada", { description: `${acc.name} · saldo ${formatBRL(acc.balanceCents)}` });
      refresh();
    },
  });

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.patch<AccountDTO>(`/api/v1/accounts/${id}`, { archived }),
    onSuccess: (acc, vars) => {
      toast.success(vars.archived ? "Conta arquivada" : "Conta reativada", {
        description: vars.archived ? `${acc.name} não aparece mais nas listas, mas o histórico é mantido.` : acc.name,
      });
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/v1/accounts/${id}`),
    onSuccess: () => {
      toast.success("Conta excluída");
      refresh();
    },
  });

  const adjust = useMutation({
    mutationFn: ({ id, ...body }: { id: string; targetBalanceCents: number; date?: string; note?: string }) =>
      api.post<{ adjusted: boolean; account: AccountDTO }>(`/api/v1/accounts/${id}/adjust`, body),
    onSuccess: (res) => {
      if (res.adjusted) toast.success("Saldo ajustado", { description: `${res.account.name} · novo saldo ${formatBRL(res.account.balanceCents)}` });
      else toast.info("O saldo já estava correto", { description: "Nenhum ajuste foi necessário." });
      refresh();
    },
  });

  return { save, archive, remove, adjust };
}
