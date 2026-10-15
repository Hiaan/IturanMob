"use client";

import { useState } from "react";
import { FlaskConical, Info, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/shared/empty-state";
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
import { buttonVariants } from "@/components/ui/button";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useAuthorizeGroup, useSyncGroups } from "./hooks";
import type { WaGroup, WaStatus } from "./types";

export function GroupsPanel({ status, canManage, timezone }: { status: WaStatus; canManage: boolean; timezone?: string }) {
  const sync = useSyncGroups();
  const authorize = useAuthorizeGroup();
  const [confirm, setConfirm] = useState<{ group: WaGroup; authorized: boolean } | null>(null);
  const current = status.authorizedGroup;
  const groups = [...status.groups].sort((a, b) => Number(b.isAuthorized) - Number(a.isAuthorized) || a.name.localeCompare(b.name, "pt-BR"));

  if (!status.capabilities.groups) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chat autorizado</CardTitle>
          <CardDescription>Na API oficial não há grupos: cada membro autorizado conversa diretamente com o número comercial.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            Somente as conversas de membros autorizados e com consentimento são processadas. Mensagens de qualquer outra pessoa são descartadas sem serem armazenadas.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle>Grupo autorizado</CardTitle>
          <CardDescription className="mt-1">
            Somente o grupo autorizado é processado. Mensagens de outras conversas não são lidas nem armazenadas.
          </CardDescription>
        </div>
        {canManage && (
          <CardAction className="mt-2 sm:mt-0">
            <Button variant="outline" size="sm" onClick={() => sync.mutate()} loading={sync.isPending}>
              <RefreshCw /> Sincronizar grupos
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {groups.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nenhum grupo sincronizado"
            description={
              status.provider === "SIMULATOR"
                ? "Clique em “Sincronizar grupos” para criar o grupo simulado e depois autorize-o."
                : status.status === "CONNECTED"
                  ? "Clique em “Sincronizar grupos” para listar os grupos do número conectado."
                  : "Conecte o WhatsApp: os grupos são sincronizados automaticamente após a conexão."
            }
            className="py-8"
          />
        ) : (
          <ul className="divide-y rounded-xl border">
            {groups.map((g) => (
              <li key={g.id} className={cn("flex items-center gap-3 p-3.5", g.isAuthorized && "bg-accent/40")}>
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full",
                    g.isAuthorized ? "bg-positive/12 text-positive" : "bg-muted text-muted-foreground",
                  )}
                >
                  {g.isSimulator ? <FlaskConical className="size-4" aria-hidden /> : <Users className="size-4" aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{g.name}</span>
                    {g.isAuthorized && (
                      <Badge variant="positive">
                        <ShieldCheck aria-hidden /> Autorizado
                      </Badge>
                    )}
                    {g.isSimulator && <Badge variant="info">Simulado</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {g.participantsCount} participante{g.participantsCount === 1 ? "" : "s"} · sincronizado em {formatDateTimeBR(g.lastSyncedAt, timezone)}
                  </p>
                </div>
                {canManage ? (
                  <Switch
                    checked={g.isAuthorized}
                    disabled={authorize.isPending}
                    onCheckedChange={(v) => setConfirm({ group: g, authorized: v })}
                    aria-label={g.isAuthorized ? `Revogar autorização do grupo ${g.name}` : `Autorizar o grupo ${g.name}`}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">{g.isAuthorized ? "Processado" : "Ignorado"}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!current && groups.length > 0 && (
          <p className="mt-3 flex items-start gap-2 text-sm text-warning">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> Nenhum grupo autorizado: nenhuma mensagem está sendo processada.
          </p>
        )}
      </CardContent>

      <AlertDialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.authorized ? `Autorizar “${confirm.group.name}”?` : `Revogar “${confirm?.group.name}”?`}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {confirm?.authorized ? (
                  <>
                    <p>
                      Somente este grupo será processado: as mensagens dos participantes autorizados (com consentimento) viram lançamentos e consultas, e o bot responde aqui.
                    </p>
                    {current && current.id !== confirm.group.id && (
                      <p className="font-medium text-warning">O grupo “{current.name}” deixará de ser processado.</p>
                    )}
                    <p>Mensagens de outras conversas não são lidas nem armazenadas.</p>
                  </>
                ) : (
                  <p>As mensagens deste grupo deixarão de ser processadas e o bot não responderá mais nele. O histórico já registrado é mantido.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.authorized ? undefined : buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (confirm) authorize.mutate({ id: confirm.group.id, authorized: confirm.authorized });
                setConfirm(null);
              }}
            >
              {confirm?.authorized ? "Autorizar grupo" : "Revogar autorização"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
