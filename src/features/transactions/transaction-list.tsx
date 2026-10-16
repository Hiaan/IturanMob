"use client";

import { useMemo } from "react";
import { Check, CheckCircle2, Eye, MoreHorizontal, Paperclip, RotateCcw, Trash2, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBRL, formatMoney } from "@/lib/money";
import { WEEKDAY_NAMES, formatDateBR, formatDateTimeBR, formatLongDateBR, weekday } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS, labelOf } from "@/lib/labels";
import { capitalize, cn } from "@/lib/utils";
import type { CardDTO, TransactionDTO, TransactionNature } from "@/features/finance/types";
import { AmountText, ExcludedBadge, PendingBadge, SourceTag, TransactionIcon, categoryLabel, personLabel, whereLabel } from "./transaction-visuals";
import { currentInstallmentLabel } from "./installments";
import { canExcludeFromReports } from "./report-exclusion";
import { NATURES, NATURE_LABELS, natureOf } from "./nature";
import { NATURE_ICONS, NatureBadge, NatureQuickMenu, NatureReviewBadge } from "./nature-control";

/**
 * Natureza: personal/business (marca na hora) e exclude (Repasse: abre o diálogo de motivo/cliente,
 * também para editar); include: voltar a considerar.
 */
export type RowAction = "open" | "confirm" | "delete" | "restore" | "purge" | "exclude" | "include" | "personal" | "business";

/** Ação da linha para cada natureza (Repasse abre o diálogo). */
export const NATURE_ROW_ACTION: Record<TransactionNature, RowAction> = { PERSONAL: "personal", BUSINESS: "business", PASSTHROUGH: "exclude" };

/** Valor de lançamento desconsiderado: mais apagado, mas legível (continua no saldo). */
const excludedAmount = (tx: TransactionDTO) => (tx.excludedFromReports ? "text-muted-foreground" : undefined);

interface Group {
  key: string;
  label: string;
  items: TransactionDTO[];
  incomeCents: number;
  expenseCents: number;
}

function dayLabel(iso: string, today: string): string {
  const base = `${capitalize(WEEKDAY_NAMES[weekday(iso)] ?? "")}, ${formatLongDateBR(iso, iso.slice(0, 4) !== today.slice(0, 4))}`;
  return iso === today ? `Hoje · ${base}` : base;
}

function groupItems(items: TransactionDTO[], grouped: boolean, today: string): Group[] {
  if (!grouped) return [{ key: "all", label: "", items, incomeCents: 0, expenseCents: 0 }];
  const groups: Group[] = [];
  for (const tx of items) {
    let g = groups[groups.length - 1];
    if (!g || g.key !== tx.date) {
      g = { key: tx.date, label: dayLabel(tx.date, today), items: [], incomeCents: 0, expenseCents: 0 };
      groups.push(g);
    }
    g.items.push(tx);
    // Desconsiderados nos relatórios não entram nos totais do dia (como nos totais do topo).
    if (tx.status === "CONFIRMED" && !tx.deletedAt && !tx.excludedFromReports) {
      // Totais do dia em reais: moeda estrangeira pela PTAX da data (sem cotação ainda, fica de fora).
      const brl = !tx.currency || tx.currency === "BRL" ? tx.amountCents : (tx.amountBrlCents ?? 0);
      if (tx.type === "INCOME") g.incomeCents += brl;
      if (tx.type === "EXPENSE") g.expenseCents += brl;
    }
  }
  return groups;
}

function DayTotals({ g }: { g: Group }) {
  return (
    <span className="flex items-center gap-3 text-xs font-medium tabular">
      {g.incomeCents > 0 && <span className="text-positive">+{formatBRL(g.incomeCents)}</span>}
      {g.expenseCents > 0 && <span className="text-muted-foreground">−{formatBRL(g.expenseCents)}</span>}
    </span>
  );
}

function RowMenu({ tx, trash, onAction, canWrite, canDelete }: { tx: TransactionDTO; trash: boolean; onAction: (a: RowAction, tx: TransactionDTO) => void; canWrite: boolean; canDelete: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Ações para ${tx.description}`}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onAction("open", tx)}>
          <Eye /> Ver detalhes
        </DropdownMenuItem>
        {!trash && tx.status === "PENDING" && canWrite && (
          <DropdownMenuItem onSelect={() => onAction("confirm", tx)}>
            <CheckCircle2 /> Confirmar
          </DropdownMenuItem>
        )}
        {!trash && canWrite && canExcludeFromReports(tx) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{tx.natureReview ? "Escolher natureza (saldo e fatura não mudam)" : "Natureza (saldo e fatura não mudam)"}</DropdownMenuLabel>
            {NATURES.map((n) => {
              const Icon = NATURE_ICONS[n];
              const current = natureOf(tx) === n && !tx.natureReview;
              return (
                <DropdownMenuItem key={n} disabled={current && n !== "PASSTHROUGH"} onSelect={() => onAction(NATURE_ROW_ACTION[n], tx)}>
                  <Icon />
                  {n === "PASSTHROUGH" ? (tx.excludedFromReports ? "Editar repasse…" : "Marcar como Repasse…") : `Marcar como ${NATURE_LABELS[n]}`}
                  {current && (
                    <>
                      <Check className="ml-auto" aria-hidden />
                      <span className="sr-only"> (atual)</span>
                    </>
                  )}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
        {trash && canDelete && (
          <DropdownMenuItem onSelect={() => onAction("restore", tx)}>
            <RotateCcw /> Restaurar
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onAction(trash ? "purge" : "delete", tx)}>
              <Trash2 /> {trash ? "Excluir definitivamente" : "Excluir"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `onNature`: o selo "Escolher natureza" vira um menu rápido (só onde não está dentro de outro botão). */
function MetaBadges({ tx, cardsById, onNature }: { tx: TransactionDTO; cardsById: Map<string, CardDTO>; onNature?: (n: TransactionNature) => void }) {
  const inst = currentInstallmentLabel(tx, tx.creditCard ? cardsById.get(tx.creditCard.id) : undefined);
  const review = tx.natureReview && !tx.deletedAt;
  return (
    <>
      {tx.status === "PENDING" && <PendingBadge />}
      {review && (onNature ? <NatureQuickMenu onPick={onNature} /> : <NatureReviewBadge />)}
      <NatureBadge tx={tx} />
      <ExcludedBadge tx={tx} />
      {inst && (
        <Badge variant="info" title={inst.title}>
          <span className="sr-only">Parcela </span>
          {inst.label}
        </Badge>
      )}
      {tx.allocations.length > 1 && (
        <Badge variant="muted" title={tx.allocations.map((a) => `${a.displayName}: ${formatMoney(a.amountCents, tx.currency)}`).join(" · ")}>
          <Users aria-hidden /> Rateio
        </Badge>
      )}
      {tx.attachmentsCount > 0 && (
        <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" title={`${tx.attachmentsCount} anexo(s)`}>
          <Paperclip className="size-3.5" aria-hidden />
          <span className="sr-only">{tx.attachmentsCount} anexo(s)</span>
        </span>
      )}
    </>
  );
}

export function TransactionList({
  items,
  grouped,
  trash,
  today,
  selected,
  onToggle,
  onToggleAll,
  onAction,
  cards,
  canWrite,
  canDelete,
  accountId,
}: {
  items: TransactionDTO[];
  grouped: boolean;
  trash: boolean;
  today: string;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  onAction: (a: RowAction, tx: TransactionDTO) => void;
  cards: CardDTO[];
  canWrite: boolean;
  canDelete: boolean;
  accountId?: string;
}) {
  const groups = useMemo(() => groupItems(items, grouped, today), [items, grouped, today]);
  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const allSelected = items.length > 0 && items.every((t) => selected.has(t.id));
  const someSelected = items.some((t) => selected.has(t.id));
  const selectable = canWrite || canDelete;

  return (
    <>
      {/* Desktop: tabela */}
      <Card className="hidden overflow-hidden lg:block">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {selectable && (
                <TableHead className="w-12 pl-4">
                  <Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={(v) => onToggleAll(v === true)} aria-label="Selecionar todos desta página" />
                </TableHead>
              )}
              <TableHead>Lançamento</TableHead>
              <TableHead className="hidden w-[190px] xl:table-cell">Conta / cartão</TableHead>
              <TableHead className="hidden w-[160px] xl:table-cell">Pessoa</TableHead>
              <TableHead className="w-[150px] text-right">Valor</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Ações</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <GroupRows key={g.key} g={g} selectable={selectable}>
                {g.items.map((tx) => {
                  const person = personLabel(tx);
                  return (
                    <TableRow
                      key={tx.id}
                      data-state={selected.has(tx.id) ? "selected" : undefined}
                      className={cn("cursor-pointer", tx.status === "PENDING" && "bg-warning/[0.04]")}
                      onClick={() => onAction("open", tx)}
                    >
                      {selectable && (
                        <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={selected.has(tx.id)} onCheckedChange={() => onToggle(tx.id)} aria-label={`Selecionar ${tx.description}`} />
                        </TableCell>
                      )}
                      <TableCell className="py-2.5">
                        <div className="flex min-w-0 items-center gap-3">
                          <TransactionIcon tx={tx} />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <button
                                type="button"
                                className="truncate text-left font-medium outline-none hover:underline focus-visible:underline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onAction("open", tx);
                                }}
                              >
                                {tx.description}
                              </button>
                              <MetaBadges tx={tx} cardsById={cardsById} onNature={canWrite && !trash ? (n) => onAction(NATURE_ROW_ACTION[n], tx) : undefined} />
                            </div>
                            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="truncate">
                                {categoryLabel(tx)}
                                {tx.merchant && ` · ${tx.merchant.name}`}
                                {tx.paymentMethod && ` · ${labelOf(PAYMENT_METHOD_LABELS, tx.paymentMethod)}`}
                                {whereLabel(tx) && <span className="xl:hidden"> · {whereLabel(tx)}</span>}
                                {!grouped && ` · ${formatDateBR(tx.date)}`}
                                {trash && tx.deletedAt && ` · excluída em ${formatDateTimeBR(tx.deletedAt)}`}
                              </span>
                              <span aria-hidden>·</span>
                              <span className="shrink-0">
                                <SourceTag source={tx.source} />
                              </span>
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden truncate text-sm text-muted-foreground xl:table-cell">{whereLabel(tx) || "—"}</TableCell>
                      <TableCell className="hidden text-sm xl:table-cell">
                        <p className="truncate">{person.responsible}</p>
                        {person.payer && <p className="truncate text-xs text-muted-foreground">pago por {person.payer.split(" ")[0]}</p>}
                      </TableCell>
                      <TableCell className="text-right">
                        <AmountText tx={tx} accountId={accountId} className={excludedAmount(tx)} />
                      </TableCell>
                      <TableCell className="pr-3" onClick={(e) => e.stopPropagation()}>
                        <RowMenu tx={tx} trash={trash} onAction={onAction} canWrite={canWrite} canDelete={canDelete} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </GroupRows>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Mobile/tablet: cartões agrupados por dia */}
      <div className="space-y-4 lg:hidden">
        {selectable && items.length > 0 && (
          <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={(v) => onToggleAll(v === true)} aria-label="Selecionar todos desta página" />
            Selecionar todos desta página
          </label>
        )}
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label || "Lançamentos"}>
            {g.label && (
              <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                <h3 className="text-xs font-semibold text-muted-foreground">{g.label}</h3>
                <DayTotals g={g} />
              </div>
            )}
            <Card className="divide-y overflow-hidden">
              {g.items.map((tx) => (
                <div key={tx.id} className={cn("flex items-start gap-3 px-3 py-3", selected.has(tx.id) && "bg-muted", tx.status === "PENDING" && !selected.has(tx.id) && "bg-warning/[0.04]")}>
                  {selectable && (
                    <Checkbox className="mt-2.5" checked={selected.has(tx.id)} onCheckedChange={() => onToggle(tx.id)} aria-label={`Selecionar ${tx.description}`} />
                  )}
                  <div className="min-w-0 flex-1">
                    <button type="button" className="flex w-full min-w-0 items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg" onClick={() => onAction("open", tx)}>
                      <TransactionIcon tx={tx} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="truncate text-sm font-medium">{tx.description}</span>
                          <AmountText tx={tx} accountId={accountId} className={cn("text-sm", excludedAmount(tx))} />
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {categoryLabel(tx)}
                          {whereLabel(tx) && ` · ${whereLabel(tx)}`}
                          {!grouped && ` · ${formatDateBR(tx.date)}`}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <MetaBadges tx={tx} cardsById={cardsById} />
                          <SourceTag source={tx.source} />
                          <span className="text-xs text-muted-foreground">· {personLabel(tx).responsible}</span>
                        </span>
                        {trash && tx.deletedAt && <span className="mt-1 block text-xs text-muted-foreground">Excluída em {formatDateTimeBR(tx.deletedAt)}</span>}
                      </span>
                    </button>
                    {tx.natureReview && !tx.deletedAt && canWrite && !trash && <NatureQuickChoices tx={tx} onAction={onAction} />}
                  </div>
                </div>
              ))}
            </Card>
          </section>
        ))}
      </div>
    </>
  );
}

/** Celular: escolha da natureza fora do botão da linha (botões não podem ficar um dentro do outro). */
function NatureQuickChoices({ tx, onAction }: { tx: TransactionDTO; onAction: (a: RowAction, tx: TransactionDTO) => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:pl-12" role="group" aria-label={`Escolher natureza de ${tx.description}`}>
      <span className="text-xs text-muted-foreground">É:</span>
      {NATURES.map((n) => {
        const Icon = NATURE_ICONS[n];
        return (
          <button
            key={n}
            type="button"
            onClick={() => onAction(NATURE_ROW_ACTION[n], tx)}
            className="inline-flex h-7 items-center gap-1 rounded-full border bg-card px-2.5 text-xs font-medium outline-none transition hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <Icon className={cn("size-3.5", n === "BUSINESS" ? "text-series-7" : "text-muted-foreground")} aria-hidden />
            {n === "PASSTHROUGH" ? "Repasse…" : NATURE_LABELS[n]}
          </button>
        );
      })}
    </div>
  );
}

function GroupHeader({ g }: { g: Group }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-semibold text-muted-foreground">{g.label}</span>
      <span className="pr-14">
        <DayTotals g={g} />
      </span>
    </div>
  );
}

function GroupRows({ g, selectable, children }: { g: Group; selectable: boolean; children: React.ReactNode }) {
  return (
    <>
      {g.label && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          {/* Duas células: uma por faixa de largura (colunas Conta/Pessoa só aparecem a partir de xl). */}
          <TableCell colSpan={selectable ? 4 : 3} className="py-2 pl-4 xl:hidden">
            <GroupHeader g={g} />
          </TableCell>
          <TableCell colSpan={selectable ? 6 : 5} className="hidden py-2 pl-4 xl:table-cell">
            <GroupHeader g={g} />
          </TableCell>
        </TableRow>
      )}
      {children}
    </>
  );
}
