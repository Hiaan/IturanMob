"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, Megaphone, RefreshCw, Server, ShieldCheck, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import { useMe } from "@/features/me/use-me";

interface PlatformStatus {
  version: { installed: string | null; available: string | null; upToDate: boolean };
  autoUpdate: { enabled: boolean; window: string | null; lastSeenAt: string | null; online: boolean; pendingRequestAt: string | null };
  health: {
    households: number;
    whatsapp: Record<string, number>;
    aiConfigured: boolean;
    lastBackup: { at: string; status: string } | null;
    offsiteBackup: boolean | null;
    diskFreeGb: number | null;
    memAvailableMb: number | null;
  };
  updates: Array<{ id: string; status: "OK" | "ROLLED_BACK" | "ROLLBACK_FAILED"; version: string | null; message: string; at: string }>;
}

interface AnnounceResult {
  sent: boolean;
  households: number;
  willReceive: number;
  alreadySent: number;
  optedOut: number;
  noWhatsApp: number;
  failed: number;
}

const UPDATE_STATUS = {
  OK: { label: "Atualizado", variant: "positive", icon: CheckCircle2 },
  ROLLED_BACK: { label: "Desfeita", variant: "warning", icon: Undo2 },
  ROLLBACK_FAILED: { label: "Problema", variant: "negative", icon: AlertTriangle },
} as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

export function AdminView() {
  const me = useMe();
  const isAdmin = Boolean(me.data?.instanceAdmin);
  const status = useQuery({
    queryKey: qk.instanceStatus,
    queryFn: () => api.get<PlatformStatus>("/api/v1/instance/status"),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  if (me.data && !isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Administração" />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">Só o administrador desta instalação acessa esta página.</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Administração" description="Atualizações, saúde do sistema e avisos para as famílias, sem precisar do computador." />
      {!status.data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <UpdatesCard data={status.data} />
            <HealthCard data={status.data} />
          </div>
          <HistoryCard data={status.data} />
        </>
      )}
      {status.isError && <p className="text-sm text-destructive">{errorMessage(status.error)}</p>}
      {isAdmin && <AnnouncementCard />}
    </div>
  );
}

function UpdatesCard({ data }: { data: PlatformStatus }) {
  const qc = useQueryClient();
  const { version, autoUpdate } = data;
  const request = useMutation({
    mutationFn: () => api.post<{ requestedAt: string; alreadyPending: boolean }>("/api/v1/instance/update", {}),
    onSuccess: (r) => {
      toast.success(r.alreadyPending ? "Já existe um pedido de atualização na fila." : "Pedido enviado: o servidor atualiza em até 5 minutos e avisa aqui.");
      void qc.invalidateQueries({ queryKey: qk.instanceStatus });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canUpdate = autoUpdate.enabled && autoUpdate.online && !version.upToDate && !autoUpdate.pendingRequestAt;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="size-4" aria-hidden /> Atualizações
        </CardTitle>
        <CardDescription>
          {autoUpdate.enabled
            ? `O servidor instala sozinho as versões testadas${autoUpdate.window ? `, todo dia às ${autoUpdate.window}` : ""}. Se algo der errado, volta sozinho para a versão anterior.`
            : "A atualização automática ainda não foi ligada no servidor."}
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        <Row label="Versão instalada">{version.installed ?? "—"}</Row>
        <Row label="Versão disponível">
          {version.available ?? "—"} {version.upToDate && <Badge variant="positive">em dia</Badge>}
        </Row>
        <Row label="Atualização automática">
          {autoUpdate.enabled ? (
            autoUpdate.online ? (
              <Badge variant="positive">ligada</Badge>
            ) : (
              <Badge variant="warning">sem sinal do servidor</Badge>
            )
          ) : (
            <Badge variant="muted">desligada</Badge>
          )}
        </Row>
        <Row label="Último sinal do servidor">{autoUpdate.lastSeenAt ? formatDateTimeBR(autoUpdate.lastSeenAt) : "—"}</Row>
        <div className="pt-4">
          {autoUpdate.pendingRequestAt ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="size-4" aria-hidden /> Atualização pedida às {formatDateTimeBR(autoUpdate.pendingRequestAt)}. O servidor atende em até 5 minutos.
            </p>
          ) : (
            <>
              <Button onClick={() => request.mutate()} disabled={!canUpdate || request.isPending}>
                <RefreshCw className="size-4" aria-hidden /> Atualizar agora
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                {version.upToDate
                  ? "Já está na versão mais nova."
                  : !autoUpdate.enabled
                    ? "Disponível depois que a atualização automática for ligada."
                    : !autoUpdate.online
                      ? "O servidor não está dando sinal agora."
                      : "Instala agora em vez de esperar a madrugada (o sistema fica fora do ar por alguns segundos)."}
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function HealthCard({ data }: { data: PlatformStatus }) {
  const h = data.health;
  const connected = h.whatsapp.CONNECTED ?? 0;
  const totalWa = Object.values(h.whatsapp).reduce((s, n) => s + n, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="size-4" aria-hidden /> Saúde do sistema
        </CardTitle>
        <CardDescription>Só números gerais: nenhum dado das famílias aparece aqui.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        <Row label="Famílias cadastradas">{h.households}</Row>
        <Row label="WhatsApp conectado">
          {connected} de {totalWa} {totalWa > 0 && connected < totalWa && <Badge variant="warning">verificar</Badge>}
        </Row>
        <Row label="IA configurada">{h.aiConfigured ? <Badge variant="positive">sim</Badge> : <Badge variant="muted">não</Badge>}</Row>
        <Row label="Último backup">
          {h.lastBackup ? (
            <>
              {formatDateTimeBR(h.lastBackup.at)}{" "}
              {h.lastBackup.status === "FAILED" || h.lastBackup.status === "CORRUPTED" ? <Badge variant="negative">falhou</Badge> : <Badge variant="positive">ok</Badge>}
            </>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Cópia fora do servidor">
          {h.offsiteBackup === null ? "—" : h.offsiteBackup ? <Badge variant="positive">sim</Badge> : <Badge variant="warning">não configurada</Badge>}
        </Row>
        <Row label="Espaço livre em disco">
          {h.diskFreeGb === null ? "—" : `${h.diskFreeGb} GB`} {h.diskFreeGb !== null && h.diskFreeGb < 3 && <Badge variant="negative">pouco</Badge>}
        </Row>
        <Row label="Memória livre">{h.memAvailableMb === null ? "—" : `${(h.memAvailableMb / 1024).toFixed(1).replace(".", ",")} GB`}</Row>
      </CardContent>
    </Card>
  );
}

function HistoryCard({ data }: { data: PlatformStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" aria-hidden /> Histórico de atualizações
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!data.updates.length ? (
          <p className="text-sm text-muted-foreground">Nenhuma atualização automática ainda.</p>
        ) : (
          <ul className="divide-y">
            {data.updates.map((u) => {
              const s = UPDATE_STATUS[u.status] ?? UPDATE_STATUS.OK;
              return (
                <li key={u.id} className="flex items-start gap-3 py-3 text-sm">
                  <s.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{u.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTimeBR(u.at)}
                      {u.version && ` · versão ${u.version}`}
                    </p>
                  </div>
                  <Badge variant={s.variant}>{s.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AnnouncementCard() {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<AnnounceResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const valid = title.trim().length >= 3 && text.trim().length >= 10;

  const run = useMutation({
    mutationFn: (send: boolean) => api.post<AnnounceResult>("/api/v1/instance/announcements", { title, text, send }),
    onSuccess: (r) => {
      if (r.sent) {
        toast.success(r.willReceive ? `Aviso enviado para ${r.willReceive} ${r.willReceive === 1 ? "família" : "famílias"}.` : "Nenhuma família nova para receber este aviso.");
        setPreview(null);
        setTitle("");
        setText("");
      } else setPreview(r);
      setConfirming(false);
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      setConfirming(false);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="size-4" aria-hidden /> Aviso para as famílias
        </CardTitle>
        <CardDescription>
          Vai uma mensagem por família, no grupo de WhatsApp que ela autorizou, e também como notificação no app. O mesmo aviso nunca é enviado duas vezes para a mesma família. Quem desligou os avisos do
          sistema recebe só no app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Título (aparece no app)" htmlFor="announce-title">
          <Input
            id="announce-title"
            value={title}
            maxLength={120}
            onChange={(e) => {
              setTitle(e.target.value);
              setPreview(null);
            }}
            placeholder="Novidades no T9 Finance"
          />
        </Field>
        <Field label="Mensagem" htmlFor="announce-text" hint="No WhatsApp, *palavra* fica em negrito.">
          <Textarea
            id="announce-text"
            value={text}
            maxLength={3500}
            rows={8}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
          />
        </Field>
        {preview && (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm" role="status">
            <p className="font-medium">
              {preview.willReceive} de {preview.households} {preview.households === 1 ? "família recebe" : "famílias recebem"} no WhatsApp.
            </p>
            <p className="mt-1 text-muted-foreground">
              {[
                preview.alreadySent && `${preview.alreadySent} já recebeu`,
                preview.optedOut && `${preview.optedOut} só no app (avisos desligados)`,
                preview.noWhatsApp && `${preview.noWhatsApp} sem WhatsApp conectado`,
              ]
                .filter(Boolean)
                .join(" · ") || "Nenhuma exceção."}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!valid || run.isPending} onClick={() => run.mutate(false)}>
            Ver quem recebe
          </Button>
          <Button disabled={!valid || !preview || run.isPending} onClick={() => setConfirming(true)}>
            <Megaphone className="size-4" aria-hidden /> Enviar
          </Button>
        </div>
        {!preview && valid && <p className="text-xs text-muted-foreground">Veja quem recebe antes de enviar.</p>}
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enviar o aviso agora?</AlertDialogTitle>
            <AlertDialogDescription>Depois de enviado, não dá para apagar a mensagem do WhatsApp das famílias.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button onClick={() => run.mutate(true)} disabled={run.isPending}>
              Enviar
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
