"use client";

import { useState } from "react";
import { AlertCircle, CreditCard, Landmark, Plus, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { formatBRL, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useAccounts, useCards } from "@/features/finance/hooks";
import type { BankItemDTO, BankLinkDTO, OpenFinanceStatusDTO } from "./open-finance-types";
import { useAddBankItem, useRemoveBankItem, useUpdateBankLink } from "./use-open-finance";

const NONE = "__none__";

/** "15/10 14:32" no fuso da família. */
export function formatShortDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

const ITEM_STATUS: Record<string, { label: string; variant: "positive" | "info" | "warning" | "negative" }> = {
  UPDATED: { label: "Atualizado", variant: "positive" },
  UPDATING: { label: "Atualizando no Meu Pluggy", variant: "info" },
  OUTDATED: { label: "Desatualizado", variant: "warning" },
  WAITING_USER_INPUT: { label: "Aguardando você no Meu Pluggy", variant: "warning" },
  LOGIN_ERROR: { label: "Erro de acesso ao banco", variant: "negative" },
};

function ItemStatusBadge({ item }: { item: BankItemDTO }) {
  if (item.needsAttention) {
    return (
      <Badge variant="negative">
        <AlertCircle aria-hidden /> Precisa reconectar no Meu Pluggy
      </Badge>
    );
  }
  if (!item.status) return null;
  const meta = ITEM_STATUS[item.status];
  return <Badge variant={meta?.variant ?? "muted"}>{meta?.label ?? item.status}</Badge>;
}

/** Formulário "Adicionar banco" pelo ID da conexão (item) do Meu Pluggy. */
export function AddBankForm({ status }: { status: OpenFinanceStatusDTO }) {
  const add = useAddBankItem();
  const [itemId, setItemId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = status.items.length >= status.maxItems;
  const submit = () => {
    const v = itemId.trim();
    if (!v) {
      setError("Cole o ID da conexão do banco.");
      return;
    }
    setError(null);
    add.mutate(v, {
      onSuccess: () => setItemId(""),
      onError: (e) => setError(errorMessage(e)),
    });
  };
  const hint = full
    ? `Limite de ${status.maxItems} bancos do Meu Pluggy`
    : status.simulated
      ? "No simulador, o ID precisa começar com “simulado” (ex.: simulado-0000-banco)."
      : "O ID da conexão (item) aparece no painel da Pluggy depois de conectar o Meu Pluggy à sua aplicação.";
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Adicionar banco" htmlFor="of-item-id" error={error ?? undefined} hint={hint}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="of-item-id"
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value);
              if (error) setError(null);
            }}
            placeholder={status.simulated ? "simulado-0000-banco" : "ID da conexão (ex.: 6b2f…)"}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
            disabled={full}
            aria-invalid={Boolean(error)}
          />
          <Button type="submit" variant="outline" disabled={full} loading={add.isPending} className="sm:w-auto">
            <Plus /> Adicionar banco
          </Button>
        </div>
      </Field>
    </form>
  );
}

function LinkTargetSelect({ id, link, disabled, onChange }: { id: string; link: BankLinkDTO; disabled: boolean; onChange: (v: string | null) => void }) {
  const isBank = link.type === "BANK";
  const accounts = useAccounts();
  const cards = useCards();
  const list = (isBank ? accounts.data : cards.data) ?? [];
  const current = isBank ? link.account : link.creditCard;
  const value = current?.id ?? NONE;
  const missing = current && !list.some((i) => i.id === current.id);
  return (
    <Select value={value} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full sm:w-56">
        <SelectValue placeholder="Não ligar" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Não ligar</SelectItem>
        {missing && current && (
          <SelectItem value={current.id}>
            {current.name}
            {(isBank ? accounts.data : cards.data) ? (isBank ? " (arquivada)" : " (arquivado)") : ""}
          </SelectItem>
        )}
        {list.map((i) => (
          <SelectItem key={i.id} value={i.id}>
            {i.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LinkRow({ link }: { link: BankLinkDTO }) {
  const update = useUpdateBankLink();
  const isBank = link.type === "BANK";
  const Icon = isBank ? Landmark : CreditCard;
  const linked = isBank ? Boolean(link.account) : Boolean(link.creditCard);
  const money = (c: number) => (link.currency === "BRL" ? formatBRL(c) : formatMoney(c, link.currency));
  const pending = update.isPending;
  return (
    <li className="grid gap-3 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", isBank ? "bg-info/10 text-info" : "bg-accent text-accent-foreground")} aria-hidden>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {link.name}
            {link.numberLast4 && <span className="ml-1.5 font-mono text-xs text-muted-foreground">••{link.numberLast4}</span>}
            <span className="sr-only">{isBank ? " (conta)" : " (cartão)"}</span>
          </p>
          {link.balanceCents !== null && (
            <p className="text-xs text-muted-foreground tabular">
              {isBank ? "Saldo no banco" : "Fatura atual no banco"}: {money(link.balanceCents)}
            </p>
          )}
          {!linked && <p className="mt-0.5 text-xs text-warning">Ligue a {isBank ? "uma conta" : "um cartão"} do app para começar a trazer lançamentos</p>}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="grid gap-1">
          <Label htmlFor={`of-link-${link.id}`} className="text-xs text-muted-foreground">
            Ligar a
          </Label>
          <LinkTargetSelect
            id={`of-link-${link.id}`}
            link={link}
            disabled={pending}
            onChange={(v) => update.mutate(isBank ? { id: link.id, accountId: v } : { id: link.id, creditCardId: v })}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`of-enabled-${link.id}`}
            checked={link.enabled}
            disabled={pending}
            onCheckedChange={(enabled) => update.mutate({ id: link.id, enabled })}
          />
          <Label htmlFor={`of-enabled-${link.id}`} className="text-sm">
            Buscar lançamentos
          </Label>
        </div>
      </div>
    </li>
  );
}

function BankItemCard({ item, timeZone }: { item: BankItemDTO; timeZone?: string }) {
  const remove = useRemoveBankItem();
  const [confirm, setConfirm] = useState(false);
  const name = item.institutionName || "Banco";
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">{name}</h4>
            <ItemStatusBadge item={item} />
          </div>
          <p className="text-xs text-muted-foreground">
            {item.providerUpdatedAt ? `Dados do banco de ${formatShortDateTime(item.providerUpdatedAt, timeZone)}` : "Dados do banco ainda não atualizados"}
            {" · "}
            {item.lastSyncAt ? `Última busca: ${formatShortDateTime(item.lastSyncAt, timeZone)}` : "Ainda não buscou"}
          </p>
          {item.lastError && (
            <p role="status" className="flex items-start gap-1.5 text-xs font-medium text-negative">
              <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden /> {item.lastError}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirm(true)} loading={remove.isPending}>
          <Trash2 /> Remover
        </Button>
      </div>
      {item.accounts.length ? (
        <ul className="mt-2 divide-y">
          {item.accounts.map((l) => (
            <LinkRow key={l.id} link={l} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Nenhuma conta ou cartão encontrado neste banco.</p>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              As contas e cartões deste banco deixam de ser buscados e as ligações com o app são apagadas. Os lançamentos já importados continuam no app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => remove.mutate(item.id)}>
              Remover banco
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

export function BankList({ status, timeZone }: { status: OpenFinanceStatusDTO; timeZone?: string }) {
  if (!status.items.length) {
    return <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">Nenhum banco adicionado ainda.</p>;
  }
  return (
    <ul className="grid gap-3">
      {status.items.map((it) => (
        <BankItemCard key={it.id} item={it} timeZone={timeZone} />
      ))}
    </ul>
  );
}
