"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { WaCommandResult, WaMessagesPage, WaMessageStatus, WaProvider, WaSimulateResult, WaStatus } from "./types";

export const WA_BASE = "/api/v1/integrations/whatsapp";

export function useWhatsAppStatus() {
  return useQuery({
    queryKey: qk.whatsapp({ view: "status" }),
    queryFn: () => api.get<WaStatus>(WA_BASE),
    // Durante a conexão/QR o status muda rápido; no resto do tempo o tempo real (SSE) invalida a consulta.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "QR_PENDING" || s === "CONNECTING" ? 4_000 : 15_000;
    },
  });
}

export function useWhatsAppQr(enabled: boolean) {
  return useQuery({
    queryKey: qk.whatsapp({ view: "qr" }),
    queryFn: async () => {
      try {
        return await api.get<{ dataUrl: string; expiresInSeconds: number }>(`${WA_BASE}/qr`);
      } catch (err) {
        // 404 = ainda não há QR Code pendente (o worker está gerando).
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    enabled,
    refetchInterval: enabled ? 5_000 : false,
    staleTime: 0,
  });
}

export function useWhatsAppMessages(filters: { status?: WaMessageStatus | "ALL"; limit?: number }, opts: { refetchInterval?: number | false } = {}) {
  const params = { limit: filters.limit ?? 30, status: filters.status && filters.status !== "ALL" ? filters.status : undefined };
  return useInfiniteQuery({
    queryKey: qk.whatsapp({ view: "messages", ...params }),
    queryFn: ({ pageParam }) => api.get<WaMessagesPage>(`${WA_BASE}/messages`, { ...params, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: opts.refetchInterval ?? false,
  });
}

function useInvalidateWhatsApp() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["whatsapp"] });
  };
}

function commandToast(res: WaCommandResult, success: string) {
  // O servidor só devolve "message" quando o pedido depende do worker (ou exige ação adicional).
  if (res.workerOnline || !res.message) toast.success(success);
  else toast.warning(success, { description: res.message });
}

export type ConnectionAction = "connect" | "reconnect" | "disconnect" | "logout";

const ACTION_SUCCESS: Record<ConnectionAction, string> = {
  connect: "Conexão solicitada",
  reconnect: "Reconexão solicitada",
  disconnect: "Desconexão solicitada",
  logout: "Sessão encerrada",
};

export function useConnectionAction() {
  const invalidate = useInvalidateWhatsApp();
  return useMutation({
    mutationFn: (action: ConnectionAction) => api.post<WaCommandResult>(`${WA_BASE}/${action}`),
    onSuccess: (res, action) => {
      commandToast(res, ACTION_SUCCESS[action]);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useUpdateWhatsAppSettings() {
  const invalidate = useInvalidateWhatsApp();
  return useMutation({
    mutationFn: (body: { provider?: WaProvider; processingEnabled?: boolean; phoneNumberId?: string | null }) =>
      api.patch<{ provider: WaProvider; processingEnabled: boolean; desiredConnected: boolean; requeued: number }>(`${WA_BASE}/settings`, body),
    onSuccess: (res, body) => {
      if (body.provider) toast.success("Provedor atualizado", { description: "Conecte novamente e autorize o grupo da família." });
      else if (body.processingEnabled === true)
        toast.success("Processamento reativado", { description: res.requeued ? `${res.requeued} mensagem(ns) guardada(s) voltaram para a fila.` : undefined });
      else if (body.processingEnabled === false) toast.success("Processamento pausado", { description: "As novas mensagens ficam guardadas e serão processadas ao reativar." });
      else toast.success("Configuração salva");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useSyncGroups() {
  const invalidate = useInvalidateWhatsApp();
  return useMutation({
    mutationFn: () => api.post<WaCommandResult>(`${WA_BASE}/groups/sync`),
    onSuccess: (res) => {
      commandToast(res, "Sincronização de grupos solicitada");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useAuthorizeGroup() {
  const invalidate = useInvalidateWhatsApp();
  return useMutation({
    mutationFn: ({ id, authorized }: { id: string; authorized: boolean }) =>
      api.patch<{ id: string; name: string; isAuthorized: boolean; revokedGroupId: string | null }>(`${WA_BASE}/groups/${id}`, { authorized }),
    onSuccess: (res) => {
      toast.success(res.isAuthorized ? `Grupo "${res.name}" autorizado` : `Autorização do grupo "${res.name}" revogada`);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useReprocessMessage() {
  const invalidate = useInvalidateWhatsApp();
  return useMutation({
    mutationFn: (id: string) => api.post<{ messageId: string; jobId: string; queued: boolean }>(`${WA_BASE}/messages/${id}/reprocess`),
    onSuccess: (res) => {
      if (res.queued) toast.success("Mensagem enviada para reprocessamento");
      else toast.warning("Reprocessamento registrado", { description: "A fila está indisponível; o worker retomará automaticamente." });
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useRetryFailed() {
  const invalidate = useInvalidateWhatsApp();
  return useMutation({
    mutationFn: () => api.post<{ total: number; requeued: number; skipped: Array<{ messageId: string; reason: string }> }>(`${WA_BASE}/retry-failed`),
    onSuccess: (res) => {
      if (!res.total) toast.info("Não há mensagens com falha");
      else
        toast.success(`${res.requeued} de ${res.total} mensagem(ns) reenviada(s) para processamento`, {
          description: res.skipped.length ? `${res.skipped.length} não puderam ser reprocessadas (ex.: mídia já apagada).` : undefined,
        });
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export interface SimulateInput {
  memberId: string;
  text?: string;
  audioBase64?: string;
  imageBase64?: string;
  documentBase64?: string;
  mimeType?: string;
  fileName?: string;
}

export function useSimulate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SimulateInput) => api.post<WaSimulateResult>(`${WA_BASE}/simulate`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["whatsapp"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["pending"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useOwnConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, consent }: { memberId: string; consent: boolean }) => api.patch(`/api/v1/members/${memberId}`, { whatsappConsent: consent }),
    onSuccess: (_r, v) => {
      toast.success(v.consent ? "Consentimento registrado" : "Consentimento revogado");
      qc.invalidateQueries({ queryKey: ["whatsapp"] });
      qc.invalidateQueries({ queryKey: qk.members });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
