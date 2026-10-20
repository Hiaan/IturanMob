"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ExternalLink, FlaskConical, KeyRound, Landmark, LockKeyhole, RefreshCw, Trash2 } from "lucide-react";
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
import { useCan, useMe } from "@/features/me/use-me";
import type { OpenFinanceStatusDTO } from "./open-finance-types";
import { AddBankForm, BankList, formatShortDateTime } from "./open-finance-banks";
import { useOpenFinanceStatus, useRemoveOpenFinance, useSaveOpenFinanceCredentials, useSyncOpenFinance, useUpdateOpenFinanceSettings } from "./use-open-finance";

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand underline-offset-4 hover:underline">
      {children}
      <ExternalLink className="size-3" aria-hidden />
      <span className="sr-only"> (abre em nova aba)</span>
    </a>
  );
}

function SimulatorBanner() {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <p className="font-semibold text-warning">SIMULADOR — dados de exemplo, nenhum banco real conectado</p>
    </div>
  );
}

function Guide({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border bg-muted/20">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        aria-expanded={open}
        aria-controls="of-guide"
        onClick={() => setOpen((v) => !v)}
      >
        Como conectar, passo a passo
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div id="of-guide" className="space-y-3 px-4 pb-4 text-sm">
          <ol className="list-decimal space-y-1.5 pl-5 text-foreground/85">
            <li>
              Crie sua conta grátis em <ExtLink href="https://meu.pluggy.ai">meu.pluggy.ai</ExtLink> e conecte seus bancos lá (até 5 bancos; os dados atualizam 1 vez por dia).
            </li>
            <li>
              Entre em <ExtLink href="https://dashboard.pluggy.ai">dashboard.pluggy.ai</ExtLink>, crie uma aplicação e copie o Client ID e o Client Secret.
            </li>
            <li>Cole aqui e salve.</li>
            <li>No painel da Pluggy, conecte o Meu Pluggy à sua aplicação (pelo botão de conectar/testar conexão) e copie o ID da conexão (item) de cada banco.</li>
            <li>Cole o ID aqui em “Adicionar banco” e ligue cada conta/cartão do banco à conta/cartão do app.</li>
          </ol>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li className="flex items-start gap-1.5">
              <LockKeyhole className="mt-px size-3.5 shrink-0" aria-hidden /> Só leitura: o app nunca movimenta dinheiro.
            </li>
            <li className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> Uso pessoal: o Meu Pluggy não pode ser usado para fins comerciais ou para outras pessoas.
            </li>
            <li className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> Os nomes dos botões no site da Pluggy podem mudar.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

function CredentialsForm({ status, onDone }: { status: OpenFinanceStatusDTO; onDone?: () => void }) {
  const save = useSaveOpenFinanceCredentials();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const hasSaved = status.configured && status.provider === "PLUGGY";

  const submit = () => {
    setError(null);
    setSimError(null);
    save.mutate(
      { provider: "PLUGGY", ...(clientId.trim() ? { clientId: clientId.trim() } : {}), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) },
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
  const startSimulator = () => {
    setError(null);
    setSimError(null);
    save.mutate({ provider: "SIMULATOR" }, { onSuccess: () => onDone?.(), onError: (e) => setSimError(errorMessage(e)) });
  };
  const pendingProvider = save.isPending ? save.variables?.provider : null;

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
        <KeyRound className="size-4 text-muted-foreground" aria-hidden /> Credenciais da aplicação na Pluggy
      </p>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field label="Client ID" htmlFor="of-client-id" hint={status.clientIdHint ? `Client ID salvo: ${status.clientIdHint}` : undefined}>
          <Input
            id="of-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
            placeholder={status.clientIdHint ? `Deixe vazio para manter (${status.clientIdHint})` : "Cole o Client ID"}
          />
        </Field>
        <Field label="Client Secret" htmlFor="of-client-secret" hint={hasSaved ? "Deixe vazio para manter o salvo." : undefined}>
          <Input
            id="of-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono text-sm"
            placeholder={hasSaved ? "•••••••• (salvo)" : "Cole o Client Secret"}
          />
        </Field>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="brand" loading={pendingProvider === "PLUGGY"} disabled={save.isPending}>
          Salvar e conferir
        </Button>
        {onDone && (
          <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
            Cancelar
          </Button>
        )}
        {status.simulatorAvailable && !status.simulated && (
          <Button type="button" variant="ghost" onClick={startSimulator} loading={pendingProvider === "SIMULATOR"} disabled={save.isPending}>
            <FlaskConical /> Usar simulador (dados de exemplo)
          </Button>
        )}
      </div>
      {simError && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {simError}
        </p>
      )}
      <p className="text-xs text-muted-foreground">Antes de salvar, o app confere as credenciais com a Pluggy. O Client Secret fica guardado com criptografia e não volta para a tela.</p>
    </form>
  );
}

function InitialDaysInput({ value }: { value: number }) {
  const update = useUpdateOpenFinanceSettings();
  const [draft, setDraft] = useState(String(value));
  const [synced, setSynced] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // Acompanha o valor salvo quando ele muda por fora (ex.: outra aba).
  if (synced !== value) {
    setSynced(value);
    setDraft(String(value));
  }
  const commit = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      setError("Use um número de 1 a 365.");
      return;
    }
    setError(null);
    if (n !== value) update.mutate({ initialDays: n }, { onError: () => setDraft(String(value)) });
  };
  return (
    <Field label="Dias na primeira busca" htmlFor="of-initial-days" error={error ?? undefined} hint="Quantos dias para trás buscar quando uma conta ou cartão é ligado pela primeira vez (1 a 365).">
      <Input
        id="of-initial-days"
        type="number"
        inputMode="numeric"
        min={1}
        max={365}
        className="w-28"
        value={draft}
        disabled={update.isPending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        aria-invalid={Boolean(error)}
      />
    </Field>
  );
}

function Settings({ status }: { status: OpenFinanceStatusDTO }) {
  const update = useUpdateOpenFinanceSettings();
  return (
    <div className="grid items-start gap-4 rounded-xl border p-4 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Switch id="of-auto-import" checked={status.autoImport} disabled={update.isPending} onCheckedChange={(autoImport) => update.mutate({ autoImport })} />
          <Label htmlFor="of-auto-import" className="text-sm">
            Importar direto (sem conferir)
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Desligado: os lançamentos viram uma prévia em Importação para você conferir. Ligado: entram direto; duplicados e já registrados ficam de fora.
        </p>
      </div>
      <InitialDaysInput value={status.initialDays} />
    </div>
  );
}

function Configured({ status, timeZone }: { status: OpenFinanceStatusDTO; timeZone?: string }) {
  const sync = useSyncOpenFinance();
  const remove = useRemoveOpenFinance();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const canSync = status.items.some((it) => it.accounts.some((l) => l.enabled && (l.account || l.creditCard)));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5 text-sm">
          <p>
            <span className="text-muted-foreground">Última busca:</span>{" "}
            <span className="font-medium">{status.lastSyncAt ? formatShortDateTime(status.lastSyncAt, timeZone) : "Ainda não buscou"}</span>
          </p>
          {status.provider === "PLUGGY" && status.clientIdHint && <p className="text-xs text-muted-foreground">Client ID salvo: {status.clientIdHint}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="brand" size="sm" onClick={() => sync.mutate()} loading={sync.isPending} disabled={!status.items.length}>
            <RefreshCw /> Buscar agora
          </Button>
          {!status.simulated && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <KeyRound /> Alterar credenciais
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirm(true)} loading={remove.isPending}>
            <Trash2 /> Remover conexão
          </Button>
        </div>
      </div>
      {status.items.length > 0 && !canSync && <p className="text-xs text-muted-foreground">Ligue ao menos uma conta ou cartão do banco a uma conta ou cartão do app para a busca trazer lançamentos.</p>}
      {status.lastError && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {status.lastError}
        </p>
      )}
      {editing && <CredentialsForm status={status} onDone={() => setEditing(false)} />}
      <Settings status={status} />
      <AddBankForm status={status} />
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          Bancos{" "}
          <span className="font-normal text-muted-foreground">
            ({status.items.length} de {status.maxItems})
          </span>
        </h3>
        <BankList status={status} timeZone={timeZone} />
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover a conexão com os bancos?</AlertDialogTitle>
            <AlertDialogDescription>
              As credenciais, os bancos adicionados e as ligações com contas e cartões serão apagados, e o app para de buscar lançamentos. Os lançamentos já importados continuam
              no app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => remove.mutate()}>
              Remover conexão
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Body({ timeZone }: { timeZone?: string }) {
  const q = useOpenFinanceStatus();
  const d = q.data;
  if (q.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (q.isError || !d) return <ErrorState error={q.error} compact onRetry={() => q.refetch()} />;
  return (
    <div className="space-y-4">
      {d.simulated && <SimulatorBanner />}
      {d.configured ? (
        <>
          <Configured status={d} timeZone={timeZone} />
          {!d.simulated && <Guide defaultOpen={false} />}
        </>
      ) : (
        <>
          <Guide defaultOpen />
          <CredentialsForm status={d} />
        </>
      )}
    </div>
  );
}

/** Integração com os bancos (Open Finance pelo Meu Pluggy): credenciais, bancos, ligações e busca. */
export function OpenFinanceCard() {
  const me = useMe();
  const canManage = useCan("integrations:manage");
  const q = useOpenFinanceStatus(canManage);
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-info/12 text-info">
          <Landmark className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Bancos (Open Finance)</h2>
            {q.data?.simulated && (
              <Badge variant="warning">
                <FlaskConical aria-hidden /> SIMULADOR
              </Badge>
            )}
            {q.data?.configured && !q.data.simulated && <Badge variant="positive">Conectado</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">Traz os lançamentos das suas contas e cartões automaticamente, pelo Meu Pluggy (gratuito para uso pessoal).</p>
        </div>
      </div>
      <div className="mt-4">
        {me.isError ? (
          <ErrorState error={me.error} compact onRetry={() => me.refetch()} />
        ) : !me.data ? (
          <Skeleton className="h-6 w-48" />
        ) : canManage ? (
          <Body timeZone={me.data.household.timezone} />
        ) : (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden /> Só quem gerencia as integrações da família pode configurar a conexão com os bancos.
          </p>
        )}
      </div>
    </Card>
  );
}
