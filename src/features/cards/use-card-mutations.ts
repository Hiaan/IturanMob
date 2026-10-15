"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import type { TransactionDTO } from "@/features/finance/types";
import { invalidateFinance } from "@/features/transactions/invalidate";

export interface CardInput {
  name: string;
  issuer: string | null;
  brand: string | null;
  last4: string | null;
  holderMemberId: string | null;
  visibility: "SHARED" | "PRIVATE";
  limitCents: number;
  closingDay: number;
  dueDay: number;
  paymentAccountId: string | null;
  color: string;
}

export function useCardMutations() {
  const qc = useQueryClient();
  const refresh = () => invalidateFinance(qc);

  const save = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: CardInput }) =>
      id ? api.patch<{ name: string }>(`/api/v1/cards/${id}`, input) : api.post<{ name: string }>("/api/v1/cards", { ...input, icon: "credit-card" }),
    onSuccess: (card, vars) => {
      toast.success(vars.id ? "Cartão atualizado" : "Cartão cadastrado", { description: card.name });
      refresh();
    },
  });

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.patch<{ name: string }>(`/api/v1/cards/${id}`, { archived }),
    onSuccess: (card, vars) => {
      toast.success(vars.archived ? "Cartão arquivado" : "Cartão reativado", { description: card.name });
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/v1/cards/${id}`),
    onSuccess: () => {
      toast.success("Cartão excluído");
      refresh();
    },
  });

  const pay = useMutation({
    mutationFn: ({ statementId, ...body }: { statementId: string; amountCents: number; accountId: string; date: string }) =>
      api.post<TransactionDTO>(`/api/v1/statements/${statementId}/pay`, body),
    onSuccess: (tx) => {
      toast.success("Pagamento registrado", { description: `${formatBRL(tx.amountCents)} saindo de ${tx.account?.name ?? "conta"}` });
      refresh();
    },
  });

  return { save, archive, remove, pay };
}
