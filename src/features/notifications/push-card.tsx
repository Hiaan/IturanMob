"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellOff, BellRing, CircleCheck, Info, Send, ShieldAlert, Smartphone, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { INSTALL_SECTION_ID } from "@/components/pwa/install-instructions";
import { api, ApiError, errorMessage } from "@/lib/client/api";
import { formatDateTimeBR } from "@/lib/dates";
import { currentRegistration, deviceLabel, SW_ENABLED, SW_URL, urlBase64ToUint8Array, usePwaEnvironment } from "@/lib/client/pwa";
import { cn } from "@/lib/utils";

interface PushDevice {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  endpointHost: string;
}

interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  reason: string | null;
  devices: PushDevice[];
}

const PUSH_KEY = ["notifications", "push"] as const;

type Status = "loading" | "error" | "ios-install" | "unsupported" | "server-off" | "denied" | "active" | "inactive";

function serviceName(host: string): string {
  if (/push\.apple\.com$/.test(host)) return "Apple";
  if (/googleapis\.com$/.test(host)) return "Google";
  if (/mozilla\.com$/.test(host)) return "Mozilla";
  if (/windows\.com$/.test(host)) return "Microsoft";
  return host;
}

/** Pede a permissão já dentro do toque (exigência do iOS). Aceita a API antiga por callback. */
function requestPermissionNow(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    try {
      const maybe = Notification.requestPermission((p) => resolve(p));
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, () => resolve(Notification.permission));
    } catch {
      resolve(Notification.permission);
    }
  });
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true; // navegador não informa: assume a mesma chave
  const a = new Uint8Array(current);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  let reg = await currentRegistration();
  if (!reg) {
    if (!SW_ENABLED) throw new Error("O service worker só funciona no build de produção (no desenvolvimento, use NEXT_PUBLIC_SW_DEV=1).");
    reg = await navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" });
  }
  if (reg.active) return reg;
  return withTimeout(navigator.serviceWorker.ready, 15_000, "O app ainda está terminando de instalar. Aguarde alguns segundos e tente de novo.");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function pushErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Permissão de notificação negada neste aparelho.";
    if (err.name === "AbortError") return "O serviço de push do navegador não respondeu. Verifique a conexão e tente de novo.";
    if (err.name === "InvalidStateError") return "O app precisa ser reaberto para ativar as notificações. Feche e abra de novo.";
    if (err.name === "NotSupportedError") return "Este navegador não oferece notificações push.";
  }
  return errorMessage(err);
}

/**
 * "Notificações no celular" (Web Push): estado neste aparelho, ativar/desativar, teste e a lista de
 * aparelhos do membro. A chave privada fica só no servidor; aqui só a pública (VAPID).
 */
export function PushNotificationsCard() {
  const env = usePwaEnvironment();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: PUSH_KEY, queryFn: () => api.get<PushConfig>("/api/v1/push") });
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null | undefined>(undefined);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "enable" | "disable" | "test" | `remove:${string}`>(null);
  const [announcement, setAnnouncement] = useState("");
  const synced = useRef(false);

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: PUSH_KEY }), [qc]);

  // Estado local: permissão e inscrição já existente neste navegador.
  useEffect(() => {
    if (!env) return;
    if (!env.pushSupported) {
      setSubscription(null);
      return;
    }
    setPermission(Notification.permission);
    let cancelled = false;
    (async () => {
      const reg = await currentRegistration();
      const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
      if (!cancelled) setSubscription(sub);
    })();
    const onVisible = () => {
      if (document.visibilityState === "visible") setPermission(Notification.permission);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [env]);

  // Reenvia a inscrição existente (idempotente): mantém o servidor em dia e identifica "este aparelho".
  useEffect(() => {
    const data = config.data;
    if (synced.current || !subscription || !data?.enabled || !data.publicKey || permission !== "granted") return;
    synced.current = true;
    if (!sameKey(subscription, urlBase64ToUint8Array(data.publicKey))) {
      // A chave do servidor mudou: a inscrição antiga não recebe mais nada.
      subscription.unsubscribe().catch(() => undefined);
      setSubscription(null);
      return;
    }
    const json = subscription.toJSON();
    api
      .post<{ id: string }>("/api/v1/push/subscriptions", { endpoint: json.endpoint, keys: json.keys, deviceLabel: deviceLabel() })
      .then((r) => {
        setCurrentId(r.id);
        invalidate();
      })
      .catch(() => undefined);
  }, [config.data, subscription, permission, invalidate]);

  const devices = config.data?.devices ?? [];
  // O servidor remove inscrições expiradas (ex.: depois de um envio de teste). Se "este aparelho" sumiu
  // da lista, a inscrição local não recebe mais nada e precisa ser refeita.
  const stale = Boolean(currentId) && Boolean(config.data) && !devices.some((d) => d.id === currentId);

  const status: Status = (() => {
    if (!env) return "loading";
    if (!env.pushSupported) return env.ios && !env.standalone ? "ios-install" : "unsupported";
    if (config.isError && !config.data) return "error";
    if (config.isLoading || subscription === undefined) return "loading";
    if (config.data && !config.data.enabled) return "server-off";
    if (permission === "denied") return "denied";
    if (subscription && permission === "granted" && !stale) return "active";
    return "inactive";
  })();

  const say = (text: string) => setAnnouncement(text);

  const enable = () => {
    const publicKey = config.data?.publicKey;
    if (!publicKey || busy) return;
    setBusy("enable");
    // iOS: a permissão precisa ser pedida aqui, direto no toque, antes de qualquer outra espera.
    const permissionRequest = requestPermissionNow();
    void (async () => {
      try {
        const result = await permissionRequest;
        setPermission(result);
        if (result !== "granted") {
          const text = result === "denied" ? "Permissão negada. Libere as notificações nos ajustes do aparelho." : "Permissão não concedida.";
          say(text);
          toast.error(text);
          return;
        }
        const reg = await ensureRegistration();
        const key = urlBase64ToUint8Array(publicKey);
        let sub = await reg.pushManager.getSubscription();
        if (sub && (stale || !sameKey(sub, key))) {
          await sub.unsubscribe().catch(() => undefined);
          sub = null;
        }
        if (!sub) sub = await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), 30_000, "O serviço de push do navegador não respondeu. Verifique a conexão e tente de novo.");
        const json = sub.toJSON();
        const res = await api.post<{ id: string }>("/api/v1/push/subscriptions", { endpoint: json.endpoint, keys: json.keys, deviceLabel: deviceLabel() });
        synced.current = true;
        setSubscription(sub);
        setCurrentId(res.id);
        await invalidate();
        say("Notificações ativadas neste aparelho.");
        toast.success("Notificações ativadas neste aparelho", { description: "Use “Enviar teste” para conferir." });
      } catch (err) {
        const text = pushErrorMessage(err);
        say(text);
        toast.error(text);
      } finally {
        setBusy(null);
      }
    })();
  };

  const disable = async () => {
    setBusy("disable");
    try {
      const sub = subscription ?? (await (await currentRegistration())?.pushManager.getSubscription()) ?? null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => false);
        await api.deleteJson("/api/v1/push/subscriptions", { endpoint });
      }
      setSubscription(null);
      setCurrentId(null);
      await invalidate();
      say("Notificações desativadas neste aparelho.");
      toast.success("Notificações desativadas neste aparelho");
    } catch (err) {
      toast.error(pushErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    try {
      const r = await api.post<{ sent: number; failed: number; removed: number }>("/api/v1/push/test");
      const text = `Teste enviado para ${r.sent} ${r.sent === 1 ? "aparelho" : "aparelhos"}.`;
      say(text);
      if (r.failed) toast.warning(text, { description: `${r.failed} ${r.failed === 1 ? "aparelho não respondeu" : "aparelhos não responderam"}.` });
      else toast.success(text, { description: "A notificação deve chegar em alguns segundos." });
      await invalidate();
    } catch (err) {
      const text = pushErrorMessage(err);
      say(text);
      toast.error(text);
      await invalidate();
    } finally {
      setBusy(null);
    }
  };

  const removeDevice = async (device: PushDevice) => {
    setBusy(`remove:${device.id}`);
    try {
      await api.deleteJson("/api/v1/push/subscriptions", { id: device.id });
      if (device.id === currentId) {
        await subscription?.unsubscribe().catch(() => false);
        setSubscription(null);
        setCurrentId(null);
      }
      await invalidate();
      toast.success("Aparelho removido");
    } catch (err) {
      toast.error(pushErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-4 text-brand" aria-hidden /> Notificações no celular
        </CardTitle>
        <CardDescription>Avisos no aparelho mesmo com o app fechado. Valem para os tipos com frequência “Imediata” e respeitam o horário silencioso.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div aria-live="polite" aria-atomic="true">
          <StatusPanel status={status} reason={config.data?.reason ?? null} ios={Boolean(env?.ios)} />
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        {config.error && <ErrorState error={config.error} onRetry={() => config.refetch()} compact />}

        {(status === "inactive" || status === "active") && (
          <div className="flex flex-wrap gap-2">
            {status === "inactive" ? (
              <Button type="button" variant="brand" onClick={enable} loading={busy === "enable"} disabled={Boolean(busy) && busy !== "enable"}>
                <BellRing /> Ativar notificações
              </Button>
            ) : (
              <>
                <Button type="button" variant="brand" onClick={sendTest} loading={busy === "test"} disabled={Boolean(busy) && busy !== "test"}>
                  <Send /> Enviar teste
                </Button>
                <Button type="button" variant="outline" onClick={disable} loading={busy === "disable"} disabled={Boolean(busy) && busy !== "disable"}>
                  <BellOff /> Desativar neste aparelho
                </Button>
              </>
            )}
          </div>
        )}

        {config.data?.enabled && (
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">Seus aparelhos</h4>
              {devices.length > 0 && status !== "active" && (
                <Button type="button" variant="ghost" size="sm" onClick={sendTest} loading={busy === "test"} disabled={Boolean(busy) && busy !== "test"}>
                  <Send /> Enviar teste
                </Button>
              )}
            </div>
            {config.isLoading ? (
              <Skeleton className="h-14 rounded-lg" />
            ) : devices.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Nenhum aparelho com notificações ativadas.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {devices.map((d) => {
                  const label = d.deviceLabel || "Aparelho";
                  return (
                    <li key={d.id} className="flex items-center gap-3 p-3 text-sm">
                      <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                          <span className="truncate">{label}</span>
                          {d.id === currentId && <Badge variant="brand">este aparelho</Badge>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {serviceName(d.endpointHost)} · ativado em {formatDateTimeBR(d.createdAt)}
                          {" · "}
                          {d.lastSuccessAt ? `último envio ${formatDateTimeBR(d.lastSuccessAt)}` : "nenhum envio ainda"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeDevice(d)}
                        loading={busy === `remove:${d.id}`}
                        disabled={Boolean(busy) && busy !== `remove:${d.id}`}
                        aria-label={`Remover ${label}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        {busy !== `remove:${d.id}` && <Trash2 />}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusPanel({ status, reason, ios }: { status: Status; reason: string | null; ios: boolean }) {
  if (status === "error") return null;
  if (status === "loading")
    return (
      <div>
        <Skeleton className="h-14 rounded-lg" />
        <span className="sr-only">Verificando as notificações neste aparelho…</span>
      </div>
    );
  const tone =
    status === "active" ? "border-positive/30 bg-positive/8 text-foreground" : status === "inactive" ? "bg-muted/40" : status === "ios-install" ? "border-info/30 bg-info/8" : "border-warning/30 bg-warning/8";
  const Icon = status === "active" ? CircleCheck : status === "inactive" ? BellOff : status === "ios-install" ? Info : status === "denied" ? ShieldAlert : TriangleAlert;
  const iconColor = status === "active" ? "text-positive" : status === "inactive" ? "text-muted-foreground" : status === "ios-install" ? "text-info" : "text-warning";
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border p-3 text-sm", tone)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconColor)} aria-hidden />
      <div className="min-w-0 space-y-1">
        {status === "active" && (
          <>
            <p className="font-medium">Ativas neste aparelho</p>
            <p className="text-muted-foreground">Você recebe os avisos aqui mesmo com o app fechado.</p>
          </>
        )}
        {status === "inactive" && (
          <>
            <p className="font-medium">Desativadas neste aparelho</p>
            <p className="text-muted-foreground">Toque em “Ativar notificações” e permita quando o aparelho perguntar.</p>
          </>
        )}
        {status === "ios-install" && (
          <>
            <p className="font-medium">Instale o app para receber notificações</p>
            <p className="text-muted-foreground">
              No iPhone, as notificações só funcionam com o app aberto pela Tela de Início (iOS 16.4 ou mais recente).{" "}
              <a href={`#${INSTALL_SECTION_ID}`} className="font-medium text-brand underline-offset-4 hover:underline">
                Ver como instalar
              </a>
            </p>
          </>
        )}
        {status === "unsupported" && (
          <>
            <p className="font-medium">Não disponível neste navegador</p>
            <p className="text-muted-foreground">
              {ios ? "Este iPhone não oferece notificações para apps da web. Atualize para o iOS 16.4 ou mais recente." : "Este navegador não oferece notificações push. Tente o Chrome, o Edge, o Firefox ou o Safari atualizados."}
            </p>
          </>
        )}
        {status === "server-off" && (
          <>
            <p className="font-medium">Indisponível no servidor</p>
            <p className="text-muted-foreground">{reason ?? "As notificações push não estão configuradas no servidor."} Fale com quem administra o sistema.</p>
          </>
        )}
        {status === "denied" && (
          <>
            <p className="font-medium">Permissão negada neste aparelho</p>
            <p className="text-muted-foreground">
              {ios
                ? "Abra Ajustes → Notificações → Finanças e ative “Permitir Notificações”. Depois volte aqui."
                : "Libere as notificações nas configurações do site (ícone ao lado do endereço) e recarregue a página."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
