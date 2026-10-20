"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import { formatDayMonthBR } from "@/lib/dates";
import type { BillDTO, BillList, BillStatus } from "./types";

/** Adiamento padrão do "Pagar depois" (o servidor aceita de 1 a 15 dias). */
export const SNOOZE_DAYS = 3;

export function useBills(params: { month: string; statuses?: BillStatus[] }) {
  return useQuery({
    queryKey: qk.bills(params),
    queryFn: () => api.get<BillList>("/api/v1/bills", { month: params.month, status: params.statuses }),
    placeholderData: keepPreviousData,
  });
}

/** Invalida contas a pagar e tudo o que um pagamento afeta (transações, saldos, faturas, gráficos). */
export function useInvalidateBills() {
  const qc = useQueryClient();
  return (withMoney = false) => {
    ["bills", "recurring", "analytics"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    if (withMoney) ["transactions", "accounts", "cards", "budgets", "pending", "me"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };
}

export interface BillInput {
  type: "EXPENSE" | "INCOME";
  description: string;
  amountCents: number;
  isEstimate: boolean;
  dueDate: string;
  categoryId: string | null;
  accountId: string | null;
  creditCardId: string | null;
  notes: string | null;
}

export interface PayInput {
  date: string;
  accountId: string | null;
  creditCardId: string | null;
  amountCents: number;
  paymentMethod: string | null;
}

export function useBillMutations() {
  const invalidate = useInvalidateBills();
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const create = useMutation({
    mutationFn: (body: BillInput) => api.post<BillDTO>("/api/v1/bills", body),
    onSuccess: (b) => {
      toast.success(b.type === "INCOME" ? "Receita prevista cadastrada" : "Conta cadastrada", { description: `${b.description} · ${formatBRL(b.amountCents)}` });
      invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: Partial<BillInput> & { id: string; status?: "PENDING" }) => api.patch<BillDTO>(`/api/v1/bills/${id}`, body),
    onSuccess: (b, vars) => {
      toast.success(vars.status === "PENDING" ? "Conta reaberta" : "Conta atualizada", { description: b.description });
      invalidate();
    },
    onError,
  });

  const pay = useMutation({
    mutationFn: ({ id, ...body }: PayInput & { id: string }) => api.post<{ bill: BillDTO }>(`/api/v1/bills/${id}/pay`, body),
    onSuccess: ({ bill }) => {
      toast.success(bill.type === "INCOME" ? "Recebimento registrado" : bill.status === "POSTED" ? "Lançada no cartão" : "Pagamento registrado", {
        description: `${bill.description} · ${formatBRL(bill.paidAmountCents ?? bill.amountCents)}`,
      });
      invalidate(true);
    },
    onError,
  });

  const undoPay = useMutation({
    mutationFn: (id: string) => api.delete<BillDTO>(`/api/v1/bills/${id}/pay`),
    onSuccess: (b) => {
      toast.success("Pagamento desfeito", { description: `${b.description} voltou a ficar prevista. O lançamento foi para a lixeira.` });
      invalidate(true);
    },
    onError,
  });

  const reopen = (id: string) => update.mutate({ id, status: "PENDING" });

  const skip = useMutation({
    mutationFn: (id: string) => api.post<BillDTO>(`/api/v1/bills/${id}/skip`),
    onSuccess: (b) => {
      toast.success("Ocorrência ignorada", { description: b.description, action: { label: "Reabrir", onClick: () => reopen(b.id) } });
      invalidate();
    },
    onError,
  });

  /** "Pagar depois": adia o lembrete de conta vencida (padrão 3 dias); a conta continua em aberto. */
  const snooze = useMutation({
    mutationFn: ({ id, days = SNOOZE_DAYS }: { id: string; days?: number }) => api.post<BillDTO>(`/api/v1/bills/${id}/snooze`, { days }),
    onSuccess: (b, vars) => {
      const days = vars.days ?? SNOOZE_DAYS;
      toast.success(`Lembrete adiado por ${days} ${days === 1 ? "dia" : "dias"}`, {
        description: b.reminderSnoozedUntil ? `${b.description} · até ${formatDayMonthBR(b.reminderSnoozedUntil)}` : b.description,
      });
      invalidate();
    },
    onError,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post<BillDTO>(`/api/v1/bills/${id}/cancel`),
    onSuccess: (b) => {
      toast.success("Conta cancelada", { description: b.description, action: { label: "Reabrir", onClick: () => reopen(b.id) } });
      invalidate();
    },
    onError,
  });

  return { create, update, pay, undoPay, skip, snooze, cancel, reopen };
}
