"use client";

import { useState } from "react";
import { Bot, MessagesSquare, RotateCcw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useReprocessMessage, useRetryFailed, useWhatsAppMessages } from "./hooks";
import { AttachmentLink, TransactionChips, messageText } from "./message-bits";
import { RichText } from "@/components/shared/rich-text";
import { MESSAGE_STATUS_META, MESSAGE_STATUS_ORDER, MESSAGE_TYPE_META, MessageStatusBadge, OutboundStatusBadge, TONE_SOFT_BG, intentLabel } from "./status-meta";
import type { WaMessage, WaMessageStatus, WaStatus } from "./types";

function StatsGrid({ status, active, onSelect }: { status: WaStatus; active: WaMessageStatus | "ALL"; onSelect: (s: WaMessageStatus | "ALL") => void }) {
  const stats = status.stats7d;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      <button
        type="button"
        onClick={() => onSelect("ALL")}
        aria-pressed={active === "ALL"}
        className={cn("rounded-xl border bg-card p-3 text-left shadow-card transition hover:border-ring/50", active === "ALL" && "ring-2 ring-ring/40")}
      >
        <p className="text-xs font-medium text-muted-foreground">Total recebidas</p>
        <p className="mt-1 text-2xl font-semibold tabular">{stats.total}</p>
      </button>
      {MESSAGE_STATUS_ORDER.map((s) => {
        const meta = MESSAGE_STATUS_META[s];
        const Icon = meta.icon;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onSelect(s)}
            aria-pressed={active === s}
            className={cn("rounded-xl border bg-card p-3 text-left shadow-card transition hover:border-ring/50", active === s && "ring-2 ring-ring/40")}
          >
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span className={cn("flex size-5 items-center justify-center rounded-md", TONE_SOFT_BG[meta.tone])}>
                <Icon className="size-3" aria-hidden />
              </span>
              <span className="line-clamp-2 leading-tight">{meta.label}</span>
            </p>
            <p className="mt-1 text-2xl font-semibold tabular">{stats.byStatus[s] ?? 0}</p>
          </button>
        );
      })}
    </div>
  );
}

function MessageRow({ m, canManage, timezone }: { m: WaMessage; canManage: boolean; timezone?: string }) {
  const reprocess = useReprocessMessage();
  const TypeIcon = m.isBot ? Bot : MESSAGE_TYPE_META[m.type].icon;
  const retrying = m.job && m.job.attempts > 0 && (m.status === "QUEUED" || m.status === "FAILED");
  const intent = m.isBot ? null : intentLabel(m.intent);
  // Para respostas do bot, o detalhe só interessa quando o envio não foi concluído.
  const detail = m.isBot && m.status === "PROCESSED" ? null : m.statusDetail;
  return (
    <li className="flex gap-3 p-4">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", m.isBot ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground")}>
        <TypeIcon className="size-4" aria-label={m.isBot ? "Resposta do bot" : MESSAGE_TYPE_META[m.type].label} />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{m.isBot ? "Finance AI (bot)" : (m.sender?.displayName ?? "Remetente")}</span>
          <span className="text-xs text-muted-foreground">
            {MESSAGE_TYPE_META[m.type].label} · {formatDateTimeBR(m.sentAt, timezone)}
          </span>
          {m.isBot ? <OutboundStatusBadge status={m.status} /> : <MessageStatusBadge status={m.status} />}
        </div>
        {m.isBot && m.text ? (
          <RichText text={m.text} className="space-y-0.5 break-words text-sm text-foreground/90" />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{messageText(m)}</p>
        )}
        {(intent || detail) && (
          <p className="break-words text-xs text-muted-foreground">
            {intent && <span className="font-medium text-foreground/70">{intent}</span>}
            {intent && detail && " · "}
            {detail}
          </p>
        )}
        {retrying && m.job && (
          <p className="text-xs text-warning">
            Tentativa {m.job.attempts} de {m.job.maxAttempts}
            {m.job.lastError ? ` — ${m.job.lastError}` : ""}
          </p>
        )}
        <TransactionChips message={m} />
        <div className="flex flex-wrap items-center gap-3">
          <AttachmentLink message={m} />
          {canManage && !m.isBot && (
            <Button size="sm" variant="outline" onClick={() => reprocess.mutate(m.id)} loading={reprocess.isPending} disabled={m.status === "PROCESSING"}>
              <RotateCcw /> Reprocessar
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

export function ProcessingPanel({ status, canManage, timezone }: { status: WaStatus; canManage: boolean; timezone?: string }) {
  const [filter, setFilter] = useState<WaMessageStatus | "ALL">("ALL");
  const messages = useWhatsAppMessages({ status: filter, limit: 30 });
  const retry = useRetryFailed();
  const items = messages.data?.pages.flatMap((p) => p.items) ?? [];
  const scope = messages.data?.pages[0]?.scope ?? null;

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">Mensagens recebidas nos últimos 7 dias, por status</p>
        <StatsGrid status={status} active={filter} onSelect={setFilter} />
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <CardTitle>Últimas mensagens</CardTitle>
            <CardDescription className="mt-1">
              {scope ? `Grupo “${scope.groupName}”.` : "Chat autorizado."} Mensagens recebidas e respostas do bot, com os lançamentos gerados.
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={filter} onValueChange={(v) => setFilter(v as WaMessageStatus | "ALL")}>
              <SelectTrigger className="h-9 sm:w-56" aria-label="Filtrar por status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os status</SelectItem>
                {MESSAGE_STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {MESSAGE_STATUS_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {canManage && (
              <Button size="sm" variant="outline" className="h-9" onClick={() => retry.mutate()} loading={retry.isPending}>
                <RotateCcw /> Reprocessar todas com falha
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {messages.isLoading ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : messages.isError ? (
            <div className="p-5">
              <ErrorState error={messages.error} onRetry={() => messages.refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={MessagesSquare}
                title={filter === "ALL" ? "Nenhuma mensagem ainda" : `Nenhuma mensagem “${MESSAGE_STATUS_META[filter].label}”`}
                description={
                  filter === "ALL"
                    ? status.provider === "SIMULATOR"
                      ? "Envie uma mensagem pela aba Simulador para ver o processamento aqui."
                      : "Quando alguém autorizado escrever no chat autorizado, as mensagens aparecerão aqui."
                    : "Tente outro filtro."
                }
              />
            </div>
          ) : (
            <>
              <ul className="divide-y border-t">
                {items.map((m) => (
                  <MessageRow key={m.id} m={m} canManage={canManage} timezone={timezone} />
                ))}
              </ul>
              {messages.hasNextPage && (
                <div className="border-t p-3 text-center">
                  <Button variant="ghost" size="sm" onClick={() => messages.fetchNextPage()} loading={messages.isFetchingNextPage}>
                    Carregar mais
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
