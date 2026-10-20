"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { AppointmentDTO, AppointmentInput, GoogleStatusDTO } from "./types";

export const AGENDA_BASE = "/api/v1/agenda";
export const GOOGLE_BASE = "/api/v1/integrations/google";

export function useAppointments(range: { start: string; end: string }) {
  return useQuery({
    queryKey: qk.agenda(range),
    queryFn: () => api.get<AppointmentDTO[]>(AGENDA_BASE, range),
    placeholderData: keepPreviousData,
  });
}

function useInvalidateAgenda() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["agenda"] });
    qc.invalidateQueries({ queryKey: qk.google });
  };
}

export function useAppointmentMutations() {
  const invalidate = useInvalidateAgenda();
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const create = useMutation({
    mutationFn: (body: AppointmentInput) => api.post<AppointmentDTO>(AGENDA_BASE, body),
    onSuccess: (a) => {
      toast.success("Compromisso marcado", { description: a.title });
      invalidate();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: Partial<AppointmentInput> & { id: string }) => api.patch<AppointmentDTO>(`${AGENDA_BASE}/${id}`, body),
    onSuccess: (a) => {
      toast.success("Compromisso atualizado", { description: a.title });
      invalidate();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (a: AppointmentDTO) => api.delete<unknown>(`${AGENDA_BASE}/${a.id}`),
    onSuccess: (_, a) => {
      toast.success("Compromisso desmarcado", { description: a.title });
      invalidate();
    },
    onError,
  });

  return { create, update, remove };
}

// ---------------------------------------------------------------------------
// Google Agenda
// ---------------------------------------------------------------------------

export function useGoogleStatus() {
  return useQuery({ queryKey: qk.google, queryFn: () => api.get<GoogleStatusDTO>(GOOGLE_BASE) });
}

/** As rotas do Google devolvem o status atualizado: grava no cache e recarrega a agenda. */
function useSetGoogleStatus() {
  const qc = useQueryClient();
  return (data: GoogleStatusDTO, reloadAgenda = false) => {
    qc.setQueryData(qk.google, data);
    if (reloadAgenda) qc.invalidateQueries({ queryKey: ["agenda"] });
  };
}

/** Salva o aplicativo OAuth da família. O erro (422) é mostrado no formulário. */
export function useSaveGoogleApp() {
  const set = useSetGoogleStatus();
  return useMutation({
    mutationFn: (body: { clientId: string; clientSecret?: string }) => api.put<GoogleStatusDTO>(`${GOOGLE_BASE}/app`, body),
    onSuccess: (data) => {
      set(data);
      toast.success("Google Agenda configurado", { description: "Agora cada pessoa pode conectar a própria agenda." });
    },
  });
}

/** Pede o link de autorização e leva o navegador para o Google. */
export function useConnectGoogle() {
  return useMutation({
    mutationFn: () => api.post<{ url: string }>(`${GOOGLE_BASE}/connect`),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useSimulateGoogle() {
  const set = useSetGoogleStatus();
  return useMutation({
    mutationFn: () => api.post<GoogleStatusDTO>(`${GOOGLE_BASE}/simulate`),
    onSuccess: (data) => {
      set(data, true);
      toast.success("Agenda simulada conectada", { description: "Eventos de exemplo, nenhuma conta do Google foi usada." });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useUpdateGoogleSettings() {
  const set = useSetGoogleStatus();
  return useMutation({
    mutationFn: (body: { shareWithFamily: boolean }) => api.patch<GoogleStatusDTO>(`${GOOGLE_BASE}/settings`, body),
    onSuccess: (data, body) => {
      set(data, true);
      toast.success(body.shareWithFamily ? "Seus eventos do Google agora aparecem para a família" : "Seus eventos do Google agora só aparecem para você");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useSyncGoogle() {
  const set = useSetGoogleStatus();
  return useMutation({
    mutationFn: () => api.post<GoogleStatusDTO>(`${GOOGLE_BASE}/sync`),
    onSuccess: (data) => {
      set(data, true);
      if (data.me?.lastError) toast.warning("Não foi possível atualizar tudo", { description: data.me.lastError });
      else toast.success("Agenda do Google atualizada", { description: data.me ? `${data.me.events} ${data.me.events === 1 ? "evento" : "eventos"}` : undefined });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useDisconnectGoogle() {
  const set = useSetGoogleStatus();
  return useMutation({
    mutationFn: () => api.delete<GoogleStatusDTO>(GOOGLE_BASE),
    onSuccess: (data) => {
      set(data, true);
      toast.success("Google Agenda desconectado", { description: "Os eventos copiados do Google saíram da agenda do app." });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
