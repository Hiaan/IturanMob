"use client";

import { BadgeCheck, CalendarClock, FlaskConical, LogOut, Phone, Plug, Power, RefreshCw, Server, ShieldAlert, Unplug } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useConnectionAction, useUpdateWhatsAppSettings, type ConnectionAction } from "./hooks";
import { CONNECTION_META, PROVIDER_SHORT, TONE_SOFT_BG, TONE_TEXT } from "./status-meta";
import type { WaStatus } from "./types";
import { formatPhone, timeAgo } from "./utils";

function Fact({ icon: Icon, label, children }: { icon: typeof Phone; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/30 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden /> {label}
      </p>
      <div className="mt-1 text-sm font-medium">{children}</div>
    </div>
  );
}

export function ProviderBadge({ status }: { status: Pick<WaStatus, "provider" | "official"> }) {
  if (status.provider === "SIMULATOR")
    return (
      <Badge variant="info">
        <FlaskConical aria-hidden /> {PROVIDER_SHORT.SIMULATOR}
      </Badge>
    );
  if (status.official)
    return (
      <Badge variant="positive">
        <BadgeCheck aria-hidden /> {PROVIDER_SHORT[status.provider]}
      </Badge>
    );
  return (
    <Badge variant="warning">
      <ShieldAlert aria-hidden /> {PROVIDER_SHORT[status.provider]} · não oficial
    </Badge>
  );
}

export function StatusHero({ status, canManage, timezone }: { status: WaStatus; canManage: boolean; timezone?: string }) {
  const meta = CONNECTION_META[status.status];
  const Icon = meta.icon;
  const action = useConnectionAction();
  const settings = useUpdateWhatsAppSettings();
  const run = (a: ConnectionAction) => action.mutate(a);
  const busy = (a: ConnectionAction) => action.isPending && action.variables === a;
  const pending = status.pendingRequests;
  const waitingWorker = (pending.logout || pending.reconnect || pending.groupSync) && !status.worker.online;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl", TONE_SOFT_BG[meta.tone])}>
            <Icon className={cn("size-6", meta.spin && "animate-spin")} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status da conexão</p>
            <p className={cn("mt-0.5 text-xl font-semibold tracking-tight", TONE_TEXT[meta.tone])} role="status" aria-live="polite">
              {meta.label}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">{status.provider === "SIMULATOR"
                ? status.status === "CONNECTED"
                  ? "Simulação ativa — nenhuma conexão real com o WhatsApp."
                  : "Simulador: a aba Simulador funciona mesmo desconectado (sem worker, a própria API processa)."
                : meta.hint}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <ProviderBadge status={status} />
              {status.authorizedGroup ? (
                <Badge variant="muted" className="max-w-full">
                  <span className="truncate">Grupo: {status.authorizedGroup.name}</span>
                </Badge>
              ) : status.provider !== "CLOUD_API" ? (
                <Badge variant="warning">Nenhum grupo autorizado</Badge>
              ) : null}
            </div>
          </div>
        </div>

        {canManage && (
          <div className="flex flex-wrap gap-2 lg:justify-end">
            {!status.desiredConnected ? (
              <Button variant="brand" onClick={() => run("connect")} loading={busy("connect")}>
                <Plug /> Conectar
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => run("reconnect")} loading={busy("reconnect")}>
                  <RefreshCw /> Reconectar
                </Button>
                <Button variant="outline" onClick={() => run("disconnect")} loading={busy("disconnect")}>
                  <Unplug /> Desconectar
                </Button>
              </>
            )}
            {status.provider !== "CLOUD_API" && status.status !== "LOGGED_OUT" && (status.desiredConnected || status.lastConnectedAt) && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="text-destructive hover:text-destructive" loading={busy("logout")}>
                    <LogOut /> Encerrar sessão
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Encerrar a sessão do WhatsApp?</AlertDialogTitle>
                    <AlertDialogDescription>
                      O aparelho conectado será removido e as credenciais salvas serão apagadas. Para voltar a receber mensagens será preciso conectar de novo
                      {status.provider === "BAILEYS" ? " e ler um novo QR Code" : ""}. As mensagens e lançamentos já registrados não são afetados.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => run("logout")}>
                      Encerrar sessão
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 border-t bg-card px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <Fact icon={Phone} label="Número conectado">
          {status.provider === "SIMULATOR" ? (
            <span className="text-muted-foreground">Simulação (sem número real)</span>
          ) : status.phoneNumber ? (
            <span className="tabular">
              {formatPhone(status.phoneNumber)}
              {status.displayName && <span className="block truncate text-xs font-normal text-muted-foreground">{status.displayName}</span>}
            </span>
          ) : (
            <span className="text-muted-foreground">Nenhum</span>
          )}
        </Fact>
        <Fact icon={CalendarClock} label="Última conexão">
          {status.lastConnectedAt ? (
            <span>
              {formatDateTimeBR(status.lastConnectedAt, timezone)}
              <span className="block text-xs font-normal text-muted-foreground">{timeAgo(status.lastConnectedAt)}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Nunca conectado</span>
          )}
        </Fact>
        <Fact icon={Server} label="Worker (segundo plano)">
          {status.worker.online ? (
            <span className="inline-flex items-center gap-1.5 text-positive">
              <span className="size-2 rounded-full bg-positive" aria-hidden /> Online
              <span className="text-xs font-normal text-muted-foreground">· sinal {timeAgo(status.worker.lastHeartbeat)}</span>
            </span>
          ) : (
            <span>
              <span className="inline-flex items-center gap-1.5 text-warning">
                <Power className="size-3.5" aria-hidden /> Offline
              </span>
              <span className="block text-xs font-normal text-muted-foreground">
                Inicie com <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">pnpm worker</code>
              </span>
            </span>
          )}
        </Fact>
        <Fact icon={RefreshCw} label="Processamento das mensagens">
          <div className="flex items-center gap-2.5">
            {canManage ? (
              <Switch
                id="wa-processing"
                checked={status.processingEnabled}
                disabled={settings.isPending}
                onCheckedChange={(v) => settings.mutate({ processingEnabled: v })}
                aria-describedby="wa-processing-hint"
              />
            ) : null}
            <Label htmlFor="wa-processing" className={cn("text-sm", status.processingEnabled ? "text-positive" : "text-warning")}>
              {status.processingEnabled ? "Ativo" : "Pausado"}
            </Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <span id="wa-processing-hint" className="cursor-help text-xs font-normal text-muted-foreground underline decoration-dotted underline-offset-2">
                  o que é?
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Pausado: as mensagens do grupo continuam sendo guardadas, mas só são interpretadas (e viram lançamentos) quando o processamento for reativado.
              </TooltipContent>
            </Tooltip>
          </div>
        </Fact>
      </div>

      {(status.status === "ERROR" || status.status === "LOGGED_OUT") && status.lastError && (
        <div className="border-t bg-destructive/5 px-5 py-3 text-sm">
          <span className="font-medium text-destructive">Último erro{status.lastErrorAt ? ` (${formatDateTimeBR(status.lastErrorAt, timezone)})` : ""}: </span>
          <span className="text-muted-foreground">{status.lastError}</span>
        </div>
      )}
      {waitingWorker && (
        <div className="border-t bg-warning/8 px-5 py-3 text-sm text-warning">
          Há um pedido aguardando o worker ({[pending.logout && "encerrar sessão", pending.reconnect && "reconectar", pending.groupSync && "sincronizar grupos"].filter(Boolean).join(", ")}).
          Inicie o worker para concluir.
        </div>
      )}
    </Card>
  );
}
