"use client";

import { useMemo, useState } from "react";
import { ArrowLeftRight, CheckCheck, CircleSlash, CreditCard, Link2, MoreHorizontal, Search, Sparkles, TriangleAlert, Undo2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { TRANSACTION_SOURCE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { CategoryPicker } from "@/features/categories/category-picker";
import { useAccounts } from "@/features/finance/hooks";
import { isInvestmentAccount } from "@/features/accounts/transfer-account-field";
import { ROW_STATUS, ROW_STATUS_ORDER, RowStatusBadge } from "./status";
import { canMarkTransfer, isUnresolvedTransfer, transferTotals } from "./helpers";
import { TransferTag } from "./transfer-tag";
import { TransferRowsDialog } from "./transfer-rows-dialog";
import { useCommitImport, useSetRowsTransfer, useUpdateRows } from "./use-imports";
import type { ImportPreview, ImportRowDTO, ImportRowStatus } from "./types";

const PAGE_SIZE = 50;
const SELECTABLE: ImportRowStatus[] = ["NEW", "MATCHED", "DIVERGENT"];

function Amount({ cents, transfer, className }: { cents: number | null; transfer?: boolean; className?: string }) {
  if (cents === null) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const inflow = cents > 0;
  return (
    <span className={cn("font-medium tabular", inflow && !transfer && "text-positive", className)}>
      <span className="sr-only">{transfer ? (inflow ? "Transferência (entrada) de " : "Transferência (saída) de ") : inflow ? "Entrada de " : "Saída de "}</span>
      {formatBRL(cents, { signed: true })}
    </span>
  );
}

function KindTag({ row }: { row: ImportRowDTO }) {
  if (row.kind === "TRANSFER") return <TransferTag row={row} />;
  if (row.kind === "CARD_PAYMENT")
    return (
      <Badge variant="outline">
        <CreditCard aria-hidden /> Pagamento de fatura
      </Badge>
    );
  if (row.installment) return <Badge variant="outline">Parcela {row.installment.number}/{row.installment.total}</Badge>;
  return null;
}

function MatchInfo({ row }: { row: ImportRowDTO }) {
  const tx = row.matchedTransaction;
  if (!tx || row.status !== "MATCHED") return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Link2 className="size-3" aria-hidden /> No app: <span className="font-medium text-foreground">{tx.description}</span> · {formatDateBR(tx.date)} ·{" "}
      <span className="tabular">{formatBRL(tx.amountCents)}</span> · {labelOf(TRANSACTION_SOURCE_LABELS, tx.source)}
    </p>
  );
}

function RowCategory({ row, onChange, disabled }: { row: ImportRowDTO; onChange: (categoryId: string | null) => void; disabled: boolean }) {
  if (row.kind === "TRANSFER") return <span className="text-xs text-muted-foreground">Sem categoria (transferência)</span>;
  if (row.kind === "CARD_PAYMENT" || !["NEW", "DIVERGENT"].includes(row.status) || row.amountCents === null) {
    return <span className="text-xs text-muted-foreground">{row.categoryName ?? "—"}</span>;
  }
  return (
    <div className={cn(disabled && "pointer-events-none opacity-60")}>
      <CategoryPicker
        value={row.categoryId ? { categoryId: row.categoryId, subcategoryId: null } : null}
        onChange={(v) => onChange(v?.categoryId ?? null)}
        kind={row.amountCents < 0 ? "EXPENSE" : "INCOME"}
        categoriesOnly
        allowNone
        noneLabel="Automática (regras)"
        placeholder="Automática (regras)"
        className="h-8 w-full min-w-40 text-xs"
      />
    </div>
  );
}

function RowActions({
  row,
  onForceNew,
  transferable,
  onTransfer,
  onRevertTransfer,
  disabled,
}: {
  row: ImportRowDTO;
  onForceNew: () => void;
  transferable: boolean;
  onTransfer: () => void;
  onRevertTransfer: () => void;
  disabled: boolean;
}) {
  const forceNew = ["DUPLICATE", "MATCHED", "DIVERGENT"].includes(row.status);
  const unresolved = isUnresolvedTransfer(row);
  if (!forceNew && !transferable) return null;
  const label = row.description ?? "linha";
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 lg:flex-nowrap">
      {transferable && unresolved && (
        <Button variant="outline" size="sm" className="border-warning/50 text-foreground" onClick={onTransfer} disabled={disabled}>
          <ArrowLeftRight /> Escolher a conta
        </Button>
      )}
      {forceNew && (
        <Button variant="ghost" size="sm" onClick={onForceNew} disabled={disabled} title="Criar um novo lançamento mesmo assim">
          <Sparkles /> Importar como novo
        </Button>
      )}
      {transferable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`Mais ações: ${label}`} title="Mais ações">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.kind !== "TRANSFER" ? (
              <DropdownMenuItem onSelect={onTransfer}>
                <ArrowLeftRight /> Marcar como transferência…
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={onTransfer}>
                  <ArrowLeftRight /> {unresolved ? "Escolher a conta…" : "Trocar a conta…"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onRevertTransfer}>
                  <Undo2 /> Voltar para receita/despesa
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** Mensagem da linha: oculta a de "já registrado" (a MatchInfo mostra), exceto quando explica a conversão em transferência. */
function showMessage(row: ImportRowDTO): boolean {
  return Boolean(row.message) && (!(row.status === "MATCHED" && row.matchedTransaction) || row.kind === "TRANSFER");
}

/** Etapa de revisão: contadores, filtros por status, seleção, categoria por linha e confirmação. */
export function ReviewStep({ preview, onCommitted }: { preview: ImportPreview; onCommitted: (data: ImportPreview) => void }) {
  const [filter, setFilter] = useState<ImportRowStatus | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [transfersOnly, setTransfersOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferRows, setTransferRows] = useState<ImportRowDTO[]>([]);
  const update = useUpdateRows(preview.batch.id);
  const setTransfer = useSetRowsTransfer(preview.batch.id);
  const commit = useCommitImport(preview.batch.id, onCommitted);
  const accounts = useAccounts();
  const rows = preview.rows;
  const busy = update.isPending || setTransfer.isPending;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const transferable = (r: ImportRowDTO) => canMarkTransfer(preview, r);
  const transferRowsAll = rows.filter((r) => r.kind === "TRANSFER" && (r.status === "NEW" || r.status === "MATCHED"));
  const unresolved = rows.filter((r) => r.status === "NEW" && isUnresolvedTransfer(r));
  const noInvestmentAccount = Boolean(accounts.data) && !accounts.data!.some((a) => isInvestmentAccount(a) && !a.archivedAt);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(
      (r) => (filter === "ALL" || r.status === filter) && (!transfersOnly || r.kind === "TRANSFER") && (!term || (r.description ?? "").toLowerCase().includes(term)),
    );
  }, [rows, filter, search, transfersOnly]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const selected = rows.filter((r) => r.selected);
  const toCreate = selected.filter((r) => r.status === "NEW");
  const toLink = selected.filter((r) => r.status === "MATCHED");
  const toReview = selected.filter((r) => r.status === "DIVERGENT");
  const regular = toCreate.filter((r) => r.kind !== "TRANSFER");
  const inflow = regular.reduce((s, r) => s + Math.max(0, r.amountCents ?? 0), 0);
  const outflow = regular.reduce((s, r) => s + Math.min(0, r.amountCents ?? 0), 0);
  const transfers = transferTotals(toCreate);
  const toConvert = toLink.filter((r) => r.kind === "TRANSFER" && r.transfer?.accountId && (r.matchedTransaction?.type === "INCOME" || r.matchedTransaction?.type === "EXPENSE"));
  // Ação em lote: linhas selecionadas do filtro/busca atual que podem virar transferência.
  const bulkTargets = filtered.filter((r) => r.selected && transferable(r));

  const setNewSelection = (value: boolean) => {
    const changes = rows.filter((r) => r.status === "NEW" && r.selected !== value && !(value && isUnresolvedTransfer(r))).map((r) => ({ rowId: r.id, selected: value }));
    if (changes.length) update.mutate(changes);
  };

  const revertTransfer = (r: ImportRowDTO) =>
    setTransfer.mutate({ rowIds: [r.id], transferAccountId: null }, { onError: (e) => toast.error(errorMessage(e)) });

  // Linha nova sem a conta do outro lado não entra (viraria erro na confirmação).
  const isSelectable = (r: ImportRowDTO) => SELECTABLE.includes(r.status) && !(r.status === "NEW" && isUnresolvedTransfer(r));
  const pageCheckState = visible.filter(isSelectable);
  const allPageChecked = pageCheckState.length > 0 && pageCheckState.every((r) => r.selected);

  const openTransfer = (list: ImportRowDTO[]) => {
    setTransferRows(list);
    setTransferOpen(true);
  };

  const rowActions = (r: ImportRowDTO) => (
    <RowActions
      row={r}
      onForceNew={() => update.mutate([{ rowId: r.id, forceNew: true }])}
      transferable={transferable(r)}
      onTransfer={() => openTransfer([r])}
      onRevertTransfer={() => revertTransfer(r)}
      disabled={busy}
    />
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-7" role="group" aria-label="Filtrar por situação">
        <button
          type="button"
          onClick={() => {
            setFilter("ALL");
            setPage(1);
          }}
          aria-pressed={filter === "ALL"}
          className={cn("min-w-0 rounded-xl border bg-card p-2.5 text-left shadow-card transition hover:border-ring/40 sm:p-3", filter === "ALL" && "border-brand ring-2 ring-brand/20")}
        >
          <span className="text-xs text-muted-foreground">Todas</span>
          <span className="mt-1 block text-lg font-semibold tabular sm:text-xl">{rows.length}</span>
        </button>
        {ROW_STATUS_ORDER.filter((s) => s !== "IMPORTED" || counts[s]).map((s) => {
          const meta = ROW_STATUS[s];
          const Icon = meta.icon;
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                setFilter(s);
                setPage(1);
              }}
              aria-pressed={filter === s}
              title={meta.help}
              className={cn("min-w-0 rounded-xl border bg-card p-2.5 text-left shadow-card transition hover:border-ring/40 sm:p-3", filter === s && "border-brand ring-2 ring-brand/20", !counts[s] && "opacity-60")}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{meta.plural}</span>
              </span>
              <span className="mt-1 block text-lg font-semibold tabular sm:text-xl">{counts[s] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {filter !== "ALL" && <p className="text-sm text-muted-foreground">{ROW_STATUS[filter].help}</p>}

      {unresolved.length > 0 && preview.batch.account && (
        <div role="note" className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="flex min-w-0 items-start gap-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 break-words">
              <strong>{unresolved.length}</strong> linha(s) parecem aplicação/resgate ou transferência entre contas próprias, mas falta saber a conta do outro lado. Elas ficam{" "}
              <strong>fora da importação</strong> até você escolher a conta — assim o dinheiro aplicado não vira despesa nem o resgate vira receita.
              {noInvestmentAccount && " A família ainda não tem conta de investimento: dá para criar uma (ex.: “Investimentos” ou “CDB <banco>”) ao escolher a conta."}
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0 border-warning/50" onClick={() => openTransfer(unresolved)} disabled={busy}>
            <ArrowLeftRight /> Escolher a conta{unresolved.length > 1 ? ` (${unresolved.length})` : ""}
          </Button>
        </div>
      )}

      <Card className="p-0">
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Buscar pela descrição"
              className="pl-9"
              aria-label="Buscar linhas pela descrição"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {transferRowsAll.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={transfersOnly}
                className={cn(transfersOnly && "border-brand bg-accent/60")}
                onClick={() => {
                  setTransfersOnly((v) => !v);
                  setPage(1);
                }}
              >
                <ArrowLeftRight /> Só transferências ({transferRowsAll.length})
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setNewSelection(true)} disabled={busy}>
              <CheckCheck /> Selecionar novos
            </Button>
            <Button variant="outline" size="sm" onClick={() => setNewSelection(false)} disabled={busy}>
              <CircleSlash /> Desmarcar novos
            </Button>
            {preview.batch.account && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openTransfer(bulkTargets)}
                disabled={busy || !bulkTargets.length}
                title="Marca as linhas selecionadas (neste filtro e busca) como transferência entre contas próprias"
              >
                <ArrowLeftRight /> Marcar como transferência{bulkTargets.length ? ` (${bulkTargets.length})` : ""}
              </Button>
            )}
          </div>
        </div>

        {!visible.length ? (
          <p className="p-8 text-center text-sm text-muted-foreground">Nenhuma linha neste filtro.</p>
        ) : (
          <>
            {/* Tabela (telas médias e grandes) */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-10 px-4 py-2.5">
                      <Checkbox
                        checked={allPageChecked}
                        disabled={!pageCheckState.length || busy}
                        onCheckedChange={(v) => update.mutate(pageCheckState.map((r) => ({ rowId: r.id, selected: v === true })))}
                        aria-label="Selecionar as linhas desta página"
                      />
                    </th>
                    <th className="px-2 py-2.5 font-medium">Data</th>
                    <th className="px-2 py-2.5 font-medium">Descrição</th>
                    <th className="px-2 py-2.5 text-right font-medium">Valor</th>
                    <th className="px-2 py-2.5 font-medium">Situação</th>
                    <th className="px-2 py-2.5 font-medium">Categoria</th>
                    <th className="px-4 py-2.5">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const selectable = SELECTABLE.includes(r.status);
                    const pendingAccount = isUnresolvedTransfer(r) && r.status === "NEW";
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b align-top last:border-0",
                          !r.selected && selectable && "bg-muted/30",
                          !selectable && "text-muted-foreground",
                          pendingAccount && "bg-warning/5 shadow-[inset_3px_0_0_var(--color-warning)]",
                        )}
                      >
                        <td className="px-4 py-3">
                          <Checkbox
                            checked={r.selected}
                            disabled={!isSelectable(r) || busy}
                            onCheckedChange={(v) => update.mutate([{ rowId: r.id, selected: v === true }])}
                            aria-label={`Selecionar ${r.description ?? "linha"}`}
                            title={pendingAccount ? "Escolha a conta do outro lado para importar esta linha" : undefined}
                          />
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 tabular">{r.date ? formatDateBR(r.date) : "—"}</td>
                        <td className="max-w-md px-2 py-3">
                          <p className="font-medium text-foreground">{r.description ?? "—"}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <KindTag row={r} />
                          </div>
                          {showMessage(r) && <p className="mt-1 text-xs text-muted-foreground">{r.message}</p>}
                          <MatchInfo row={r} />
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 text-right">
                          <Amount cents={r.amountCents} transfer={r.kind === "TRANSFER"} />
                        </td>
                        <td className="px-2 py-3">
                          <RowStatusBadge status={r.status} />
                        </td>
                        <td className="w-52 px-2 py-3">
                          <RowCategory row={r} onChange={(categoryId) => update.mutate([{ rowId: r.id, categoryId }])} disabled={busy} />
                        </td>
                        <td className="px-4 py-2 text-right">{rowActions(r)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Cartões (celular e tablet) */}
            <ul className="divide-y lg:hidden">
              {visible.map((r) => {
                const selectable = SELECTABLE.includes(r.status);
                const pendingAccount = isUnresolvedTransfer(r) && r.status === "NEW";
                const categoryEditable = ["NEW", "DIVERGENT"].includes(r.status) && r.kind !== "CARD_PAYMENT";
                const hasActions = ["DUPLICATE", "MATCHED", "DIVERGENT"].includes(r.status) || transferable(r);
                return (
                  <li key={r.id} className={cn("p-3 sm:p-4", !r.selected && selectable && "bg-muted/30", pendingAccount && "bg-warning/5 shadow-[inset_3px_0_0_var(--color-warning)]")}>
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={r.selected}
                        disabled={!isSelectable(r) || busy}
                        onCheckedChange={(v) => update.mutate([{ rowId: r.id, selected: v === true }])}
                        aria-label={`Selecionar ${r.description ?? "linha"}`}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 break-words font-medium">{r.description ?? "—"}</p>
                          <Amount cents={r.amountCents} transfer={r.kind === "TRANSFER"} className="shrink-0 text-sm" />
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="tabular">{r.date ? formatDateBR(r.date) : "Sem data"}</span>
                          <RowStatusBadge status={r.status} />
                          <KindTag row={r} />
                        </div>
                        {showMessage(r) && <p className="mt-1 text-xs text-muted-foreground">{r.message}</p>}
                        <MatchInfo row={r} />
                        {categoryEditable || hasActions ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {categoryEditable && (
                              <div className={cn("min-w-0", r.kind === "TRANSFER" ? "flex-1" : "flex-1 sm:w-56 sm:flex-none")}>
                                <RowCategory row={r} onChange={(categoryId) => update.mutate([{ rowId: r.id, categoryId }])} disabled={busy} />
                              </div>
                            )}
                            <div className="ml-auto">{rowActions(r)}</div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between gap-2 border-t p-3 text-sm">
            <span className="text-muted-foreground tabular">
              {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, filtered.length)} de {filtered.length}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="sticky bottom-20 z-10 flex items-center justify-between gap-3 border-brand/30 p-3 shadow-lg sm:p-4 lg:bottom-4">
        <div className="min-w-0 text-sm">
          <p className="font-semibold">
            {toCreate.length} novo(s) a criar
            <span className="font-normal text-muted-foreground sm:hidden">
              {" "}
              · {toLink.length} vínculo(s) · {toReview.length} divergência(s){transfers.count ? ` · ${transfers.count} transferência(s)` : ""}
            </span>
            {toCreate.length > 0 && (
              <span className="hidden font-normal text-muted-foreground sm:inline">
                {" "}
                · receitas <span className="tabular">{formatBRL(inflow)}</span> · despesas <span className="tabular">{formatBRL(Math.abs(outflow))}</span>
                {transfers.count > 0 && (
                  <>
                    {" "}
                    · {transfers.count} transferência(s):
                    {transfers.inflowCents > 0 && (
                      <>
                        {" "}
                        <span className="tabular">{formatBRL(transfers.inflowCents)}</span> entrando
                      </>
                    )}
                    {transfers.inflowCents > 0 && transfers.outflowCents > 0 && " e"}
                    {transfers.outflowCents > 0 && (
                      <>
                        {" "}
                        <span className="tabular">{formatBRL(transfers.outflowCents)}</span> saindo
                      </>
                    )}
                  </>
                )}
              </span>
            )}
          </p>
          <p className="hidden text-xs text-muted-foreground sm:block">
            {toLink.length} correspondência(s) serão vinculadas sem duplicar · {toReview.length} divergência(s) viram pendências · duplicados e ignorados não entram
            {transfers.count || toConvert.length ? " · transferências entre contas próprias não contam como receita nem despesa" : ""}.
          </p>
        </div>
        <Button variant="brand" onClick={() => setConfirmOpen(true)} disabled={!selected.length} loading={commit.isPending} className="shrink-0">
          <Upload /> <span className="sm:hidden">Importar</span>
          <span className="hidden sm:inline">Confirmar importação</span>
        </Button>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar importação?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Serão criados <strong className="text-foreground">{toCreate.length}</strong> lançamento(s)
                  {preview.batch.account ? ` na conta ${preview.batch.account.name}` : preview.batch.creditCard ? ` no cartão ${preview.batch.creditCard.name}` : ""}, vinculadas{" "}
                  <strong className="text-foreground">{toLink.length}</strong> correspondência(s) e abertas <strong className="text-foreground">{toReview.length}</strong> pendência(s) de divergência.
                </p>
                {(transfers.count > 0 || toConvert.length > 0) && (
                  <p>
                    {transfers.count > 0 && (
                      <>
                        <strong className="text-foreground">{transfers.count}</strong> deles entram como transferência entre contas próprias (aplicação/resgate).{" "}
                      </>
                    )}
                    {toConvert.length > 0 && (
                      <>
                        <strong className="text-foreground">{toConvert.length}</strong> lançamento(s) já registrado(s) como receita/despesa vão virar transferência.{" "}
                      </>
                    )}
                    Transferências não contam como receita nem despesa.
                  </p>
                )}
                <p>Você poderá desfazer a importação depois: os lançamentos criados vão para a lixeira e os saldos voltam ao que eram.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                commit.mutate(undefined, { onSettled: () => setConfirmOpen(false) });
              }}
              disabled={commit.isPending}
            >
              {commit.isPending ? "Importando…" : "Importar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <TransferRowsDialog open={transferOpen} onOpenChange={setTransferOpen} preview={preview} rows={transferRows} />
    </div>
  );
}
