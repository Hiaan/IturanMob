"use client";

import Link from "next/link";
import { ArrowUpRight, Briefcase, Paperclip, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { WaMessage } from "./types";
import { MESSAGE_TYPE_META } from "./status-meta";
import { GROUP_NATURE_LABELS } from "./hooks";

/** Selo pequeno com o grupo de origem (quando a família tem mais de um grupo autorizado). */
export function GroupBadge({ group, className }: { group: WaMessage["group"]; className?: string }) {
  if (!group) return null;
  const business = group.defaultNature === "BUSINESS";
  return (
    <Badge variant="muted" className={cn("max-w-full", business && "bg-series-7/12 text-series-7", className)} title={`Grupo “${group.name}” · natureza ${GROUP_NATURE_LABELS[group.defaultNature ?? "NONE"]}`}>
      {business ? <Briefcase aria-hidden /> : <Users aria-hidden />}
      <span className="truncate">{group.name}</span>
    </Badge>
  );
}

/** Lista "“A”, “B” e “C”". */
export function groupNames(names: string[]): string {
  const q = names.map((n) => `“${n}”`);
  return q.length <= 1 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} e ${q[q.length - 1]}`;
}

/** Lançamentos gerados pela mensagem, com link para o detalhe em Transações. */
export function TransactionChips({ message, className }: { message: WaMessage; className?: string }) {
  if (!message.transactions.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {message.transactions.map((t) => (
        <Link
          key={t.id}
          href={`/transacoes?id=${t.id}`}
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-xs shadow-xs transition hover:border-ring/50",
            t.deleted && "opacity-60",
          )}
          title={t.deleted ? "Lançamento excluído" : "Abrir lançamento"}
        >
          <span className="text-muted-foreground">{labelOf(TRANSACTION_TYPE_LABELS, t.type)}</span>
          <span className={cn("font-semibold tabular", t.deleted && "line-through")}>{formatBRL(t.amountCents)}</span>
          <span className="truncate">{t.description}</span>
          <span className="text-muted-foreground">{formatDateBR(t.date)}</span>
          {t.status === "PENDING" && <span className="text-warning">· a confirmar</span>}
          {t.deleted && <span className="text-muted-foreground">(excluído)</span>}
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
      ))}
    </div>
  );
}

/** Texto/legenda da mensagem (ou descrição da mídia quando não há texto). */
export function messageText(m: WaMessage): string {
  if (m.text?.trim()) return m.text;
  const label = MESSAGE_TYPE_META[m.type].label.toLowerCase();
  return m.type === "TEXT" ? "(mensagem vazia)" : `(${label} sem legenda)`;
}

export function AttachmentLink({ message }: { message: WaMessage }) {
  const a = message.attachment;
  if (!a) return null;
  if (a.contentDeleted) return <span className="text-xs text-muted-foreground">Arquivo original apagado pela política de retenção</span>;
  return (
    <a href={`/api/v1/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
      <Paperclip className="size-3" aria-hidden /> Abrir anexo
    </a>
  );
}
