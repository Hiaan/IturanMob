import {
  ArrowLeftRight,
  Bot,
  CircleDashed,
  CreditCard,
  FileUp,
  Mic,
  MessageCircle,
  MessageSquareText,
  PenLine,
  ReceiptText,
  Repeat,
  Scale,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatBRL } from "@/lib/money";
import { TRANSACTION_SOURCE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { CategoryIcon } from "@/features/categories/category-icon";
import type { TransactionDTO } from "@/features/finance/types";

export const SOURCE_ICONS: Record<string, LucideIcon> = {
  MANUAL: PenLine,
  WHATSAPP_TEXT: MessageCircle,
  WHATSAPP_AUDIO: Mic,
  WHATSAPP_IMAGE: ReceiptText,
  DASHBOARD_CHAT: MessageSquareText,
  IMPORT: FileUp,
  RECURRING: Repeat,
  SYSTEM: Bot,
};

export const SOURCE_SHORT_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  WHATSAPP_TEXT: "WhatsApp",
  WHATSAPP_AUDIO: "Áudio",
  WHATSAPP_IMAGE: "Comprovante",
  DASHBOARD_CHAT: "Lançamento rápido",
  IMPORT: "Importação",
  RECURRING: "Recorrência",
  SYSTEM: "Automático",
};

/** Origem do lançamento (ícone + texto curto; o rótulo completo fica no title/aria). */
export function SourceTag({ source, compact }: { source: string; compact?: boolean }) {
  const Icon = SOURCE_ICONS[source] ?? PenLine;
  const label = labelOf(TRANSACTION_SOURCE_LABELS, source);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title={`Origem: ${label}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className={cn(compact && "sr-only")}>{SOURCE_SHORT_LABELS[source] ?? label}</span>
      {compact && <span className="sr-only">Origem: {label}</span>}
    </span>
  );
}

export function PendingBadge() {
  return (
    <Badge variant="warning" title="Aguardando confirmação — ainda não afeta saldos e relatórios">
      <CircleDashed aria-hidden /> Pendente
    </Badge>
  );
}

/** Direção do valor em relação ao saldo: +1 entrada, -1 saída, 0 neutro (transferência/pagamento de fatura). */
export function amountDirection(tx: Pick<TransactionDTO, "type" | "account" | "destinationAccount">, accountId?: string): -1 | 0 | 1 {
  switch (tx.type) {
    case "EXPENSE":
      return -1;
    case "INCOME":
      return 1;
    case "ADJUSTMENT":
      return tx.destinationAccount ? 1 : -1;
    case "TRANSFER":
      if (accountId && tx.destinationAccount?.id === accountId) return 1;
      if (accountId && tx.account?.id === accountId) return -1;
      return 0;
    case "CARD_PAYMENT":
      return accountId ? -1 : 0;
    default:
      return 0;
  }
}

export function AmountText({ tx, accountId, className }: { tx: Pick<TransactionDTO, "type" | "amountCents" | "account" | "destinationAccount">; accountId?: string; className?: string }) {
  const dir = amountDirection(tx, accountId);
  return (
    <span className={cn("whitespace-nowrap font-semibold tabular", dir > 0 && "text-positive", className)}>
      {dir < 0 ? "−" : dir > 0 ? "+" : ""}
      {formatBRL(tx.amountCents)}
    </span>
  );
}

/** Ícone principal da linha: categoria, ou um ícone neutro para transferências/pagamentos/ajustes. */
export function TransactionIcon({ tx, size = "md" }: { tx: Pick<TransactionDTO, "type" | "category">; size?: "sm" | "md" | "lg" }) {
  if (tx.category) return <CategoryIcon icon={tx.category.icon} color={tx.category.color} size={size} />;
  const Icon = tx.type === "TRANSFER" ? ArrowLeftRight : tx.type === "CARD_PAYMENT" ? CreditCard : tx.type === "ADJUSTMENT" ? Scale : CircleDashed;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground",
        size === "sm" && "size-7 rounded-lg [&_svg]:size-3.5",
        size === "md" && "size-9 [&_svg]:size-4",
        size === "lg" && "size-11 [&_svg]:size-5",
      )}
    >
      <Icon />
    </span>
  );
}

/** "Alimentação › Supermercado", ou o tipo quando não há categoria. */
export function categoryLabel(tx: Pick<TransactionDTO, "type" | "category" | "subcategory">): string {
  if (tx.category) return tx.subcategory ? `${tx.category.name} › ${tx.subcategory.name}` : tx.category.name;
  if (tx.type === "TRANSFER") return "Transferência";
  if (tx.type === "CARD_PAYMENT") return "Pagamento de fatura";
  if (tx.type === "ADJUSTMENT") return "Ajuste de saldo";
  return "Sem categoria";
}

/** Conta/cartão envolvidos, em texto curto. */
export function whereLabel(tx: Pick<TransactionDTO, "type" | "account" | "destinationAccount" | "creditCard">): string {
  if (tx.type === "TRANSFER") return `${tx.account?.name ?? "?"} → ${tx.destinationAccount?.name ?? "?"}`;
  if (tx.creditCard && tx.type !== "CARD_PAYMENT") return tx.creditCard.name;
  if (tx.type === "CARD_PAYMENT") return `${tx.account?.name ?? "Conta"} → ${tx.creditCard?.name ?? "Cartão"}`;
  return tx.account?.name ?? tx.destinationAccount?.name ?? "";
}

export function installmentLabel(tx: Pick<TransactionDTO, "installmentCount">): string | null {
  return tx.installmentCount > 1 ? `${tx.installmentCount}x` : null;
}

/** Pessoa principal: responsável individual, rateio ou família; e quem pagou. */
export function personLabel(tx: Pick<TransactionDTO, "ownership" | "responsible" | "allocations" | "payer" | "type">): { responsible: string; payer: string | null } {
  const responsible =
    tx.allocations.length > 1
      ? `Rateio (${tx.allocations.length})`
      : tx.ownership === "INDIVIDUAL"
        ? tx.responsible?.displayName ?? tx.allocations[0]?.displayName ?? "Individual"
        : "Família";
  return { responsible, payer: tx.payer?.displayName ?? null };
}
