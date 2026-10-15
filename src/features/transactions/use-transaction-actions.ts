"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { TransactionDTO } from "@/features/finance/types";
import { invalidateFinance } from "./invalidate";

export interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  actorMemberId: string | null;
  createdAt: string;
  metadata: { changes?: Record<string, { from: unknown; to: unknown }> } | null;
  source: string | null;
}

export type TransactionDetail = TransactionDTO & {
  installments: NonNullable<TransactionDTO["installments"]>;
  attachments: NonNullable<TransactionDTO["attachments"]>;
  history: AuditEntry[];
};

export function useTransactionDetail(id: string | null) {
  return useQuery({
    queryKey: qk.transaction(id ?? "none"),
    queryFn: () => api.get<TransactionDetail>(`/api/v1/transactions/${id}`),
    enabled: Boolean(id),
  });
}

type BulkAction = { action: "reclassify"; ids: string[]; categoryId: string; subcategoryId: string | null } | { action: "delete" | "restore" | "confirm"; ids: string[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Ações sobre transações (individuais e em lote), com toasts e invalidação das consultas afetadas. */
export function useTransactionActions() {
  const qc = useQueryClient();
  const done = () => invalidateFinance(qc, ["categories"]);

  const confirm = useMutation({
    mutationFn: (id: string) => api.post<TransactionDTO>(`/api/v1/transactions/${id}/confirm`),
    onSuccess: () => {
      toast.success("Lançamento confirmado", { description: "Agora ele afeta saldos e relatórios." });
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/v1/transactions/${id}`),
    onSuccess: (_res, id) => {
      toast.success("Lançamento movido para a lixeira", {
        description: "Ele deixa de afetar saldos e relatórios.",
        action: { label: "Desfazer", onClick: () => restore.mutate(id) },
      });
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: done,
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.post<TransactionDTO>(`/api/v1/transactions/${id}/restore`),
    onSuccess: () => {
      toast.success("Lançamento restaurado");
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const purge = useMutation({
    mutationFn: async (ids: string[]) => {
      let ok = 0;
      const errors: string[] = [];
      for (const id of ids) {
        try {
          await api.post(`/api/v1/transactions/${id}/purge`, { confirmation: "EXCLUIR" });
          ok++;
        } catch (e) {
          errors.push(errorMessage(e));
        }
      }
      return { ok, errors };
    },
    onSuccess: ({ ok, errors }) => {
      if (ok) toast.success(`${plural(ok, "lançamento excluído", "lançamentos excluídos")} definitivamente`);
      if (errors.length) toast.error(errors[0] ?? "Não foi possível excluir.", { description: errors.length > 1 ? `${errors.length} falhas` : undefined });
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const bulk = useMutation({
    mutationFn: (body: BulkAction) => api.post<{ updated: number }>("/api/v1/transactions/bulk", body),
    onSuccess: (res, body) => {
      const n = res.updated;
      const msg =
        body.action === "reclassify"
          ? `${plural(n, "lançamento reclassificado", "lançamentos reclassificados")}`
          : body.action === "confirm"
            ? `${plural(n, "lançamento confirmado", "lançamentos confirmados")}`
            : body.action === "delete"
              ? `${plural(n, "lançamento movido", "lançamentos movidos")} para a lixeira`
              : `${plural(n, "lançamento restaurado", "lançamentos restaurados")}`;
      toast.success(msg);
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: done,
  });

  return { confirm, remove, restore, purge, bulk };
}
