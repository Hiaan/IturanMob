"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { notificationUrl } from "@/lib/notification-meta";
import type { NotificationDTO } from "./types";

/** Pedido para abrir o sininho de qualquer lugar (ex.: "Ver todas" dos pop-ups). */
export const OPEN_BELL_EVENT = "fa:open-notifications";

export function openNotificationsBell() {
  window.dispatchEvent(new Event(OPEN_BELL_EVENT));
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ updated: number }>("/api/v1/notifications/read-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
}

/** Abre o destino da notificação (`data.url` ou o do tipo) e a marca como lida, se ainda não estiver. */
export function useOpenNotification() {
  const router = useRouter();
  const markRead = useMarkNotificationRead();
  return (n: Pick<NotificationDTO, "id" | "type" | "data" | "readAt">) => {
    if (!n.readAt) markRead.mutate(n.id);
    router.push(notificationUrl(n.type, n.data));
  };
}
