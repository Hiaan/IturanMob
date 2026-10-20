"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { OpenFinanceProvider, OpenFinanceStatusDTO, OpenFinanceSyncResult } from "./open-finance-types";

export const OF_BASE = "/api/v1/integrations/open-finance";

export function useOpenFinanceStatus(enabled = true) {
  return useQuery({ queryKey: qk.openFinance, queryFn: () => api.get<OpenFinanceStatusDTO>(OF_BASE), enabled });
}

/** Grava a resposta (o servidor devolve o status atualizado) direto no cache. */
function useSetStatus() {
  const qc = useQueryClient();
  return (data: OpenFinanceStatusDTO) => qc.setQueryData(qk.openFinance, data);
}

/** Salva as credenciais (ou liga o simulador). O erro de conferência (422) é mostrado no formulário. */
export function useSaveOpenFinanceCredentials() {
  const set = useSetStatus();
  return useMutation({
    mutationFn: (body: { provider: OpenFinanceProvider; clientId?: string; clientSecret?: string }) => api.put<OpenFinanceStatusDTO>(`${OF_BASE}/credentials`, body),
    onSuccess: (data, body) => {
      set(data);
      toast.success(body.provider === "SIMULATOR" ? "Simulador ligado" : "Credenciais conferidas e salvas", {
        description: body.provider === "SIMULATOR" ? "Adicione o banco de exemplo para testar." : "Agora adicione os seus bancos pelo ID da conexão.",
      });
    },
  });
}

export function useUpdateOpenFinanceSettings() {
  const set = useSetStatus();
  return useMutation({
    mutationFn: (body: { autoImport?: boolean; initialDays?: number }) => api.patch<OpenFinanceStatusDTO>(`${OF_BASE}/settings`, body),
    onSuccess: (data, body) => {
      set(data);
      if (body.autoImport !== undefined) toast.success(body.autoImport ? "Os lançamentos do banco vão entrar direto" : "Os lançamentos do banco vão para conferência");
      else toast.success("Configuração salva");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Adiciona um banco pelo ID da conexão (item). O erro (422) é mostrado no campo. */
export function useAddBankItem() {
  const set = useSetStatus();
  return useMutation({
    mutationFn: (itemId: string) => api.post<OpenFinanceStatusDTO>(`${OF_BASE}/items`, { itemId }),
    onSuccess: (data) => {
      set(data);
      toast.success("Banco adicionado", { description: "Ligue cada conta ou cartão do banco a uma conta ou cartão do app." });
    },
  });
}

export function useRemoveBankItem() {
  const set = useSetStatus();
  return useMutation({
    mutationFn: (id: string) => api.delete<OpenFinanceStatusDTO>(`${OF_BASE}/items/${id}`),
    onSuccess: (data) => {
      set(data);
      toast.success("Banco removido");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useUpdateBankLink() {
  const set = useSetStatus();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; accountId?: string | null; creditCardId?: string | null; enabled?: boolean }) =>
      api.patch<OpenFinanceStatusDTO>(`${OF_BASE}/links/${id}`, body),
    onSuccess: (data, body) => {
      set(data);
      if (body.enabled !== undefined) toast.success(body.enabled ? "Busca de lançamentos ligada" : "Busca de lançamentos desligada");
      else if (body.accountId === null || body.creditCardId === null) toast.success("Ligação desfeita");
      else toast.success("Ligação salva");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useRemoveOpenFinance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<unknown>(OF_BASE),
    onSuccess: () => {
      toast.success("Conexão com os bancos removida", { description: "Os lançamentos já importados continuam no app." });
      qc.invalidateQueries({ queryKey: qk.openFinance });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Busca agora nos bancos e resume o resultado num aviso (com atalho para conferir o lote). */
export function useSyncOpenFinance() {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: () => api.post<OpenFinanceSyncResult>(`${OF_BASE}/sync`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: qk.openFinance });
      qc.invalidateQueries({ queryKey: ["imports"] });
      const toReview = res.links.filter((l) => l.batchId && l.imported === null);
      const imported = res.links.reduce((sum, l) => sum + (l.imported ?? 0), 0);
      if (imported > 0) {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["accounts"] });
        qc.invalidateQueries({ queryKey: ["cards"] });
        qc.invalidateQueries({ queryKey: ["analytics"] });
      }
      const reviewCount = toReview.reduce((sum, l) => sum + l.newRows, 0);
      const first = toReview[0]?.batchId;
      if (first) {
        toast.success(plural(reviewCount, "lançamento novo para conferir", "lançamentos novos para conferir"), {
          description: toReview.length > 1 ? `Em ${toReview.length} contas ou cartões. Os outros lotes ficam no histórico da importação.` : undefined,
          action: { label: "Conferir", onClick: () => router.push(`/importacao?batch=${first}`) },
          duration: 10_000,
        });
      }
      if (imported > 0) toast.success(plural(imported, "lançamento importado", "lançamentos importados"));
      if (!first && imported === 0 && !res.errors.length) toast.info("Nada novo no banco");
      if (res.errors.length) {
        toast.warning(res.errors.length === 1 ? "Um problema na busca" : `${res.errors.length} problemas na busca`, {
          description: res.errors.join(" · "),
          duration: 12_000,
        });
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
