"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client/api";
import { onRealtimeEvent } from "@/lib/client/use-realtime";
import { notificationPriority, notificationUrl } from "@/lib/notification-meta";
import { SNOOZE_DAYS, useBillMutations } from "@/features/bills/use-bills";
import { NotificationIcon } from "./notification-icon";
import { usePopupPreference } from "./popup-preference";
import { pickPopups } from "./popup-queue";
import { dataString, type NotificationDTO, type NotificationPage } from "./types";
import { openNotificationsBell, useMarkNotificationRead } from "./use-notifications";

/** Ids já mostrados como pop-up neste navegador (para não repetir). */
const SHOWN_KEY = "fa:notification-popups-shown";
const MAX_REMEMBERED = 300;
/** Ao voltar ao app depois deste tempo fora, mostra os avisos mais importantes ainda não vistos. */
const AWAY_MS = 10 * 60_000;
const FETCH_LIMIT = 20;
/** Agrupa rajadas de "notification.created" (um aviso por pessoa, vários tipos no mesmo job). */
const LIVE_DEBOUNCE_MS = 800;
const POPUP_DURATION_MS = 15_000;

function loadShown(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberShown(ids: string[]) {
  try {
    const all = [...loadShown(), ...ids];
    localStorage.setItem(SHOWN_KEY, JSON.stringify(all.slice(-MAX_REMEMBERED)));
  } catch {
    // armazenamento indisponível: pode repetir um pop-up, sem outro efeito
  }
}

interface PopupHandlers {
  onOpen: () => void;
  onPaid: (() => void) | null;
  onSnooze: (() => Promise<unknown>) | null;
  onViewAll: (() => void) | null;
  onClose: () => void;
}

function NotificationPopup({ n, h }: { n: NotificationDTO; h: PopupHandlers }) {
  const [snoozing, setSnoozing] = useState(false);
  return (
    <div className="notification-popup flex w-full gap-3 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg" role="group" aria-label={n.title} data-notification-id={n.id}>
      <NotificationIcon type={n.type} data={n.data} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug">{n.title}</p>
          <button type="button" onClick={h.onClose} aria-label="Fechar aviso" className="-m-1 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-0.5 line-clamp-3 break-words text-xs text-muted-foreground">{n.body}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="brand" onClick={h.onOpen}>
            Abrir
          </Button>
          {h.onPaid && (
            <Button size="sm" variant="outline" onClick={h.onPaid}>
              Já paguei
            </Button>
          )}
          {h.onSnooze && (
            <Button
              size="sm"
              variant="outline"
              loading={snoozing}
              onClick={() => {
                setSnoozing(true);
                h.onSnooze?.().finally(() => setSnoozing(false));
              }}
            >
              Pagar depois
            </Button>
          )}
          {h.onViewAll && (
            <Button size="sm" variant="ghost" onClick={h.onViewAll}>
              Ver todas
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Pop-ups das notificações com o app aberto (montado no AppShell):
 * - "notification.created" no tempo real (ou push recebido com o app visível) → avisos novos;
 * - ao abrir o app e ao voltar depois de 10 min fora → até 3 não lidos ainda não mostrados,
 *   os mais importantes primeiro; havendo mais, o último oferece "Ver todas" (abre o sininho).
 * Respeita "Mostrar pop-ups no app"; os ids mostrados ficam neste navegador.
 */
export function NotificationPopups() {
  const router = useRouter();
  const pref = usePopupPreference();
  const enabled = pref.data?.inAppPopups === true;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const markRead = useMarkNotificationRead().mutate;
  const { snooze } = useBillMutations();
  const snoozeAsync = snooze.mutateAsync;
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Cópia em memória: sem localStorage (navegação privada), não repete o mesmo aviso nesta sessão.
  const sessionShown = useRef(new Set<string>());

  const present = useCallback(
    (batch: NotificationDTO[], more: boolean) => {
      const ids = batch.map((n) => `notification-${n.id}`);
      const dismissAll = () => ids.forEach((id) => toast.dismiss(id));
      // O sonner põe o mais recente na frente: cria do menos para o mais importante.
      for (let i = batch.length - 1; i >= 0; i--) {
        const n = batch[i]!;
        const toastId = ids[i]!;
        const close = () => toast.dismiss(toastId);
        const billId = n.type === "BILL_OVERDUE" ? dataString(n.data, "scheduledPaymentId") : null;
        const h: PopupHandlers = {
          onOpen: () => {
            close();
            markRead(n.id);
            router.push(notificationUrl(n.type, n.data));
          },
          onPaid: billId
            ? () => {
                close();
                markRead(n.id);
                router.push(`/contas-a-pagar?pay=${encodeURIComponent(billId)}`);
              }
            : null,
          onSnooze: billId
            ? () =>
                snoozeAsync({ id: billId, days: SNOOZE_DAYS }).then(
                  () => {
                    close();
                    markRead(n.id);
                  },
                  () => undefined, // o erro já aparece em um toast (useBillMutations)
                )
            : null,
          onViewAll:
            more && i === batch.length - 1
              ? () => {
                  // Os pop-ups cobririam o painel no celular.
                  dismissAll();
                  openNotificationsBell();
                }
              : null,
          onClose: close,
        };
        toast.custom(() => <NotificationPopup n={n} h={h} />, {
          id: toastId,
          testId: "notification-popup",
          // Conta vencida fica até a pessoa agir ou fechar.
          duration: notificationPriority(n.type, n.data) === 0 ? Infinity : POPUP_DURATION_MS,
        });
      }
    },
    [markRead, router, snoozeAsync],
  );

  /** Busca os não lidos e mostra até 3 ainda não vistos neste navegador (execuções em fila, sem duplicar). */
  const run = useCallback(
    (mode: "batch" | "live") => {
      const task = async () => {
        if (!enabledRef.current) return;
        // Com o app em segundo plano, o push do celular avisa; ao voltar (10 min+) entram os pendentes.
        if (mode === "live" && document.visibilityState === "hidden") return;
        let page: NotificationPage;
        try {
          page = await api.get<NotificationPage>("/api/v1/notifications", { unreadOnly: true, limit: FETCH_LIMIT });
        } catch {
          return;
        }
        if (!enabledRef.current) return;
        const shown = loadShown();
        sessionShown.current.forEach((id) => shown.add(id));
        const { batch, more } = pickPopups(page.items, shown, { hasMorePages: Boolean(page.nextCursor) });
        if (!batch.length) return;
        batch.forEach((n) => sessionShown.current.add(n.id));
        rememberShown(batch.map((n) => n.id));
        present(batch, more);
      };
      // Uma falha não pode travar a fila das próximas execuções.
      queue.current = queue.current.then(task).catch(() => undefined);
    },
    [present],
  );

  // Primeira carga: assim que a preferência confirma que os pop-ups estão ligados.
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    run("batch");
  }, [enabled, run]);

  // Avisos novos em tempo real (SSE) e push recebido com o app visível (o service worker repassa).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => run("live"), LIVE_DEBOUNCE_MS);
    };
    const off = onRealtimeEvent("notification.created", schedule);
    const sw = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: unknown } | null)?.type === "push") schedule();
    };
    sw?.addEventListener("message", onMessage);
    return () => {
      off();
      sw?.removeEventListener("message", onMessage);
      if (timer) clearTimeout(timer);
    };
  }, [run]);

  // Volta ao app depois de 10 min ou mais fora.
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= AWAY_MS) run("batch");
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [run]);

  return null;
}
