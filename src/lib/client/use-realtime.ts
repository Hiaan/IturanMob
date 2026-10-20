"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EVENT_INVALIDATIONS } from "./query-keys";

/** Evento de janela disparado a cada mensagem do tempo real (`detail` = evento do servidor). */
export const REALTIME_EVENT = "fa:realtime";

export interface RealtimeMessage {
  type: string;
  [key: string]: unknown;
}

/** Escuta um tipo de evento do tempo real (ex.: "notification.created"); devolve a função de cancelar. */
export function onRealtimeEvent(type: string, handler: (event: RealtimeMessage) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<RealtimeMessage>).detail;
    if (detail?.type === type) handler(detail);
  };
  window.addEventListener(REALTIME_EVENT, listener);
  return () => window.removeEventListener(REALTIME_EVENT, listener);
}

/**
 * Assina os eventos em tempo real (SSE) e invalida somente as consultas afetadas.
 * Reconecta com backoff; se o tempo real cair, o app continua funcionando normalmente.
 */
export function useRealtime() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry = 0;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      const keys = [...pending.current];
      pending.current.clear();
      for (const k of keys) qc.invalidateQueries({ queryKey: JSON.parse(k) as string[] });
    };

    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      es = new EventSource("/api/v1/events");
      es.addEventListener("ready", () => {
        retry = 0;
        setStatus("live");
      });
      es.addEventListener("degraded", () => setStatus("offline"));
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as RealtimeMessage;
          for (const key of EVENT_INVALIDATIONS[event.type] ?? []) pending.current.add(JSON.stringify(key));
          // Repassa o evento a quem precisa reagir além de recarregar dados (ex.: pop-ups de notificação).
          window.dispatchEvent(new CustomEvent<RealtimeMessage>(REALTIME_EVENT, { detail: event }));
          // Agrupa rajadas de eventos em uma única atualização.
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, 300);
        } catch {
          // ignora eventos malformados
        }
      };
      es.onerror = () => {
        es?.close();
        setStatus("offline");
        retry = Math.min(retry + 1, 6);
        reconnectTimer = setTimeout(connect, 1000 * 2 ** retry);
      };
    };

    connect();
    return () => {
      closed = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [qc]);

  return status;
}
