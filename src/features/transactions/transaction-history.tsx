"use client";

import { ArchiveRestore, CheckCircle2, CirclePlus, FileUp, PencilLine, Tags, Trash2, XCircle, type LucideIcon } from "lucide-react";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDateTimeBR } from "@/lib/dates";
import { OWNERSHIP_LABELS, PAYMENT_METHOD_LABELS, TRANSACTION_STATUS_LABELS, TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import { useAccounts, useCards, useCategories, useMembers } from "@/features/finance/hooks";
import type { AuditEntry } from "./use-transaction-actions";

const ACTIONS: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  CREATE: { label: "Criado", icon: CirclePlus, tone: "text-brand" },
  UPDATE: { label: "Editado", icon: PencilLine, tone: "text-info" },
  DELETE: { label: "Excluído (lixeira)", icon: Trash2, tone: "text-destructive" },
  REJECT: { label: "Rejeitado", icon: XCircle, tone: "text-destructive" },
  RESTORE: { label: "Restaurado", icon: ArchiveRestore, tone: "text-positive" },
  RECLASSIFY: { label: "Reclassificado", icon: Tags, tone: "text-info" },
  CONFIRM: { label: "Confirmado", icon: CheckCircle2, tone: "text-positive" },
  IMPORT: { label: "Importado", icon: FileUp, tone: "text-muted-foreground" },
};

const ACTOR_TYPES: Record<string, string> = {
  USER: "Usuário",
  AI: "Assistente IA",
  SYSTEM: "Sistema",
  WHATSAPP: "WhatsApp",
  IMPORT: "Importação",
};

const FIELD_LABELS: Record<string, string> = {
  type: "Tipo",
  status: "Situação",
  amountCents: "Valor",
  description: "Descrição",
  notes: "Observações",
  date: "Data",
  competenceDate: "Competência",
  categoryId: "Categoria",
  subcategoryId: "Subcategoria",
  merchantId: "Estabelecimento",
  paymentMethod: "Forma de pagamento",
  accountId: "Conta",
  destinationAccountId: "Conta de destino",
  creditCardId: "Cartão",
  statementId: "Fatura",
  installmentCount: "Parcelas",
  payerMemberId: "Quem pagou",
  ownership: "Responsabilidade",
  responsibleMemberId: "Responsável",
  allocations: "Rateio",
  deletedAt: "Exclusão",
  goalId: "Meta",
};

export function TransactionHistory({ history, timezone }: { history: AuditEntry[]; timezone?: string }) {
  const members = useMembers();
  const categories = useCategories({ includeArchived: true });
  const accounts = useAccounts({ includeArchived: true });
  const cards = useCards({ includeArchived: true });

  const memberName = (id: unknown) => (typeof id === "string" ? members.data?.find((m) => m.id === id)?.displayName ?? "pessoa removida" : "—");
  const fmt = (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    switch (field) {
      case "amountCents":
        return formatBRL(Number(v));
      case "date":
      case "competenceDate":
        return formatDateBR(String(v));
      case "type":
        return labelOf(TRANSACTION_TYPE_LABELS, String(v));
      case "status":
        return labelOf(TRANSACTION_STATUS_LABELS, String(v));
      case "paymentMethod":
        return labelOf(PAYMENT_METHOD_LABELS, String(v));
      case "ownership":
        return labelOf(OWNERSHIP_LABELS, String(v));
      case "categoryId":
        return categories.data?.find((c) => c.id === v)?.name ?? "categoria removida";
      case "subcategoryId":
        return categories.data?.flatMap((c) => c.subcategories).find((s) => s.id === v)?.name ?? "subcategoria removida";
      case "accountId":
      case "destinationAccountId":
        return accounts.data?.find((a) => a.id === v)?.name ?? "conta";
      case "creditCardId":
        return cards.data?.find((c) => c.id === v)?.name ?? "cartão";
      case "payerMemberId":
      case "responsibleMemberId":
        return memberName(v);
      case "allocations":
        return Array.isArray(v) && v.length ? (v as Array<{ memberId: string; amountCents: number }>).map((a) => `${memberName(a.memberId)} ${formatBRL(a.amountCents)}`).join(", ") : "sem rateio";
      case "deletedAt":
        return formatDateTimeBR(String(v), timezone);
      case "merchantId":
      case "statementId":
      case "goalId":
        return "alterado";
      default:
        return String(v);
    }
  };

  if (!history.length) return <p className="text-sm text-muted-foreground">Nenhum registro de alteração.</p>;
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {history.map((h) => {
        const meta = ACTIONS[h.action] ?? { label: h.action, icon: PencilLine, tone: "text-muted-foreground" };
        const Icon = meta.icon;
        const author = h.actorMemberId ? memberName(h.actorMemberId) : ACTOR_TYPES[h.actorType] ?? h.actorType;
        const via = h.actorMemberId && h.actorType !== "USER" ? ` via ${ACTOR_TYPES[h.actorType] ?? h.actorType}` : "";
        const changes = Object.entries(h.metadata?.changes ?? {}).filter(([k]) => k !== "deletedAt" && FIELD_LABELS[k]);
        return (
          <li key={h.id} className="relative">
            <span className={`absolute -left-[29px] top-0 flex size-4 items-center justify-center rounded-full bg-card ${meta.tone}`} aria-hidden>
              <Icon className="size-4" />
            </span>
            <p className="text-sm font-medium">
              {meta.label}
              <span className="font-normal text-muted-foreground"> · {author}{via}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              <time dateTime={h.createdAt}>{formatDateTimeBR(h.createdAt, timezone)}</time>
              {h.source && ` · ${h.source}`}
            </p>
            {changes.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                {changes.map(([k, c]) => (
                  <li key={k} className="break-words">
                    <span className="font-medium">{FIELD_LABELS[k]}:</span> <span className="text-muted-foreground line-through decoration-muted-foreground/50">{fmt(k, c.from)}</span> → {fmt(k, c.to)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
