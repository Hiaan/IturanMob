"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Utilitários do app instalável (PWA) no navegador: detecção de plataforma, modo "app"
 * (standalone), convite de instalação do Android/Chrome e conversões do Web Push.
 * Tudo aqui só roda no cliente; no servidor os hooks devolvem `null` (sem divergência de hidratação).
 */

export interface PwaEnvironment {
  /** iPhone, iPad ou iPod (inclui iPadOS que se apresenta como Mac). */
  ios: boolean;
  /** Safari de verdade no iOS (não Chrome/Firefox/Edge iOS nem navegadores embutidos em apps). */
  iosSafari: boolean;
  android: boolean;
  /** Aberto como app instalado (Tela de Início / janela própria). */
  standalone: boolean;
  /** O navegador expõe Service Worker + Push API + Notification. */
  pushSupported: boolean;
  serviceWorker: boolean;
}

// Navegadores no iOS que usam o WebKit mas não são o Safari, e apps com navegador embutido.
const NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|Brave|FBAN|FBAV|FBIOS|Instagram|LinkedInApp|Twitter|WhatsApp|Line\/|Snapchat|Pinterest|MicroMessenger|TikTok|musical_ly|Telegram/i;

export function detectIOS(nav: Navigator = navigator): boolean {
  const ua = nav.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ se identifica como "Macintosh"; a tela de toque denuncia.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export function detectIOSSafari(nav: Navigator = navigator): boolean {
  if (!detectIOS(nav)) return false;
  const ua = nav.userAgent;
  // O Safari traz "Version/x.y … Safari/…"; WebViews de apps normalmente não trazem "Safari/".
  return /Version\/[\d.]+.*Safari\//.test(ua) && !NOT_SAFARI.test(ua);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

export function readPwaEnvironment(): PwaEnvironment {
  const ios = detectIOS();
  const serviceWorker = "serviceWorker" in navigator;
  return {
    ios,
    iosSafari: detectIOSSafari(),
    android: /Android/i.test(navigator.userAgent),
    standalone: isStandalone(),
    serviceWorker,
    pushSupported: serviceWorker && "PushManager" in window && "Notification" in window,
  };
}

/** Ambiente do PWA; `null` até montar no cliente. Atualiza se o modo de exibição mudar. */
export function usePwaEnvironment(): PwaEnvironment | null {
  const [envState, setEnvState] = useState<PwaEnvironment | null>(null);
  useEffect(() => {
    const update = () => setEnvState(readPwaEnvironment());
    update();
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia("(display-mode: standalone)");
      mq.addEventListener("change", update);
    } catch {
      mq = null;
    }
    return () => mq?.removeEventListener("change", update);
  }, []);
  return envState;
}

/** Nome amigável do aparelho para a lista de dispositivos ("iPhone", "Android · Chrome"…). */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  let device = "Navegador";
  if (/iPhone|iPod/.test(ua)) device = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)) device = "iPad";
  else if (/Android/i.test(ua)) device = /Mobile/i.test(ua) ? "Android" : "Tablet Android";
  else if (/Macintosh|Mac OS X/.test(ua)) device = "Mac";
  else if (/Windows/.test(ua)) device = "Windows";
  else if (/CrOS/.test(ua)) device = "Chromebook";
  else if (/Linux/.test(ua)) device = "Linux";

  let browser = "";
  if (isStandalone()) browser = "app";
  else if (/EdgiOS|Edg\//.test(ua)) browser = "Edge";
  else if (/FxiOS|Firefox\//.test(ua)) browser = "Firefox";
  else if (/CriOS|Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return (browser ? `${device} · ${browser}` : device).slice(0, 80);
}

/** Chave pública VAPID (base64url) → bytes para `pushManager.subscribe`. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Service worker que deve estar ativo (registrado pelo `ServiceWorkerRegistrar`). */
export const SW_URL = "/sw.js";

/** Registro atual do service worker, se houver (não registra um novo). */
export async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? null;
  } catch {
    return null;
  }
}

/** O service worker só é registrado no build de produção (ou com NEXT_PUBLIC_SW_DEV=1 no dev). */
export const SW_ENABLED = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SW_DEV === "1";

// -----------------------------------------------------------------------------
// Convite de instalação (Android/Chrome/Edge): o evento chega uma vez, cedo, e é guardado aqui.
// -----------------------------------------------------------------------------

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Chamado uma vez (PwaRuntime) para capturar `beforeinstallprompt` e `appinstalled`. */
export function captureInstallPrompt(): () => void {
  const onPrompt = (e: Event) => {
    e.preventDefault(); // mostramos nosso botão em vez da barra do navegador
    deferredPrompt = e as BeforeInstallPromptEvent;
    emit();
  };
  const onInstalled = () => {
    deferredPrompt = null;
    emit();
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

/** `true` quando o navegador ofereceu a instalação (Android/Chrome/Edge). */
export function useInstallPromptAvailable(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => deferredPrompt !== null,
    () => false,
  );
}

/** Abre o diálogo nativo de instalação. Devolve se a pessoa aceitou. */
export async function promptInstall(): Promise<boolean> {
  const evt = deferredPrompt;
  if (!evt) return false;
  deferredPrompt = null;
  emit();
  await evt.prompt();
  const choice = await evt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  return choice.outcome === "accepted";
}

// -----------------------------------------------------------------------------
// Preferências locais (só conveniência do aparelho; o armazenamento pode não existir).
// -----------------------------------------------------------------------------

export const INSTALL_HINT_DISMISSED_KEY = "fa:install-hint-dismissed";

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // armazenamento indisponível (aba privada, bloqueado)
  }
}

/** Avisa os componentes da mesma aba que uma preferência local mudou. */
export const LOCAL_PREF_EVENT = "fa:local-pref";
export function notifyLocalPref(key: string) {
  window.dispatchEvent(new CustomEvent(LOCAL_PREF_EVENT, { detail: key }));
}
