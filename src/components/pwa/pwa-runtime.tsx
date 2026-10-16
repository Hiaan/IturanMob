"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { captureInstallPrompt, isStandalone, SW_ENABLED, SW_URL } from "@/lib/client/pwa";

const UPDATE_INTERVAL_MS = 30 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
const UPDATE_TOAST_ID = "sw-update";

/**
 * Comportamentos globais do app instalável, montados uma única vez (AppProviders):
 * - registra o service worker (/sw.js) e procura atualizações ao voltar para o app e a cada 30 min;
 * - quando uma nova versão assume (o SW já faz skipWaiting), oferece "Atualizar" sem recarregar sozinho;
 * - guarda o convite de instalação do Android/Chrome;
 * - links para outros sites abrem fora do app (nova aba / Safari), sem tirar a pessoa do app.
 */
export function PwaRuntime() {
  useEffect(() => captureInstallPrompt(), []);
  useServiceWorker();
  useExternalLinks();
  return null;
}

function useServiceWorker() {
  useEffect(() => {
    if (!SW_ENABLED || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    // Na primeira instalação o SW assume a página (clients.claim) — isso não é "nova versão".
    let hadController = Boolean(sw.controller);
    let registration: ServiceWorkerRegistration | null = null;
    let lastCheck = Date.now();
    let disposed = false;

    const onControllerChange = () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      // Nunca recarrega sozinho: a pessoa pode estar digitando um lançamento.
      toast("Nova versão disponível", {
        id: UPDATE_TOAST_ID,
        description: "Toque em Atualizar para usar a versão mais recente do app.",
        duration: Infinity,
        action: { label: "Atualizar", onClick: () => window.location.reload() },
      });
    };
    sw.addEventListener("controllerchange", onControllerChange);

    sw.register(SW_URL, { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        if (disposed) return;
        registration = reg;
      })
      .catch(() => {
        // Sem SW (ex.: navegador bloqueando): o app segue funcionando normalmente, só sem push/offline.
      });

    const check = (force = false) => {
      if (!registration || document.visibilityState !== "visible") return;
      if (!force && Date.now() - lastCheck < MIN_CHECK_GAP_MS) return;
      lastCheck = Date.now();
      registration.update().catch(() => undefined);
    };
    const onVisible = () => check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(() => check(true), UPDATE_INTERVAL_MS);

    return () => {
      disposed = true;
      sw.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, []);
}

/** Links http(s) para outras origens: abrem fora do app (nova aba no navegador; Safari no iPhone). */
function useExternalLinks() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute("download")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (url.origin === window.location.origin) return;
      // Garante o rel seguro mesmo em links que já pedem nova aba.
      const rel = new Set((anchor.rel || "").split(/\s+/).filter(Boolean));
      rel.add("noopener");
      rel.add("noreferrer");
      anchor.rel = [...rel].join(" ");
      if (anchor.target && anchor.target !== "_self") return;
      if (isStandalone() || !(e.metaKey || e.ctrlKey || e.shiftKey)) {
        anchor.target = "_blank";
      }
    };
    // Captura: ajusta o link antes de o navegador seguir.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}
