"use client";

import { useState } from "react";
import { AlertTriangle, CalendarDays, ChevronDown, Copy, ExternalLink, FlaskConical, KeyRound, LockKeyhole, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";
import type { GoogleStatusDTO } from "./types";
import { useConnectGoogle, useDisconnectGoogle, useGoogleStatus, useSaveGoogleApp, useSimulateGoogle, useSyncGoogle, useUpdateGoogleSettings } from "./use-agenda";

function formatDateTime(iso: string | null, timeZone?: string) {
  if (!iso) return "Ainda não atualizou";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Endereço copiado");
  } catch {
    toast.error("Não foi possível copiar. Selecione o endereço e copie manualmente.");
  }
}

function Guide({ redirectUri, defaultOpen }: { redirectUri: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border bg-muted/20">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        aria-expanded={open}
        aria-controls="google-guide"
        onClick={() => setOpen((v) => !v)}
      >
        Como configurar, passo a passo
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div id="google-guide" className="space-y-3 px-4 pb-4 text-sm">
          <ol className="list-decimal space-y-1.5 pl-5 text-foreground/85">
            <li>
              Em{" "}
              <a
                href="https://console.cloud.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-brand underline-offset-4 hover:underline"
              >
                console.cloud.google.com
                <ExternalLink className="size-3" aria-hidden />
                <span className="sr-only"> (abre em nova aba)</span>
              </a>{" "}
              crie um projeto e ative a “Google Calendar API”.
            </li>
            <li>Em “Tela de consentimento OAuth”, escolha Externo e adicione os e-mails da família como usuários de teste.</li>
            <li>
              Em “Credenciais”, crie um “ID do cliente OAuth” do tipo Aplicativo da Web e cadastre este URI de redirecionamento:
              <span className="mt-1.5 flex min-w-0 items-center gap-2 rounded-lg border bg-card px-2 py-1.5">
                <code className="min-w-0 flex-1 break-all font-mono text-xs">{redirectUri}</code>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Copiar URI de redirecionamento" onClick={() => copy(redirectUri)}>
                  <Copy />
                </Button>
              </span>
            </li>
            <li>Cole aqui o Client ID e o Client Secret.</li>
          </ol>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li className="flex items-start gap-1.5">
              <LockKeyhole className="mt-px size-3.5 shrink-0" aria-hidden /> Somente leitura: o app só lê a sua agenda.
            </li>
            <li className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> Enquanto o app estiver em modo de teste, o Google mostra um aviso de app não verificado — é esperado para uso pessoal.
            </li>
            <li className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> Os nomes no site do Google podem mudar.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

function AppForm({ status, onDone }: { status: GoogleStatusDTO; onDone?: () => void }) {
  const save = useSaveGoogleApp();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    if (!clientId.trim()) {
      setError("Informe o Client ID.");
      return;
    }
    if (!status.appConfigured && !clientSecret.trim()) {
      setError("Informe o Client Secret.");
      return;
    }
    save.mutate(
      { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) },
      {
        onSuccess: () => {
          setClientId("");
          setClientSecret("");
          onDone?.();
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <form
      className="grid gap-3 rounded-xl border p-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden /> Aplicativo do Google da família
      </p>
      <Field label="Client ID" htmlFor="google-client-id" hint={status.clientIdHint ? `Client ID salvo: ${status.clientIdHint}` : undefined}>
        <Input
          id="google-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-sm"
          placeholder="…apps.googleusercontent.com"
        />
      </Field>
      <Field label="Client Secret" htmlFor="google-client-secret" hint={status.appConfigured ? "Deixe vazio para manter o salvo." : undefined}>
        <Input
          id="google-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          className="font-mono text-sm"
          placeholder={status.appConfigured ? "•••••••• (salvo)" : "Cole o Client Secret"}
        />
      </Field>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="brand" loading={save.isPending}>
          Salvar aplicativo
        </Button>
        {onDone && (
          <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
            Cancelar
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">O Client Secret fica guardado com criptografia e não volta para a tela.</p>
    </form>
  );
}

function ConnectButtons({ status }: { status: GoogleStatusDTO }) {
  const connect = useConnectGoogle();
  const simulate = useSimulateGoogle();
  const busy = connect.isPending || simulate.isPending;
  return (
    <div className="flex flex-wrap gap-2">
      {status.appConfigured && (
        <Button variant="brand" onClick={() => connect.mutate()} loading={connect.isPending} disabled={busy}>
          <CalendarDays /> Conectar minha agenda do Google
        </Button>
      )}
      {status.simulatorAvailable && (
        <Button variant="outline" onClick={() => simulate.mutate()} loading={simulate.isPending} disabled={busy}>
          <FlaskConical /> Usar agenda simulada (exemplo)
        </Button>
      )}
    </div>
  );
}

function Connected({ status, timeZone }: { status: GoogleStatusDTO; timeZone?: string }) {
  const me = status.me!;
  const sync = useSyncGoogle();
  const settings = useUpdateGoogleSettings();
  const disconnect = useDisconnectGoogle();
  const [confirm, setConfirm] = useState(false);
  const share = settings.isPending && settings.variables ? settings.variables.shareWithFamily : me.shareWithFamily;
  return (
    <div className="space-y-4">
      {me.simulated && (
        <div role="note" className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="font-semibold text-warning">SIMULADO — eventos de exemplo, nenhuma conta do Google conectada</p>
        </div>
      )}
      <dl className="grid gap-1 text-sm">
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-muted-foreground">Conta</dt>
          <dd className="min-w-0 break-all font-medium">{me.email ?? (me.simulated ? "Agenda simulada" : "—")}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-muted-foreground">Eventos na agenda</dt>
          <dd className="font-medium tabular-nums">{me.events}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-muted-foreground">Última atualização</dt>
          <dd className="font-medium">{formatDateTime(me.lastSyncAt, timeZone)}</dd>
        </div>
      </dl>
      {!me.connected && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> A conexão com o Google caiu. Conecte de novo para voltar a atualizar.
        </p>
      )}
      {me.lastError && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {me.lastError}
        </p>
      )}
      <div className="grid gap-1.5 rounded-xl border p-3">
        <div className="flex items-start justify-between gap-3">
          <Label htmlFor="google-share" className="text-sm font-medium">
            Compartilhar meus eventos com a família
          </Label>
          <Switch
            id="google-share"
            checked={share}
            disabled={settings.isPending}
            aria-describedby="google-share-help"
            onCheckedChange={(shareWithFamily) => settings.mutate({ shareWithFamily })}
          />
        </div>
        <p id="google-share-help" className="text-xs text-muted-foreground">
          Desligado: só você vê e nada vai para o grupo. Ligado: aparecem para todos e entram no resumo da manhã do grupo.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {me.connected || me.simulated ? (
          <Button variant="brand" size="sm" onClick={() => sync.mutate()} loading={sync.isPending}>
            <RefreshCw /> Atualizar agora
          </Button>
        ) : (
          <ConnectButtons status={{ ...status, simulatorAvailable: false }} />
        )}
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirm(true)} loading={disconnect.isPending}>
          <Unplug /> Desconectar
        </Button>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar o Google Agenda?</AlertDialogTitle>
            <AlertDialogDescription>Os eventos copiados do Google saem da agenda do app; nada é apagado no Google.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => disconnect.mutate()}>
              Desconectar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Body({ status, timeZone }: { status: GoogleStatusDTO; timeZone?: string }) {
  const [editingApp, setEditingApp] = useState(false);
  const others = status.connectedMembers;
  return (
    <div className="space-y-4">
      {!status.appConfigured && !status.me ? (
        status.canManageApp ? (
          <>
            <Guide redirectUri={status.redirectUri} defaultOpen />
            <AppForm status={status} />
          </>
        ) : (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden /> Peça a quem administra a família para configurar o Google Agenda.
          </p>
        )
      ) : status.me ? (
        <Connected status={status} timeZone={timeZone} />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Conecte a sua agenda para ver os seus eventos do Google aqui. Cada pessoa conecta a própria agenda.</p>
          <ConnectButtons status={status} />
        </div>
      )}
      {!status.appConfigured && status.simulatorAvailable && !status.me && <ConnectButtons status={status} />}
      {others.length > 0 && (
        <p className="text-sm">
          <span className="text-muted-foreground">Conectaram:</span> <span className="font-medium">{others.map((m) => (m.simulated ? `${m.name} (simulada)` : m.name)).join(", ")}</span>
        </p>
      )}
      {status.appConfigured && status.canManageApp && (
        <div className="space-y-3 border-t pt-3">
          {editingApp ? (
            <>
              <Guide redirectUri={status.redirectUri} defaultOpen={false} />
              <AppForm status={status} onDone={() => setEditingApp(false)} />
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setEditingApp(true)}>
              <KeyRound /> Alterar aplicativo do Google
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Google Agenda: aplicativo OAuth da família (admin), conexão de cada pessoa e compartilhamento. */
export function GoogleCalendarCard({ className }: { className?: string }) {
  const me = useMe();
  const q = useGoogleStatus();
  const d = q.data;
  return (
    <Card className={cn("p-5", className)}>
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-info/12 text-info">
          <CalendarDays className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Google Agenda</h2>
            {d?.me?.simulated && (
              <Badge variant="warning">
                <FlaskConical aria-hidden /> SIMULADO
              </Badge>
            )}
            {d?.me && !d.me.simulated && d.me.connected && <Badge variant="positive">Conectado</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">Traz os eventos da sua agenda do Google para a agenda do app (somente leitura).</p>
        </div>
      </div>
      <div className="mt-4">
        {q.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : q.isError || !d ? (
          <ErrorState error={q.error} compact onRetry={() => q.refetch()} />
        ) : (
          <Body status={d} timeZone={me.data?.household.timezone} />
        )}
      </div>
    </Card>
  );
}
