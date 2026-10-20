"use client";

import { useMemo, useState } from "react";
import { ArrowLeftRight, ArrowRight, Briefcase, CheckCheck, ChevronDown, CircleSlash, CreditCard, HelpCircle, Link2, MoreHorizontal, Search, Sparkles, TriangleAlert, Undo2, Upload, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/client/api";
import { formatMoney } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { TRANSACTION_SOURCE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { CategoryPicker } from "@/features/categories/category-picker";
import { useAccounts } from "@/features/finance/hooks";
import { isInvestmentAccount } from "@/features/accounts/transfer-account-field";
import { ROW_STATUS, ROW_STATUS_ORDER, RowStatusBadge } from "./status";
import { NATURES, NATURE_LABELS } from "@/features/transactions/nature";
import { NATURE_ICONS } from "@/features/transactions/nature-control";
import { asksNature, canMarkTransfer, canSetNature, commitSummary, isUnresolvedTransfer, needsCounterpartAmount } from "./helpers";
import { TransferTag } from "./transfer-tag";
import { TransferRowsDialog } from "./transfer-rows-dialog";
import { CommitImportDialog } from "./commit-dialog";
import { useCommitImport, useReviewSaving, useSetRowsNature, useSetRowsTransfer, useUpdateRows } from "./use-imports";
import type { ImportPreview, ImportRowDTO, ImportRowNature, ImportRowStatus } from "./types";

const PAGE_SIZE = 50;
const SELECTABLE: ImportRowStatus[] = ["NEW", "MATCHED", "DIVERGENT"];

function Amount({ cents, transfer, currency = "BRL", className }: { cents: number | null; transfer?: boolean; currency?: string; className?: string }) {
  if (cents === null) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const inflow = cents > 0;
  return (
    <span className={cn("font-medium tabular", inflow && !transfer && "text-positive", className)}>
      <span className="sr-only">{transfer ? (inflow ? "Transferência (entrada) de " : "Transferência (saída) de ") : inflow ? "Entrada de " : "Saída de "}</span>
      {formatMoney(cents, currency, { signed: true })}
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

function MatchInfo({ row, currency }: { row: ImportRowDTO; currency: string }) {
  const tx = row.matchedTransaction;
  if (!tx || row.status !== "MATCHED") return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Link2 className="size-3" aria-hidden /> No app: <span className="font-medium text-foreground">{tx.description}</span> · {formatDateBR(tx.date)} ·{" "}
      <span className="tabular">{formatMoney(tx.amountCents, currency)}</span> · {labelOf(TRANSACTION_SOURCE_LABELS, tx.source)}
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

const AUTO = "__auto__";

/** Texto do que vale quando ninguém escolheu (regra, pedido de escolha ou o padrão Pessoal). */
function autoNatureLabel(n: ImportRowNature): string {
  if (n.ask) return "Decidir depois (Pendências)";
  if (n.source === "RULE") return `${NATURE_LABELS[n.value]} (regra)`;
  if (n.source === "GROUP") return `${NATURE_LABELS[n.value]} (grupo do WhatsApp)`;
  return "Pessoal (padrão)";
}

/** Natureza da linha: Pessoal, Empresa ou Repasse (receitas e despesas). Destaca as que pedem escolha. */
function RowNature({ row, editable, onChange, disabled }: { row: ImportRowDTO; editable: boolean; onChange: (nature: ImportRowNature["value"] | null) => void; disabled: boolean }) {
  const n = row.nature;
  if (!n) return <span className="text-xs text-muted-foreground">—</span>;
  const manual = n.source === "MANUAL";
  const label = n.ask ? "Escolher…" : manual ? NATURE_LABELS[n.value] : autoNatureLabel(n);
  const Icon = n.ask ? HelpCircle : NATURE_ICONS[n.value];
  if (!editable) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden /> {n.ask ? "Pede natureza" : manual ? NATURE_LABELS[n.value] : autoNatureLabel(n)}
      </span>
    );
  }
  return (
    <Select value={manual ? n.value : AUTO} onValueChange={(v) => onChange(v === AUTO ? null : (v as ImportRowNature["value"]))} disabled={disabled}>
      <SelectTrigger
        className={cn("h-8 w-full min-w-36 text-xs", n.ask && "border-warning/60 bg-warning/10 font-medium text-foreground", !n.ask && n.value === "BUSINESS" && "text-series-7")}
        aria-label={`Natureza de ${row.description ?? "linha"}: ${n.ask ? "pede para escolher" : label}`}
      >
        <SelectValue>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon className={cn("size-3.5 shrink-0", n.ask ? "text-warning" : "text-muted-foreground", !n.ask && n.value === "BUSINESS" && "text-series-7")} aria-hidden />
            <span className="truncate">{label}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {NATURES.map((v) => {
          const ItemIcon = NATURE_ICONS[v];
          return (
            <SelectItem key={v} value={v}>
              <ItemIcon className="size-3.5" aria-hidden /> {v === "PASSTHROUGH" ? "Repasse de cliente" : NATURE_LABELS[v]}
            </SelectItem>
          );
        })}
        <SelectItem value={AUTO}>
          <Wand2 className="size-3.5" aria-hidden /> {autoNatureLabel(n)}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function RowActions({
  row,
  onForceNew,
  transferable,
  onTransfer,
  onRevertTransfer,
  disabled,
  counterpartCurrency,
}: {
  row: ImportRowDTO;
  onForceNew: () => void;
  transferable: boolean;
  onTransfer: () => void;
  onRevertTransfer: () => void;
  disabled: boolean;
  /** Moeda da conta do outro lado, quando a linha espera o valor nela. */
  counterpartCurrency?: string | null;
}) {
  const forceNew = ["DUPLICATE", "MATCHED", "DIVERGENT"].includes(row.status);
  const unresolved = isUnresolvedTransfer(row);
  const awaitingAmount = needsCounterpartAmount(row);
  if (!forceNew && !transferable) return null;
  const label = row.description ?? "linha";
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 lg:flex-nowrap">
      {transferable && unresolved && (
        <Button variant="outline" size="sm" className="border-warning/50 text-foreground" onClick={onTransfer} disabled={disabled}>
          <ArrowLeftRight /> Escolher a conta
        </Button>
      )}
      {transferable && awaitingAmount && (
        <Button variant="outline" size="sm" className="border-warning/50 text-foreground" onClick={onTransfer} disabled={disabled}>
          <ArrowLeftRight /> Informar valor{counterpartCurrency ? ` em ${counterpartCurrency}` : ""}
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

/**
 * Etapa de revisão: contadores, filtros por status, seleção, categoria por linha e confirmação.
 * `embedded`: sem a barra de confirmação (lotes da migração de planilha, confirmados todos juntos pelo assistente).
 * `onContinue`: a importação final fica na etapa seguinte ("Confirmar fatura", nas faturas de cartão).
 */
export function ReviewStep({
  preview,
  onCommitted,
  onContinue,
  embedded = false,
}: {
  preview: ImportPreview;
  onCommitted?: (data: ImportPreview) => void;
  onContinue?: () => void;
  embedded?: boolean;
}) {
  const [filter, setFilter] = useState<ImportRowStatus | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [transfersOnly, setTransfersOnly] = useState(false);
  /** Só as linhas em que uma regra pede a natureza. */
  const [natureOnly, setNatureOnly] = useState(false);
  /** Escolha de natureza vale também para as linhas parecidas ("FACEBK *AAA" ~ "FACEBK *BBB"). */
  const [applySimilar, setApplySimilar] = useState(true);
  const [page, setPage] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferRows, setTransferRows] = useState<ImportRowDTO[]>([]);
  const update = useUpdateRows(preview.batch.id);
  const setTransfer = useSetRowsTransfer(preview.batch.id);
  const setNature = useSetRowsNature(preview.batch.id);
  const commit = useCommitImport(preview.batch.id, onCommitted);
  // Escolhas da conferência de saídas (extrato de conta) ainda sendo gravadas: a confirmação espera.
  const reviewSaving = useReviewSaving(preview.batch.id);
  const accounts = useAccounts();
  const rows = preview.rows;
  const busy = update.isPending || setTransfer.isPending || setNature.isPending;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const transferable = (r: ImportRowDTO) => canMarkTransfer(preview, r);
  const transferRowsAll = rows.filter((r) => r.kind === "TRANSFER" && (r.status === "NEW" || r.status === "MATCHED"));
  const unresolved = rows.filter((r) => r.status === "NEW" && isUnresolvedTransfer(r));
  const awaitingAmount = rows.filter(needsCounterpartAmount);
  const natureAsks = rows.filter(asksNature);
  const natureEditable = (r: ImportRowDTO) => canSetNature(preview, r);
  const changeNature = (rowIds: string[], nature: ImportRowNature["value"] | null) => setNature.mutate({ rowIds, nature, applyToSimilar: applySimilar });
  const currencyOf = (id: string | null | undefined) => (id ? (accounts.data?.find((a) => a.id === id)?.currency ?? null) : null);
  const statementCurrency = currencyOf(preview.batch.account?.id) ?? "BRL";
  const money = (cents: number) => formatMoney(cents, statementCurrency);
  // Linha nova que não pode entrar ainda: sem a conta do outro lado ou sem o valor na outra moeda.
  const blocked = (r: ImportRowDTO) => r.status === "NEW" && (isUnresolvedTransfer(r) || needsCounterpartAmount(r));
  const noInvestmentAccount = Boolean(accounts.data) && !accounts.data!.some((a) => isInvestmentAccount(a) && !a.archivedAt);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === "ALL" || r.status === filter) &&
        (!transfersOnly || r.kind === "TRANSFER") &&
        (!natureOnly || asksNature(r)) &&
        (!term || (r.description ?? "").toLowerCase().includes(term)),
    );
  }, [rows, filter, search, transfersOnly, natureOnly]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  // O que entra ao confirmar (novas selecionadas, vínculos, divergências, transferências e naturezas).
  const { selected, toCreate, toLink, toReview, inflowCents: inflow, outflowCents: outflow, transfers, toConvert, natureCounts } = commitSummary(rows);
  // Ação em lote: linhas selecionadas do filtro/busca atual que podem virar transferência.
  const bulkTargets = filtered.filter((r) => r.selected && transferable(r));
  // Natureza em lote: linhas selecionadas do filtro/busca atual que são receita/despesa.
  const natureTargets = filtered.filter((r) => r.selected && natureEditable(r));

  const setNewSelection = (value: boolean) => {
    const changes = rows.filter((r) => r.status === "NEW" && r.selected !== value && !(value && blocked(r))).map((r) => ({ rowId: r.id, selected: value }));
    if (changes.length) update.mutate(changes);
  };

  const revertTransfer = (r: ImportRowDTO) =>
    setTransfer.mutate({ rowIds: [r.id], transferAccountId: null }, { onError: (e) => toast.error(errorMessage(e)) });

  // Linha nova sem a conta do outro lado (ou sem o valor na outra moeda) não entra: viraria erro na confirmação.
  const isSelectable = (r: ImportRowDTO) => SELECTABLE.includes(r.status) && !blocked(r);
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
      counterpartCurrency={currencyOf(r.transfer?.accountId)}
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

      {awaitingAmount.length > 0 && (
        <div role="note" className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="flex min-w-0 items-start gap-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 break-words">
              <strong>{awaitingAmount.length}</strong> {awaitingAmount.length === 1 ? "remessa/câmbio entre contas próprias fica" : "remessas/câmbios entre contas próprias ficam"}{" "}
              <strong>fora da importação</strong> até você informar o valor na outra moeda (ele não está neste extrato). Informe linha a linha.
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0 border-warning/50" onClick={() => openTransfer([awaitingAmount[0]!])} disabled={busy}>
            <ArrowLeftRight /> Informar valor{awaitingAmount.length > 1 ? ` (1 de ${awaitingAmount.length})` : ""}
          </Button>
        </div>
      )}

      {natureAsks.length > 0 && preview.batch.status === "PREVIEW" && (
        <div role="note" className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="flex min-w-0 items-start gap-2 text-sm">
            <HelpCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 break-words">
              <strong>{natureAsks.length}</strong> {natureAsks.length === 1 ? "lançamento pede" : "lançamentos pedem"} a natureza: Pessoal, Empresa ou Repasse de cliente. Escolha na coluna “Natureza” (com
              “Aplicar às parecidas”, uma escolha vale para todas as “FACEBK *…”, por exemplo). Sem escolha, entram como Pessoal e ficam em Pendências. Saldo e fatura não mudam.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-warning/50"
            aria-pressed={natureOnly}
            onClick={() => {
              setNatureOnly((v) => !v);
              setPage(1);
            }}
          >
            <HelpCircle /> {natureOnly ? "Mostrar todas" : `Ver só elas (${natureAsks.length})`}
          </Button>
        </div>
      )}

      <Card className="p-0">
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4">
          <div className="relative w-full sm:w-60 sm:shrink-0">
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
          <div className="flex min-w-0 flex-1 flex-wrap gap-2 sm:justify-end">
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
            {(natureAsks.length > 0 || natureOnly) && (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={natureOnly}
                className={cn(natureOnly && "border-brand bg-accent/60")}
                onClick={() => {
                  setNatureOnly((v) => !v);
                  setPage(1);
                }}
              >
                <HelpCircle /> Pedem natureza ({natureAsks.length})
              </Button>
            )}
            {preview.batch.status === "PREVIEW" && rows.some((r) => r.nature) && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      disabled={busy || !natureTargets.length}
                      title="Define a natureza das linhas selecionadas (neste filtro e busca)"
                    >
                      <Briefcase /> Natureza{natureTargets.length ? ` (${natureTargets.length})` : ""}
                      <ChevronDown className="size-3.5 opacity-70" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      {natureTargets.length} {natureTargets.length === 1 ? "linha selecionada" : "linhas selecionadas"} · saldo e fatura não mudam
                    </DropdownMenuLabel>
                    {NATURES.map((v) => {
                      const Icon = NATURE_ICONS[v];
                      return (
                        <DropdownMenuItem key={v} onSelect={() => changeNature(natureTargets.map((r) => r.id), v)}>
                          <Icon /> {v === "PASSTHROUGH" ? "Repasse de cliente" : NATURE_LABELS[v]}
                        </DropdownMenuItem>
                      );
                    })}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => changeNature(natureTargets.map((r) => r.id), null)}>
                      <Wand2 /> Voltar à sugestão das regras
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox checked={applySimilar} onCheckedChange={(v) => setApplySimilar(v === true)} aria-label="Aplicar a natureza às linhas parecidas" />
                  Aplicar às parecidas
                </label>
              </div>
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
                    <th className="px-2 py-2.5 font-medium">Natureza</th>
                    <th className="px-4 py-2.5">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const selectable = SELECTABLE.includes(r.status);
                    const pendingAccount = blocked(r);
                    return (
                      <tr
                        key={r.id}
                        className={cn(
                          "border-b align-top last:border-0",
                          !r.selected && selectable && "bg-muted/30",
                          !selectable && "text-muted-foreground",
                          (pendingAccount || asksNature(r)) && "bg-warning/5 shadow-[inset_3px_0_0_var(--color-warning)]",
                        )}
                      >
                        <td className="px-4 py-3">
                          <Checkbox
                            checked={r.selected}
                            disabled={!isSelectable(r) || busy}
                            onCheckedChange={(v) => update.mutate([{ rowId: r.id, selected: v === true }])}
                            aria-label={`Selecionar ${r.description ?? "linha"}`}
                            title={pendingAccount ? (needsCounterpartAmount(r) ? "Informe o valor na outra moeda para importar esta linha" : "Escolha a conta do outro lado para importar esta linha") : undefined}
                          />
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 tabular">{r.date ? formatDateBR(r.date) : "—"}</td>
                        <td className="max-w-md px-2 py-3">
                          <p className="font-medium text-foreground">{r.description ?? "—"}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <KindTag row={r} />
                          </div>
                          {showMessage(r) && <p className="mt-1 text-xs text-muted-foreground">{r.message}</p>}
                          <MatchInfo row={r} currency={statementCurrency} />
                        </td>
                        <td className="whitespace-nowrap px-2 py-3 text-right">
                          <Amount cents={r.amountCents} transfer={r.kind === "TRANSFER"} currency={statementCurrency} />
                        </td>
                        <td className="px-2 py-3">
                          <RowStatusBadge status={r.status} />
                        </td>
                        <td className="w-52 px-2 py-3">
                          <RowCategory row={r} onChange={(categoryId) => update.mutate([{ rowId: r.id, categoryId }])} disabled={busy} />
                        </td>
                        <td className="w-44 px-2 py-3">
                          <RowNature row={r} editable={natureEditable(r)} onChange={(nature) => changeNature([r.id], nature)} disabled={busy} />
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
                const pendingAccount = blocked(r);
                const categoryEditable = ["NEW", "DIVERGENT"].includes(r.status) && r.kind !== "CARD_PAYMENT";
                const hasActions = ["DUPLICATE", "MATCHED", "DIVERGENT"].includes(r.status) || transferable(r);
                const natureShown = Boolean(r.nature) && (natureEditable(r) || asksNature(r));
                return (
                  <li key={r.id} className={cn("p-3 sm:p-4", !r.selected && selectable && "bg-muted/30", (pendingAccount || asksNature(r)) && "bg-warning/5 shadow-[inset_3px_0_0_var(--color-warning)]")}>
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
                          <Amount cents={r.amountCents} transfer={r.kind === "TRANSFER"} currency={statementCurrency} className="shrink-0 text-sm" />
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="tabular">{r.date ? formatDateBR(r.date) : "Sem data"}</span>
                          <RowStatusBadge status={r.status} />
                          <KindTag row={r} />
                        </div>
                        {showMessage(r) && <p className="mt-1 text-xs text-muted-foreground">{r.message}</p>}
                        <MatchInfo row={r} currency={statementCurrency} />
                        {categoryEditable || hasActions || natureShown ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {categoryEditable && (
                              <div className={cn("min-w-0", r.kind === "TRANSFER" ? "flex-1" : "flex-1 sm:w-56 sm:flex-none")}>
                                <RowCategory row={r} onChange={(categoryId) => update.mutate([{ rowId: r.id, categoryId }])} disabled={busy} />
                              </div>
                            )}
                            {natureShown && (
                              <div className="min-w-0 flex-1 sm:w-48 sm:flex-none">
                                <RowNature row={r} editable={natureEditable(r)} onChange={(nature) => changeNature([r.id], nature)} disabled={busy} />
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

      {!embedded && (
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
                  · receitas <span className="tabular">{money(inflow)}</span> · despesas <span className="tabular">{money(outflow)}</span>
                  {transfers.count > 0 && (
                    <>
                      {" "}
                      · {transfers.count} transferência(s):
                      {transfers.inflowCents > 0 && (
                        <>
                          {" "}
                          <span className="tabular">{money(transfers.inflowCents)}</span> entrando
                        </>
                      )}
                      {transfers.inflowCents > 0 && transfers.outflowCents > 0 && " e"}
                      {transfers.outflowCents > 0 && (
                        <>
                          {" "}
                          <span className="tabular">{money(transfers.outflowCents)}</span> saindo
                        </>
                      )}
                    </>
                  )}
                </span>
              )}
            </p>
            <p className="hidden text-xs text-muted-foreground sm:block">
              {toLink.length} correspondência(s) serão vinculadas sem duplicar · {toReview.length} divergência(s) viram pendências · duplicados e ignorados não entram
              {transfers.count || toConvert.length ? " · transferências entre contas próprias não contam como receita nem despesa" : ""}
              {natureCounts.business ? ` · ${natureCounts.business} como Empresa` : ""}
              {natureCounts.passthrough ? ` · ${natureCounts.passthrough} como Repasse` : ""}
              {natureCounts.ask ? ` · ${natureCounts.ask} pedem natureza` : ""}.
            </p>
          </div>
          {onContinue ? (
            <Button variant="brand" onClick={onContinue} className="shrink-0">
              <span className="sm:hidden">Continuar</span>
              <span className="hidden sm:inline">Continuar: Confirmar fatura</span> <ArrowRight />
            </Button>
          ) : (
            <Button variant="brand" onClick={() => setConfirmOpen(true)} disabled={!selected.length} loading={commit.isPending} className="shrink-0">
              <Upload /> <span className="sm:hidden">Importar</span>
              <span className="hidden sm:inline">Confirmar importação</span>
            </Button>
          )}
        </Card>
      )}

      {!embedded && !onContinue && <CommitImportDialog preview={preview} open={confirmOpen} onOpenChange={setConfirmOpen} commit={commit} saving={reviewSaving} />}

      <TransferRowsDialog open={transferOpen} onOpenChange={setTransferOpen} preview={preview} rows={transferRows} />
    </div>
  );
}
