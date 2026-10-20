"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AlarmClockOff, Barcode, CalendarClock, Copy, CreditCard, ExternalLink, Landmark, MoreHorizontal, Pencil, Plus, Repeat, RotateCcw, SkipForward, Undo2, XCircle, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { api, errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { diffDays, formatDateBR, formatDayMonthBR, formatLongDateBR, formatMonthBR, monthKey, todayISO, weekday, WEEKDAY_NAMES } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";
import { MonthSwitcher } from "@/features/budgets/month-switcher";
import { SummaryTile } from "@/features/budgets/summary-tile";
import { BillFormDialog } from "./bill-form-dialog";
import { BoletoDialog } from "./boleto-dialog";
import { BillStatusBadge } from "./bill-status-badge";
import { PayBillDialog } from "./pay-bill-dialog";
import type { BillDTO, BillStatus } from "./types";
import { SNOOZE_DAYS, copyBoletoLine, useBillMutations, useBills } from "./use-bills";
import { formatDigitableLine } from "@/lib/boleto";

const FILTERS: Array<{ value: string; label: string; statuses?: BillStatus[] }> = [
  { value: "all", label: "Todas" },
  { value: "open", label: "A pagar", statuses: ["PENDING", "OVERDUE"] },
  { value: "overdue", label: "Vencidas", statuses: ["OVERDUE"] },
  { value: "paid", label: "Pagas e lançadas", statuses: ["PAID", "POSTED"] },
  { value: "closed", label: "Ignoradas e canceladas", statuses: ["SKIPPED", "CANCELLED"] },
];

function groupLabel(date: string, today: string): string {
  const d = diffDays(date, today);
  const base = `${formatLongDateBR(date)} · ${WEEKDAY_NAMES[weekday(date)]}`;
  if (d === 0) return `Hoje · ${base}`;
  if (d === 1) return `Amanhã · ${base}`;
  if (d === -1) return `Ontem · ${base}`;
  return base;
}

function dueHint(bill: BillDTO): string | null {
  if (bill.status === "OVERDUE") return bill.daysUntilDue === -1 ? "venceu ontem" : `venceu há ${-bill.daysUntilDue} dias`;
  if (bill.status === "PENDING") return bill.daysUntilDue === 0 ? "vence hoje" : bill.daysUntilDue === 1 ? "vence amanhã" : `em ${bill.daysUntilDue} dias`;
  if (bill.status === "POSTED" && bill.transaction) return `lançada no cartão em ${formatDateBR(bill.transaction.date)}`;
  if (bill.status === "PAID" && bill.transaction) return `${bill.type === "INCOME" ? "recebida" : "paga"} em ${formatDateBR(bill.transaction.date)}`;
  return null;
}

/** Conta vencida em aberto (não fatura): aceita "pagar depois", que adia só o lembrete. */
function canSnooze(bill: BillDTO, today: string): boolean {
  return bill.kind === "SCHEDULED" && bill.type === "EXPENSE" && bill.status === "OVERDUE" && bill.rawStatus === "PENDING" && !snoozedUntil(bill, today);
}

/** Data até a qual o lembrete está adiado, se ainda estiver no futuro. */
function snoozedUntil(bill: BillDTO, today: string): string | null {
  const open = bill.status === "PENDING" || bill.status === "OVERDUE";
  return open && bill.reminderSnoozedUntil && bill.reminderSnoozedUntil > today ? bill.reminderSnoozedUntil : null;
}

function SnoozeHint({ bill, today }: { bill: BillDTO; today: string }) {
  const until = snoozedUntil(bill, today);
  if (!until) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <AlarmClockOff className="size-3" aria-hidden /> Lembrete adiado até {formatDayMonthBR(until)}
    </span>
  );
}

type Handlers = {
  today: string;
  snoozingId: string | null;
  onSnooze: (b: BillDTO) => void;
  onPay: (b: BillDTO) => void;
  onEdit: (b: BillDTO) => void;
  onUndo: (b: BillDTO) => void;
  onCancel: (b: BillDTO) => void;
  onSkip: (b: BillDTO) => void;
  onReopen: (b: BillDTO) => void;
};

function Meta({ bill }: { bill: BillDTO }) {
  if (bill.kind === "CARD_STATEMENT") return <span>Fatura de cartão · somente leitura</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {bill.category && (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: bill.category.color }} aria-hidden />
          {bill.category.name}
        </span>
      )}
      {bill.recurring && (
        <span className="inline-flex items-center gap-1">
          <Repeat className="size-3" aria-hidden /> {bill.recurring.frequencyLabel}
        </span>
      )}
      {bill.recurring?.autoPost && (
        <span className="inline-flex items-center gap-1">
          <Zap className="size-3" aria-hidden /> automático
        </span>
      )}
      {bill.boletoLine && (
        <span className="inline-flex items-center gap-1">
          <Barcode className="size-3" aria-hidden /> boleto
        </span>
      )}
      {bill.isEstimate && <Badge variant="muted">valor estimado</Badge>}
    </span>
  );
}

function Amount({ bill }: { bill: BillDTO }) {
  const paid = bill.paidAmountCents;
  return (
    <span className="shrink-0 text-right">
      <span className={cn("block whitespace-nowrap font-semibold tabular", bill.type === "INCOME" && "text-positive")}>
        {bill.type === "INCOME" ? "+" : ""}
        {formatBRL(paid ?? bill.amountCents)}
      </span>
      {paid !== null && paid !== bill.amountCents && <span className="block text-xs text-muted-foreground tabular">previsto {formatBRL(bill.amountCents)}</span>}
      {bill.kind === "CARD_STATEMENT" && bill.statement && bill.statement.paidCents > 0 && (
        <span className="block text-xs text-muted-foreground tabular">em aberto de {formatBRL(bill.statement.totalCents)}</span>
      )}
    </span>
  );
}

function Payer({ bill, hideEmpty }: { bill: BillDTO; hideEmpty?: boolean }) {
  if (bill.creditCard)
    return (
      <span className="inline-flex items-center gap-1.5">
        <CreditCard className="size-3.5 text-muted-foreground" aria-hidden /> {bill.creditCard.name}
      </span>
    );
  if (bill.account)
    return (
      <span className="inline-flex items-center gap-1.5">
        <Landmark className="size-3.5 text-muted-foreground" aria-hidden /> {bill.account.name}
      </span>
    );
  return hideEmpty ? null : <span className="text-muted-foreground">—</span>;
}

function CopyBoletoButton({ line }: { line: string }) {
  return (
    <Button size="sm" variant="ghost" onClick={() => copyBoletoLine(line)} title={formatDigitableLine(line)}>
      <Copy /> Copiar código
    </Button>
  );
}

function Actions({ bill, canEdit, h }: { bill: BillDTO; canEdit: boolean; h: Handlers }) {
  if (bill.kind === "CARD_STATEMENT") {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link href="/cartoes">
          Ver fatura <ExternalLink />
        </Link>
      </Button>
    );
  }
  const copy = bill.boletoLine ? <CopyBoletoButton line={bill.boletoLine} /> : null;
  if (!canEdit) return copy;
  const open = bill.status === "PENDING" || bill.status === "OVERDUE";
  const done = bill.status === "PAID" || bill.status === "POSTED";
  const closed = bill.status === "SKIPPED" || bill.status === "CANCELLED";
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {copy}
      {canSnooze(bill, h.today) && (
        <Button size="sm" variant="outline" onClick={() => h.onSnooze(bill)} loading={h.snoozingId === bill.id} title={`Adia o lembrete por ${SNOOZE_DAYS} dias; a conta continua em aberto`}>
          Pagar depois
        </Button>
      )}
      {open && (
        <Button size="sm" variant={bill.status === "OVERDUE" ? "brand" : "outline"} onClick={() => h.onPay(bill)}>
          {bill.type === "INCOME" ? "Receber" : "Pagar"}
        </Button>
      )}
      {closed && (
        <Button size="sm" variant="outline" onClick={() => h.onReopen(bill)}>
          <RotateCcw /> Reabrir
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Mais ações: ${bill.description}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {done ? (
            <DropdownMenuItem onSelect={() => h.onUndo(bill)}>
              <Undo2 /> Desfazer {bill.type === "INCOME" ? "recebimento" : "pagamento"}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => h.onEdit(bill)}>
              <Pencil /> Editar
            </DropdownMenuItem>
          )}
          {open && (
            <>
              <DropdownMenuItem onSelect={() => h.onSkip(bill)}>
                <SkipForward /> Ignorar esta ocorrência
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => h.onCancel(bill)}>
                <XCircle /> Cancelar conta
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function BillsTab({ onGoToRecurring }: { onGoToRecurring: () => void }) {
  const me = useMe();
  const tz = me.data?.household.timezone;
  const canEdit = useCan("bills:write");
  const today = todayISO(tz);
  const [month, setMonth] = useState(monthKey(today));
  const [filter, setFilter] = useState("all");
  const statuses = FILTERS.find((f) => f.value === filter)?.statuses;
  const q = useBills({ month, statuses });
  const { undoPay, cancel, skip, snooze, reopen } = useBillMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [boletoOpen, setBoletoOpen] = useState(false);
  const [editing, setEditing] = useState<BillDTO | null>(null);
  const [paying, setPaying] = useState<BillDTO | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "undo" | "cancel"; bill: BillDTO } | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const payId = search.get("pay");
  const ready = Boolean(me.data);

  // ?pay=<id> (ex.: "Já paguei" do aviso de conta vencida): abre o pagamento dessa conta e limpa a URL.
  useEffect(() => {
    if (!payId || !ready) return;
    const next = new URLSearchParams(search.toString());
    next.delete("pay");
    router.replace(next.size ? `${pathname}?${next.toString()}` : pathname, { scroll: false });
    api
      .get<BillDTO>(`/api/v1/bills/${encodeURIComponent(payId)}`)
      .then((b) => {
        setMonth(monthKey(b.dueDate));
        if (b.kind !== "SCHEDULED" || (b.status !== "PENDING" && b.status !== "OVERDUE")) toast.info(`${b.description} não está mais em aberto`, { description: b.statusLabel });
        else if (!canEdit) toast.info("Você não tem permissão para registrar pagamentos");
        else setPaying(b);
      })
      .catch((err) => toast.error(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payId, ready]);

  const items = q.data?.items ?? [];
  const groups = useMemo(() => {
    const map = new Map<string, BillDTO[]>();
    for (const b of items) map.set(b.dueDate, [...(map.get(b.dueDate) ?? []), b]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);
  const totals = q.data?.totals;
  const h: Handlers = {
    today,
    snoozingId: snooze.isPending ? (snooze.variables?.id ?? null) : null,
    onSnooze: (b) => snooze.mutate({ id: b.id }),
    onPay: setPaying,
    onEdit: (b) => {
      setEditing(b);
      setFormOpen(true);
    },
    onUndo: (b) => setConfirm({ kind: "undo", bill: b }),
    onCancel: (b) => setConfirm({ kind: "cancel", bill: b }),
    onSkip: (b) => skip.mutate(b.id),
    onReopen: (b) => reopen(b.id),
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <MonthSwitcher month={month} onChange={setMonth} timezone={tz} className="self-start" />
        <div className="flex flex-wrap items-center gap-2">
          <div className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-0.5" role="group" aria-label="Filtrar por status">
            {FILTERS.map((f) => (
              <Button key={f.value} size="sm" variant={filter === f.value ? "default" : "outline"} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                {f.label}
              </Button>
            ))}
          </div>
          {canEdit && (
            <>
              <Button variant="outline" onClick={() => setBoletoOpen(true)}>
                <Barcode /> Adicionar boleto
              </Button>
              <Button
                variant="brand"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus /> Nova conta
              </Button>
            </>
          )}
        </div>
      </div>

      {q.isLoading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Carregando contas">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className={cn("space-y-5 transition-opacity", q.isFetching && "opacity-70")}>
          {totals && (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
              <SummaryTile label="A pagar" value={formatBRL(totals.toPayCents)}>
                {totals.pendingCount + totals.overdueCount} {totals.pendingCount + totals.overdueCount === 1 ? "conta" : "contas"}, incluindo faturas
              </SummaryTile>
              <SummaryTile label="Vencidas" value={<span className={cn(totals.overdueCents > 0 && "text-warning")}>{formatBRL(totals.overdueCents)}</span>}>
                {totals.overdueCount ? `${totals.overdueCount} ${totals.overdueCount === 1 ? "conta" : "contas"} em aberto` : "Nenhuma conta vencida"}
              </SummaryTile>
              <SummaryTile label="Pagas" value={formatBRL(totals.paidCents)}>
                {totals.paidCount} {totals.paidCount === 1 ? "conta" : "contas"} no mês
              </SummaryTile>
              <SummaryTile label="Receitas previstas" value={formatBRL(totals.expectedIncomeCents)}>
                {totals.receivedIncomeCents ? `${formatBRL(totals.receivedIncomeCents)} já recebidos` : "A receber no mês"}
              </SummaryTile>
            </div>
          )}

          {!items.length ? (
            <EmptyState
              icon={CalendarClock}
              title={filter === "all" ? `Nenhuma conta em ${formatMonthBR(month)}` : "Nenhuma conta com este status"}
              description={
                filter === "all"
                  ? "Cadastre contas avulsas ou recorrências (aluguel, internet, assinaturas) para acompanhar os vencimentos."
                  : "Altere o filtro para ver as demais contas do mês."
              }
              action={
                canEdit && filter === "all" ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" onClick={onGoToRecurring}>
                      <Repeat /> Cadastrar recorrência
                    </Button>
                    <Button variant="outline" onClick={() => setBoletoOpen(true)}>
                      <Barcode /> Adicionar boleto
                    </Button>
                    <Button
                      variant="brand"
                      onClick={() => {
                        setEditing(null);
                        setFormOpen(true);
                      }}
                    >
                      <Plus /> Nova conta
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <>
              {/* Desktop: tabela agrupada por vencimento */}
              <Card className="hidden overflow-hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Descrição</TableHead>
                      <TableHead>Conta / cartão</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead className="w-56 text-right">
                        <span className="sr-only">Ações</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map(([date, bills]) => (
                      <GroupRows key={date} label={groupLabel(date, today)} bills={bills} canEdit={canEdit} h={h} />
                    ))}
                  </TableBody>
                </Table>
              </Card>

              {/* Mobile: cartões */}
              <div className="space-y-5 md:hidden">
                {groups.map(([date, bills]) => (
                  <section key={date} aria-label={groupLabel(date, today)}>
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{groupLabel(date, today)}</h3>
                    <ul className="space-y-2">
                      {bills.map((b) => (
                        <li key={b.id}>
                          <Card className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium leading-snug">{b.description}</p>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  <Meta bill={b} />
                                </div>
                              </div>
                              <Amount bill={b} />
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                              <BillStatusBadge status={b.status} label={b.statusLabel} />
                              {dueHint(b) && <span className="text-muted-foreground">{dueHint(b)}</span>}
                              <span className="text-muted-foreground">
                                <Payer bill={b} hideEmpty />
                              </span>
                              <SnoozeHint bill={b} today={today} />
                            </div>
                            {(canEdit || b.kind === "CARD_STATEMENT" || b.boletoLine) && (
                              <div className="mt-3 border-t pt-3">
                                <Actions bill={b} canEdit={canEdit} h={h} />
                              </div>
                            )}
                          </Card>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <BillFormDialog open={formOpen} onOpenChange={setFormOpen} bill={editing} />
      <BoletoDialog open={boletoOpen} onOpenChange={setBoletoOpen} />
      <PayBillDialog bill={paying} onOpenChange={(o) => !o && setPaying(null)} />
      <AlertDialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "undo" ? "Desfazer o pagamento?" : "Cancelar esta conta?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "undo"
                ? `O lançamento de ${confirm.bill.description} vai para a lixeira (pode ser restaurado) e a conta volta a ficar prevista. Os saldos são recalculados.`
                : `${confirm?.bill.description ?? "A conta"} deixará de aparecer como a pagar. Nenhum lançamento é criado ou excluído e é possível reabrir depois.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "undo") undoPay.mutate(confirm.bill.id);
                else cancel.mutate(confirm.bill.id);
              }}
            >
              {confirm?.kind === "undo" ? "Desfazer pagamento" : "Cancelar conta"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GroupRows({ label, bills, canEdit, h }: { label: string; bills: BillDTO[]; canEdit: boolean; h: Handlers }) {
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={5} className="py-2 text-xs font-medium text-muted-foreground">
          {label}
        </TableCell>
      </TableRow>
      {bills.map((b) => (
        <TableRow key={b.id}>
          <TableCell className="max-w-80">
            <p className="truncate font-medium">{b.description}</p>
            <div className="mt-0.5 text-xs text-muted-foreground">
              <Meta bill={b} />
            </div>
          </TableCell>
          <TableCell className="text-sm">
            <Payer bill={b} />
          </TableCell>
          <TableCell>
            <BillStatusBadge status={b.status} label={b.statusLabel} />
            {dueHint(b) && <p className="mt-1 text-xs text-muted-foreground">{dueHint(b)}</p>}
            <SnoozeHint bill={b} today={h.today} />
          </TableCell>
          <TableCell className="text-right">
            <Amount bill={b} />
          </TableCell>
          <TableCell className="text-right">
            <Actions bill={b} canEdit={canEdit} h={h} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
