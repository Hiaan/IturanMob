"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, Banknote, CalendarClock, CreditCard, List, MoreHorizontal, PencilLine, Plus, Receipt, Trash2, Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDayMonthBR, formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCards } from "@/features/finance/hooks";
import { useCan } from "@/features/me/use-me";
import type { CardDTO, StatementDTO } from "@/features/finance/types";
import { CreditCardVisual } from "./credit-card-visual";
import { CardFormDialog } from "./card-form-dialog";
import { PayStatementDialog, type PayTarget } from "./pay-statement-dialog";
import { StatementSheet } from "./statement-sheet";
import { CardsSpendingByCategoryCard } from "./spending-by-category";
import { CommitmentsChart, StatementsPanel } from "./statements-panel";
import { StatementStatusBadge } from "./statement-status";
import { useCardMutations } from "./use-card-mutations";

const SHOW_ARCHIVED_KEY = "fa:cards:show-archived";

function payTarget(card: CardDTO, s: StatementDTO): PayTarget | null {
  if (!s.id) return null;
  return { statementId: s.id, cardName: card.name, referenceMonth: s.referenceMonth, dueDate: s.dueDate, remainingCents: s.remainingCents, paymentAccountId: card.paymentAccountId };
}

function Tile({ label, value, hint, icon: Icon, className }: { label: string; value: string; hint: string; icon: typeof Wallet; className?: string }) {
  return (
    <Card className={cn("flex items-start justify-between gap-3 p-4 sm:p-5", className)}>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <p className="mt-2 truncate text-lg font-semibold leading-tight tracking-tight tabular sm:text-[22px]">{value}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>
      </div>
      <span className="hidden size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground sm:flex">
        <Icon className="size-4" aria-hidden />
      </span>
    </Card>
  );
}

function CardPanel({
  card,
  selected,
  canWrite,
  canPay,
  onSelect,
  onEdit,
  onArchive,
  onDelete,
  onPay,
  onOpenStatement,
}: {
  card: CardDTO;
  selected: boolean;
  canWrite: boolean;
  canPay: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onPay: (t: PayTarget) => void;
  onOpenStatement: (id: string) => void;
}) {
  const used = card.usedLimitCents;
  const pct = card.limitCents ? Math.round((used / card.limitCents) * 100) : 0;
  const current = card.currentStatement;
  const next = card.nextDueStatement && card.nextDueStatement.id !== current.id ? card.nextDueStatement : null;
  const archived = Boolean(card.archivedAt);

  return (
    <Card className={cn("flex flex-col gap-4 p-4 transition", selected ? "ring-2 ring-brand" : "hover:border-ring/40", archived && "opacity-80")}>
      <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={`${card.name}: ver faturas`} className="rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <CreditCardVisual name={card.name} issuer={card.issuer} brand={card.brand} last4={card.last4} holderName={card.holderName} color={card.color} privateCard={card.visibility === "PRIVATE"} archived={archived} />
      </button>

      <div className="-mt-1 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarClock className="size-3.5" aria-hidden />
          Fecha dia {card.closingDay} · vence dia {card.dueDay}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="-mr-1 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ações do cartão ${card.name}`}>
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onSelect}>
              <Receipt /> Ver faturas
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/transacoes?creditCardId=${card.id}`}>
                <List /> Ver lançamentos
              </Link>
            </DropdownMenuItem>
            {canWrite && (
              <>
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilLine /> Editar
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onArchive}>
                  {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Desarquivar" : "Arquivar"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 /> Excluir
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div>
        {card.limitCents > 0 ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Limite usado</span>
              <span className="font-medium tabular">
                {formatBRL(used)} <span className="text-muted-foreground">de {formatBRL(card.limitCents)}</span>
              </span>
            </div>
            <Progress
              className="mt-1.5"
              value={pct}
              indicatorClassName={pct >= 90 ? "bg-negative" : pct >= 70 ? "bg-warning" : "bg-brand"}
              aria-label={`Limite usado: ${pct}%`}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Disponível <span className="font-medium text-foreground tabular">{formatBRL(card.availableLimitCents ?? 0)}</span> · {pct}% usado
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Limite não informado · em aberto <span className="font-medium text-foreground tabular">{formatBRL(used)}</span>
          </p>
        )}
      </div>

      <div className="rounded-xl border bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">Fatura atual · {formatMonthBR(current.referenceMonth, { short: true })}</p>
          <StatementStatusBadge status={current.status} />
        </div>
        <p className="mt-1 text-xl font-semibold tracking-tight tabular">{formatBRL(current.totalCents)}</p>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Fecha {formatDayMonthBR(current.closingDate)} · vence {formatDayMonthBR(current.dueDate)}
          </span>
          {current.id && (
            <button type="button" onClick={() => onOpenStatement(current.id!)} className="font-medium text-brand hover:underline">
              Ver fatura
            </button>
          )}
        </div>
      </div>

      {next && (
        <div className={cn("rounded-xl border p-3", next.status === "OVERDUE" ? "border-negative/40 bg-negative/5" : "border-warning/40 bg-warning/5")}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">{next.status === "OVERDUE" ? "Fatura vencida" : "Próxima a vencer"} · {formatMonthBR(next.referenceMonth, { short: true })}</p>
            <StatementStatusBadge status={next.status} />
          </div>
          <div className="mt-1 flex items-end justify-between gap-2">
            <div>
              <p className="text-lg font-semibold tabular">{formatBRL(next.remainingCents)}</p>
              <p className="text-xs text-muted-foreground">
                {next.status === "OVERDUE" ? "venceu" : "vence"} em {formatDateBR(next.dueDate)}
                {next.paidCents > 0 && ` · pago ${formatBRL(next.paidCents)}`}
              </p>
            </div>
            <div className="flex gap-1.5">
              {next.id && (
                <Button size="sm" variant="ghost" onClick={() => onOpenStatement(next.id!)}>
                  Ver
                </Button>
              )}
              {canPay && payTarget(card, next) && (
                <Button size="sm" variant="brand" onClick={() => onPay(payTarget(card, next)!)}>
                  <Banknote /> Pagar
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {!next && canPay && current.remainingCents > 0 && current.id && (
        <Button size="sm" variant="outline" onClick={() => onPay(payTarget(card, current)!)}>
          <Banknote /> Antecipar pagamento da fatura atual
        </Button>
      )}
      {archived && (
        <Badge variant="muted" className="w-fit">
          <Archive aria-hidden /> Arquivado
        </Badge>
      )}
    </Card>
  );
}

export function CardsView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canWrite = useCan("cards:write");
  const canPay = useCan("transactions:write");
  const cards = useCards({ includeArchived: true });
  const { archive, remove } = useCardMutations();
  const [showArchived, setShowArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CardDTO | null>(null);
  const [deleting, setDeleting] = useState<CardDTO | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayTarget | null>(null);

  useEffect(() => {
    try {
      setShowArchived(localStorage.getItem(SHOW_ARCHIVED_KEY) === "1");
    } catch {
      // armazenamento indisponível
    }
  }, []);

  const all = useMemo(() => cards.data ?? [], [cards.data]);
  const active = all.filter((c) => !c.archivedAt);
  const archivedCount = all.length - active.length;
  const shown = showArchived ? all : active;

  const setParam = (key: string, value: string | null) => {
    const p = new URLSearchParams(searchParams.toString());
    if (value) p.set(key, value);
    else p.delete(key);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  };
  const paramId = searchParams.get("id");
  const selected = all.find((c) => c.id === paramId) ?? shown[0] ?? null;
  const statementId = searchParams.get("statement");

  // Cartão arquivado selecionado pela URL: mostra os arquivados para que ele apareça na lista.
  useEffect(() => {
    if (paramId && all.find((c) => c.id === paramId)?.archivedAt) setShowArchived(true);
  }, [paramId, all]);

  const outstanding = active.reduce((s, c) => s + c.outstandingCents, 0);
  const available = active.reduce((s, c) => s + (c.availableLimitCents ?? 0), 0);
  const withLimit = active.filter((c) => c.limitCents > 0).length;
  const upcoming = active
    .flatMap((c) => [c.nextDueStatement, c.currentStatement].filter((s): s is StatementDTO => Boolean(s && s.remainingCents > 0)).map((s) => ({ card: c, s })))
    .sort((a, b) => a.s.dueDate.localeCompare(b.s.dueDate))[0];

  const openForm = (c: CardDTO | null) => {
    setEditing(c);
    setFormOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cartões"
        description="Limites, faturas e compromissos futuros dos cartões de crédito"
        actions={
          canWrite && (
            <Button variant="brand" onClick={() => openForm(null)}>
              <Plus /> Novo cartão
            </Button>
          )
        }
      />

      {cards.isLoading ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[108px] rounded-xl" />
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-[420px] rounded-xl" />
            ))}
          </div>
        </>
      ) : cards.error ? (
        <ErrorState error={cards.error} onRetry={() => cards.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="Nenhum cartão cadastrado"
          description="Cadastre seus cartões com os dias de fechamento e vencimento para acompanhar faturas, parcelas e limite."
          action={
            canWrite && (
              <Button variant="brand" onClick={() => openForm(null)}>
                <Plus /> Cadastrar cartão
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Tile className="col-span-2 sm:col-span-1" label="Em aberto nos cartões" value={formatBRL(outstanding)} hint="Faturas abertas, fechadas e parcelas futuras" icon={CreditCard} />
            <Tile label="Limite disponível" value={withLimit ? formatBRL(available) : "—"} hint={withLimit ? `Somando ${withLimit} ${withLimit === 1 ? "cartão" : "cartões"} com limite` : "Informe o limite dos cartões"} icon={Wallet} />
            <Tile
              label="Próximo vencimento"
              value={upcoming ? formatBRL(upcoming.s.remainingCents) : "—"}
              hint={upcoming ? `${upcoming.card.name} · ${formatDateBR(upcoming.s.dueDate)}` : "Nenhuma fatura em aberto"}
              icon={CalendarClock}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {shown.length} {shown.length === 1 ? "cartão" : "cartões"}
            </h2>
            {archivedCount > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={showArchived}
                  onCheckedChange={(v) => {
                    setShowArchived(v);
                    try {
                      localStorage.setItem(SHOW_ARCHIVED_KEY, v ? "1" : "0");
                    } catch {
                      // ignore
                    }
                  }}
                  aria-label="Mostrar cartões arquivados"
                />
                Mostrar arquivados ({archivedCount})
              </label>
            )}
          </div>

          {shown.length === 0 ? (
            <EmptyState icon={Archive} title="Todos os cartões estão arquivados" description="Ative “Mostrar arquivados” para vê-los." />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((c) => (
                <CardPanel
                  key={c.id}
                  card={c}
                  selected={selected?.id === c.id}
                  canWrite={canWrite}
                  canPay={canPay}
                  onSelect={() => setParam("id", c.id)}
                  onEdit={() => openForm(c)}
                  onArchive={() => archive.mutate({ id: c.id, archived: !c.archivedAt })}
                  onDelete={() => {
                    setDeleteError(null);
                    setDeleting(c);
                  }}
                  onPay={setPaying}
                  onOpenStatement={(id) => setParam("statement", id)}
                />
              ))}
            </div>
          )}

          <div className="grid gap-4 2xl:grid-cols-5">
            <div className="min-w-0 2xl:col-span-3">{selected && <StatementsPanel card={selected} onOpen={(id) => setParam("statement", id)} />}</div>
            <div className="min-w-0 2xl:col-span-2">
              <CommitmentsChart />
            </div>
          </div>

          <CardsSpendingByCategoryCard onOpenStatement={(id) => setParam("statement", id)} />
        </>
      )}

      <CardFormDialog open={formOpen} onOpenChange={setFormOpen} card={editing} />
      <PayStatementDialog target={paying} onOpenChange={(o) => !o && setPaying(null)} />
      <StatementSheet statementId={statementId} onClose={() => setParam("statement", null)} onPay={setPaying} canPay={canPay} />
      <AlertDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir o cartão {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Só é possível excluir cartões sem lançamentos. Cartões com histórico devem ser arquivados: saem das listas, mas faturas e relatórios são preservados.</AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            {deleteError && deleting && !deleting.archivedAt && (
              <Button
                variant="outline"
                onClick={() => {
                  archive.mutate({ id: deleting.id, archived: true });
                  setDeleting(null);
                }}
              >
                <Archive /> Arquivar
              </Button>
            )}
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    if (paramId === deleting.id) setParam("id", null);
                    setDeleting(null);
                  },
                  onError: (e) => setDeleteError(errorMessage(e)),
                })
              }
            >
              <Trash2 /> Excluir cartão
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
