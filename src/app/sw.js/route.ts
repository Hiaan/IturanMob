import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Service worker do app instalável. Gerado por rota para levar a versão do build: a cada deploy o
 * arquivo muda, o navegador instala a nova versão e ela assume na hora (sem ficar preso na antiga).
 *
 * Regras de cache (nada de dados financeiros):
 * - /api/** (inclusive o SSE /api/v1/events) e requisições do Next com dados (RSC) → sempre rede;
 * - páginas → sempre rede; sem conexão, mostra /offline (página estática, sem dados);
 * - /_next/static (arquivos com hash, imutáveis), ícones e manifest → cache.
 */

export const dynamic = "force-dynamic";

let version: string | null = null;
function buildVersion(): string {
  if (version) return version;
  try {
    version = readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    version = `dev-${Date.now()}`;
  }
  return version;
}

const SW = (v: string) => `/* Finance AI — service worker ${v} */
const VERSION = ${JSON.stringify(v)};
const STATIC_CACHE = "fa-static-" + VERSION;
const SHELL_CACHE = "fa-shell-" + VERSION;
const SHELL = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/badge-96.png", "/apple-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("fa-") && k !== STATIC_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isData(req, url) {
  return url.pathname.startsWith("/api/") || url.searchParams.has("_rsc") || req.headers.get("RSC") === "1" || req.headers.get("Next-Router-Prefetch") || req.headers.get("accept") === "text/event-stream";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Dados financeiros e eventos em tempo real: nunca passam pelo cache.
  if (isData(req, url)) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline", { cacheName: SHELL_CACHE }).then((r) => r || Response.error())));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || network;
      }),
    );
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// ---- Notificações push ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Finanças", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Finanças";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
`;

export function GET() {
  return new Response(SW(buildVersion()), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
