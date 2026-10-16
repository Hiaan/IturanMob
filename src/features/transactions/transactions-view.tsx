"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, ChevronLeft, ChevronRight, EyeOff, Info, List, Plus, Scale, SearchX, Search, Trash2, TrendingDown, TrendingUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { describePeriod, todayISO } from "@/lib/dates";
import { formatBRL, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useCards, useCategories, useMembers } from "@/features/finance/hooks";
import { useCan, useMe } from "@/features/me/use-me";
import type { TransactionDTO, TransactionList as TxListResponse } from "@/features/finance/types";
import { QuickAddDialog } from "./quick-add-dialog";
import { parseSmartSearch, removeToken, type SmartToken } from "./smart-search";
import { URL_FILTER_KEYS, buildListParams, countAdvanced, effectivePeriod, filtersFromUrl, useDebounced, usePersistentTxFilters } from "./use-transaction-filters";
import { ActiveFilterChips, FiltersButton, FiltersSheet, PeriodControl, SortControl, presetLabel } from "./transaction-filters";
import { TransactionList, type RowAction } from "./transaction-list";
import { TransactionDetailSheet } from "./transaction-detail-sheet";
import { BulkBar, BulkReclassifyDialog } from "./bulk-actions";
import { ConvertTransferDialog } from "./convert-transfer-dialog";
import { DeleteTransactionsDialog, PurgeTransactionsDialog } from "./confirm-dialogs";
import { useTransactionActions } from "./use-transaction-actions";
import { ReportExclusionDialog } from "./report-exclusion-dialog";
import { EXCLUSION_KEEPS_BALANCE, useReportExclusion } from "./report-exclusion";
import { PassthroughCard } from "./passthrough-card";

const PAGE_SIZE = 50;

function TotalTile({ label, value, icon: Icon, tone, hint, signed }: { label: string; value: number | string; icon: typeof TrendingUp; tone?: "positive" | "negative" | "neutral"; hint?: string; signed?: boolean }) {
  return (
    <Card className="flex items-center gap-3 p-3 sm:p-4" title={hint}>
      <span className={cn("hidden size-9 shrink-0 items-center justify-center rounded-xl sm:flex", tone === "positive" ? "bg-positive/10 text-positive" : tone === "negative" ? "bg-negative/10 text-negative" : "bg-muted text-muted-foreground")}>
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn("truncate text-[15px] font-semibold tabular sm:text-lg", typeof value === "number" && value < 0 && "text-negative")}>
          {typeof value === "number" ? formatBRL(value, { signed }) : value}
        </p>
      </div>
    </Card>
  );
}

function ListSkeleton() {
  return (
    <Card className="divide-y" aria-busy="true" aria-label="Carregando lançamentos">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <Skeleton className="size-9 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </Card>
  );
}

export function TransactionsView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const canWrite = useCan("transactions:write");
  const canDelete = useCan("transactions:delete");
  const members = useMembers();
  const categories = useCategories();
  const cards = useCards({ includeArchived: true });
  const actions = useTransactionActions();
  const exclusion = useReportExclusion();

  const { filters, update, reset, loaded, init } = usePersistentTxFilters();
  const [view, setView] = useState<"list" | "trash">("list");
  const [searchText, setSearchText] = useState("");
  const debounced = useDebounced(searchText.trim(), 300);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [reclassifyOpen, setReclassifyOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [toDelete, setToDelete] = useState<{ items: TransactionDTO[]; bulk: boolean } | null>(null);
  const [toPurge, setToPurge] = useState<TransactionDTO[] | null>(null);
  /** Lançamentos no diálogo "Desconsiderar nos relatórios" (um, pela linha, ou a seleção). */
  const [toExclude, setToExclude] = useState<{ items: TransactionDTO[]; bulk: boolean }>({ items: [], bulk: false });
  const [excludeOpen, setExcludeOpen] = useState(false);
  const openExclude = (items: TransactionDTO[], bulk: boolean) => {
    setToExclude({ items, bulk });
    setExcludeOpen(true);
  };

  // --- URL: filtros vindos de links (?categoryId=, ?type=, ?accountId=…) e detalhe (?id=) ---
  // history.replaceState é integrado ao roteador do Next (sem ida ao servidor).
  const replaceUrl = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(searchParams.toString());
      mutate(p);
      const qs = p.toString();
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, searchParams],
  );
  const initialized = useRef(false);
  const spKey = searchParams.toString();
  useEffect(() => {
    const sp = new URLSearchParams(spKey);
    const patch = filtersFromUrl(sp);
    if (!initialized.current || patch) {
      initialized.current = true;
      init(patch);
    }
    if (patch) {
      setView("list");
      setSearchText("");
      replaceUrl((p) => URL_FILTER_KEYS.forEach((k) => p.delete(k)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spKey]);
  const detailId = searchParams.get("id");
  const openDetail = (id: string) => replaceUrl((p) => p.set("id", id));
  const closeDetail = () => replaceUrl((p) => p.delete("id"));

  // --- Busca inteligente + parâmetros da consulta ---
  const smart = useMemo(
    () => parseSmartSearch(debounced, today, { members: (members.data ?? []).filter((m) => m.isActive), categories: categories.data ?? [] }),
    [debounced, today, members.data, categories.data],
  );
  const baseParams = useMemo(() => {
    if (view === "trash") return { ...buildListParams({ preset: "all", sort: filters.sort }, today, smart, 1, PAGE_SIZE), deleted: "only" };
    return buildListParams(filters, today, smart, 1, PAGE_SIZE);
  }, [view, filters, today, smart]);
  const baseKey = JSON.stringify(baseParams);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [baseKey]);
  const params = { ...baseParams, page };

  const list = useQuery({
    queryKey: qk.transactions(params),
    queryFn: () => api.get<TxListResponse>("/api/v1/transactions", params),
    enabled: loaded,
    placeholderData: keepPreviousData,
  });
  const trashCount = useQuery({
    queryKey: qk.transactions({ deleted: "only", pageSize: 1, countOnly: true }),
    queryFn: () => api.get<TxListResponse>("/api/v1/transactions", { deleted: "only", pageSize: 1 }),
    enabled: canDelete,
  });

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const selectedItems = items.filter((t) => selected.has(t.id));
  useEffect(() => {
    // Remove da seleção itens que saíram da página (ex.: após exclusão).
    setSelected((prev) => {
      const ids = new Set(items.map((t) => t.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (checked: boolean) => setSelected(checked ? new Set(items.map((t) => t.id)) : new Set());

  const onRowAction = (a: RowAction, tx: TransactionDTO) => {
    if (a === "open") openDetail(tx.id);
    else if (a === "confirm") actions.confirm.mutate(tx.id);
    else if (a === "delete") setToDelete({ items: [tx], bulk: false });
    else if (a === "restore") actions.restore.mutate(tx.id);
    else if (a === "purge") setToPurge([tx]);
    else if (a === "exclude") openExclude([tx], false);
    else if (a === "include") exclusion.mutate({ transactionIds: [tx.id], excluded: false });
  };

  const onRemoveToken = (t: SmartToken) => setSearchText((s) => removeToken(s, t.raw));
  const period = view === "list" ? effectivePeriod(filters, today) : null;
  const smartPeriod = smart.patch.start && smart.patch.end ? { start: smart.patch.start, end: smart.patch.end } : null;
  const shownPeriod = smartPeriod ?? period;
  const hasAnyFilter = Boolean(debounced) || (view === "list" && (countAdvanced(filters) > 0 || filters.preset !== "thisMonth"));
  const totals = list.data?.totals;
  const total = list.data?.total ?? 0;
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, total);
  const grouped = filters.sort === "date_desc" || filters.sort === "date_asc";
  const busy = actions.bulk.isPending || actions.purge.isPending || exclusion.isPending;
  const onlyExcluded = view === "list" && filters.excluded === "only";
  const excludedIn = totals?.excludedIncomeCents ?? 0;
  const excludedOut = totals?.excludedExpenseCents ?? 0;
  const showExcludedTotals = view === "list" && !onlyExcluded && (excludedIn > 0 || excludedOut > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Transações"
        description={
          view === "trash"
            ? "Lançamentos excluídos — restaure ou exclua definitivamente."
            : shownPeriod
              ? `${describePeriod(shownPeriod)}${smartPeriod ? " (pela busca)" : filters.preset !== "custom" ? ` · ${presetLabel(filters.preset).toLowerCase()}` : ""}`
              : "Todo o período"
        }
        actions={
          canWrite && (
            <Button variant="brand" onClick={() => setNewOpen(true)}>
              <Plus /> Novo lançamento
            </Button>
          )
        }
      />

      <Tabs value={view} onValueChange={(v) => setView(v as "list" | "trash")}>
        <TabsList>
          <TabsTrigger value="list">
            <List /> Lançamentos
          </TabsTrigger>
          {canDelete && (
            <TabsTrigger value="trash">
              <Trash2 /> Lixeira
              {(trashCount.data?.total ?? 0) > 0 && <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] tabular">{trashCount.data?.total}</span>}
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      <div className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <div className="relative min-w-0 md:min-w-[280px] md:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Buscar: mercado pix, acima de 100, ontem, um nome…"
              aria-label="Busca inteligente: texto, valor, data, pessoa, categoria, estabelecimento ou forma de pagamento"
              className="pl-9 pr-16 [&::-webkit-search-cancel-button]:hidden"
              maxLength={160}
            />
            <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
              {searchText && (
                <button type="button" onClick={() => setSearchText("")} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Limpar busca">
                  <X className="size-4" />
                </button>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Como usar a busca inteligente">
                    <Info className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Combine termos livremente: descrição ou estabelecimento (&quot;ifood&quot;), valor (&quot;R$ 50&quot;, &quot;acima de 100&quot;, &quot;entre 50 e 80&quot;), data (&quot;15/10&quot;, &quot;ontem&quot;, &quot;outubro&quot;), pessoa (nome),
                  categoria (&quot;supermercado&quot;), forma de pagamento (&quot;pix&quot;, &quot;débito&quot;) e origem (&quot;áudio&quot;, &quot;comprovante&quot;).
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          {view === "list" && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <PeriodControl filters={filters} onChange={update} />
            </div>
          )}
          <div className="flex gap-2">
            {view === "list" && <FiltersButton filters={filters} onClick={() => setFiltersOpen(true)} />}
            <div className="min-w-0 flex-1 md:flex-none">
              <SortControl value={filters.sort} onChange={(sort) => update({ sort })} />
            </div>
          </div>
        </div>
        {view === "list" ? (
          <ActiveFilterChips filters={filters} onChange={update} tokens={smart.tokens} onRemoveToken={onRemoveToken} />
        ) : (
          <ActiveFilterChips filters={{ preset: "all", sort: filters.sort }} onChange={() => undefined} tokens={smart.tokens} onRemoveToken={onRemoveToken} />
        )}
      </div>

      {view === "list" && (
        <div className={cn("grid grid-cols-2 gap-3 xl:grid-cols-4", list.isFetching && !list.isLoading && "opacity-70 transition-opacity")}>
          {list.isLoading || !totals ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)
          ) : onlyExcluded ? (
            <>
              <TotalTile label="Entradas desconsideradas" value={excludedIn} icon={TrendingUp} tone="positive" hint={`Receitas confirmadas desconsideradas nos relatórios. ${EXCLUSION_KEEPS_BALANCE}`} />
              <TotalTile label="Saídas desconsideradas" value={excludedOut} icon={TrendingDown} tone="negative" hint={`Despesas confirmadas desconsideradas nos relatórios. ${EXCLUSION_KEEPS_BALANCE}`} />
              <TotalTile label="Diferença" value={excludedIn - excludedOut} icon={Scale} signed hint="Entradas menos saídas desconsideradas (fora dos relatórios)." />
              <TotalTile label="Lançamentos" value={total.toLocaleString("pt-BR")} icon={EyeOff} hint="Lançamentos desconsiderados encontrados (inclui pendentes)" />
            </>
          ) : (
            <>
              <TotalTile label="Receitas" value={totals.incomeCents} icon={TrendingUp} tone="positive" hint="Receitas confirmadas que atendem aos filtros (sem as desconsideradas nos relatórios)" />
              <TotalTile label="Despesas" value={totals.expenseCents} icon={TrendingDown} tone="negative" hint="Despesas confirmadas que atendem aos filtros (compras no cartão pelo valor total; sem as desconsideradas nos relatórios)" />
              <TotalTile label="Resultado" value={totals.incomeCents - totals.expenseCents} icon={Scale} signed hint="Receitas menos despesas. Transferências e pagamentos de fatura não entram no cálculo." />
              <TotalTile label="Lançamentos" value={total.toLocaleString("pt-BR")} icon={ArrowLeftRight} hint="Total de lançamentos encontrados (inclui pendentes)" />
            </>
          )}
        </div>
      )}
      {view === "list" && totals && (totals.transferCents > 0 || totals.cardPaymentCents > 0 || showExcludedTotals) && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Totais consideram apenas lançamentos confirmados.
          {totals.transferCents > 0 && ` Transferências: ${formatBRL(totals.transferCents)}.`}
          {totals.cardPaymentCents > 0 && ` Pagamentos de fatura: ${formatBRL(totals.cardPaymentCents)} (não contam como despesa).`}
          {showExcludedTotals && (
            <>
              {" "}
              <span className="font-medium text-foreground/80">
                Desconsiderados:{" "}
                <span className="tabular">
                  {excludedIn > 0 && `+${formatBRL(excludedIn)}`}
                  {excludedIn > 0 && excludedOut > 0 && " / "}
                  {excludedOut > 0 && `−${formatBRL(excludedOut)}`}
                </span>
              </span>{" "}
              (fora dos relatórios; continuam no saldo e na fatura).{" "}
              <button type="button" onClick={() => update({ excluded: "only" })} className="font-medium text-brand hover:underline">
                Ver só eles
              </button>
            </>
          )}
        </p>
      )}
      {onlyExcluded && <PassthroughCard period={shownPeriod} showListLink={false} />}

      {list.isLoading || !loaded ? (
        <ListSkeleton />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        view === "trash" ? (
          <EmptyState icon={Trash2} title={debounced ? "Nada encontrado na lixeira" : "A lixeira está vazia"} description="Lançamentos excluídos aparecem aqui e podem ser restaurados." />
        ) : onlyExcluded && !debounced ? (
          <EmptyState
            icon={EyeOff}
            title="Nenhum lançamento desconsiderado no período"
            description="Abra um lançamento e use “Desconsiderar nos relatórios” para tirar repasses de clientes e reembolsos das receitas e despesas. O saldo e a fatura não mudam."
            action={
              <Button variant="outline" onClick={() => update({ excluded: undefined })}>
                Mostrar todos os lançamentos
              </Button>
            }
          />
        ) : hasAnyFilter ? (
          <EmptyState
            icon={SearchX}
            title="Nenhum lançamento encontrado"
            description="Ajuste a busca, o período ou os filtros para ver mais resultados."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setSearchText("");
                  reset();
                }}
              >
                Limpar busca e filtros
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={ArrowLeftRight}
            title="Nenhum lançamento no período"
            description="Registre pelo botão abaixo, pelo WhatsApp ou importe um extrato."
            action={
              canWrite && (
                <Button variant="brand" onClick={() => setNewOpen(true)}>
                  <Plus /> Novo lançamento
                </Button>
              )
            }
          />
        )
      ) : (
        <div className={cn("transition-opacity", list.isFetching && "opacity-70")}>
          <TransactionList
            items={items}
            grouped={grouped}
            trash={view === "trash"}
            today={today}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onAction={onRowAction}
            cards={cards.data ?? []}
            canWrite={canWrite}
            canDelete={canDelete}
            accountId={view === "list" ? filters.accountId : undefined}
          />
        </div>
      )}

      {total > 0 && (
        <nav className="flex flex-col items-center justify-between gap-3 pb-2 sm:flex-row" aria-label="Paginação">
          <p className="text-sm text-muted-foreground tabular">
            {from}–{to} de {total.toLocaleString("pt-BR")} {total === 1 ? "lançamento" : "lançamentos"}
          </p>
          {total > PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || list.isFetching}>
                <ChevronLeft /> Anterior
              </Button>
              <span className="text-sm tabular">
                Página {page} de {Math.ceil(total / PAGE_SIZE)}
              </span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={to >= total || list.isFetching}>
                Próxima <ChevronRight />
              </Button>
            </div>
          )}
        </nav>
      )}
      {selectedItems.length > 0 && <div className="h-24" aria-hidden />}

      <BulkBar
        items={selectedItems}
        trash={view === "trash"}
        busy={busy}
        canWrite={canWrite}
        canDelete={canDelete}
        onClear={() => setSelected(new Set())}
        onReclassify={() => setReclassifyOpen(true)}
        onConvertTransfer={() => setConvertOpen(true)}
        onExclude={() => openExclude(selectedItems, true)}
        onInclude={() =>
          exclusion.mutate(
            { transactionIds: selectedItems.filter((t) => t.excludedFromReports).map((t) => t.id), excluded: false },
            { onSuccess: () => setSelected(new Set()) },
          )
        }
        onConfirm={() =>
          actions.bulk.mutate({ action: "confirm", ids: selectedItems.filter((t) => t.status === "PENDING").map((t) => t.id) }, { onSuccess: () => setSelected(new Set()) })
        }
        onDelete={() => setToDelete({ items: selectedItems, bulk: true })}
        onRestore={() => actions.bulk.mutate({ action: "restore", ids: selectedItems.map((t) => t.id) }, { onSuccess: () => setSelected(new Set()) })}
        onPurge={() => setToPurge(selectedItems)}
      />

      <FiltersSheet open={filtersOpen} onOpenChange={setFiltersOpen} filters={filters} onChange={update} onReset={reset} resultCount={list.data?.total} />
      <BulkReclassifyDialog
        open={reclassifyOpen}
        onOpenChange={setReclassifyOpen}
        items={selectedItems}
        loading={actions.bulk.isPending}
        onSubmit={(ids, c) =>
          actions.bulk.mutate(
            { action: "reclassify", ids, categoryId: c.categoryId, subcategoryId: c.subcategoryId },
            {
              onSuccess: () => {
                setReclassifyOpen(false);
                setSelected(new Set());
              },
            },
          )
        }
      />
      <ReportExclusionDialog open={excludeOpen} onOpenChange={setExcludeOpen} items={toExclude.items} onDone={() => toExclude.bulk && setSelected(new Set())} />
      <ConvertTransferDialog open={convertOpen} onOpenChange={setConvertOpen} items={selectedItems} lookup={items} onDone={() => setSelected(new Set())} />
      <DeleteTransactionsDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        count={toDelete?.items.length ?? 0}
        description={toDelete?.items.length === 1 ? `${toDelete.items[0]?.description} (${formatMoney(toDelete.items[0]?.amountCents, toDelete.items[0]?.currency)})` : undefined}
        loading={actions.remove.isPending || actions.bulk.isPending}
        onConfirm={() => {
          if (!toDelete) return;
          const ids = toDelete.items.map((t) => t.id);
          const close = () => {
            setToDelete(null);
            setSelected(new Set());
          };
          if (toDelete.bulk) actions.bulk.mutate({ action: "delete", ids }, { onSuccess: close });
          else actions.remove.mutate(ids[0]!, { onSuccess: close });
        }}
      />
      <PurgeTransactionsDialog
        open={Boolean(toPurge)}
        onOpenChange={(o) => !o && setToPurge(null)}
        count={toPurge?.length ?? 0}
        loading={actions.purge.isPending}
        onConfirm={() =>
          toPurge &&
          actions.purge.mutate(
            toPurge.map((t) => t.id),
            {
              onSuccess: () => {
                setToPurge(null);
                setSelected(new Set());
              },
            },
          )
        }
      />
      <TransactionDetailSheet id={detailId} onClose={closeDetail} />
      <QuickAddDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
