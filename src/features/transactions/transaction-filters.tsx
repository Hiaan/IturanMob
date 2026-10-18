"use client";

import { CalendarRange, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { MoneyInput } from "@/components/shared/money-input";
import { PERIOD_PRESET_LABELS, formatDateBR, type PeriodPreset } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { PAYMENT_METHOD_LABELS, TRANSACTION_SOURCE_LABELS, TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAccounts, useCards, useCategories, useMembers } from "@/features/finance/hooks";
import { CategoryPicker } from "@/features/categories/category-picker";
import type { TransactionScope } from "@/features/finance/types";
import { NON_NATURE_TYPES, SORT_LABELS, countAdvanced, listNatureScope, type TxFilters, type TxPreset, type TxSort } from "./use-transaction-filters";
import { REPORT_SCOPE_LABELS } from "./nature";
import { ReportScopeSwitch } from "./nature-control";
import { useReportScopePreference } from "./report-scope-preference";
import type { SmartToken } from "./smart-search";

const ALL = "__all__";
export const TX_PRESETS: TxPreset[] = ["today", "yesterday", "last7", "last30", "thisWeek", "thisMonth", "lastMonth", "last3Months", "last6Months", "last12Months", "thisYear", "lastYear", "all", "custom"];

export function presetLabel(p: TxPreset) {
  return p === "all" ? "Todo o período" : PERIOD_PRESET_LABELS[p as PeriodPreset];
}

/** Botão de alternância usado como "chip" (aria-pressed: estado não depende só da cor). */
function ToggleChip({ pressed, onClick, children, disabled, title }: { pressed: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        pressed ? "border-brand bg-accent text-accent-foreground" : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {pressed && <span aria-hidden>✓</span>}
      {children}
    </button>
  );
}

function toggle(list: string[] | undefined, value: string): string[] | undefined {
  const set = new Set(list ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return set.size ? [...set] : undefined;
}

export function PeriodControl({ filters, onChange, disabled }: { filters: TxFilters; onChange: (p: Partial<TxFilters>) => void; disabled?: boolean }) {
  return (
    <>
      <Select value={filters.preset} onValueChange={(v) => onChange({ preset: v as TxPreset })} disabled={disabled}>
        <SelectTrigger className="h-10 w-full justify-start sm:w-[190px] [&>svg:last-child]:ml-auto" aria-label="Período">
          <CalendarRange className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TX_PRESETS.map((p) => (
            <SelectItem key={p} value={p}>
              {presetLabel(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filters.preset === "custom" && !disabled && (
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          <Input type="date" className="h-10 min-w-0 flex-1 sm:w-[150px]" value={filters.start ?? ""} onChange={(e) => onChange({ start: e.target.value || undefined })} aria-label="Data inicial" />
          <span className="text-xs text-muted-foreground">a</span>
          <Input type="date" className="h-10 min-w-0 flex-1 sm:w-[150px]" value={filters.end ?? ""} onChange={(e) => onChange({ end: e.target.value || undefined })} aria-label="Data final" />
        </div>
      )}
    </>
  );
}

export function SortControl({ value, onChange }: { value: TxSort; onChange: (v: TxSort) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TxSort)}>
      <SelectTrigger className="h-10 w-full sm:w-[190px]" aria-label="Ordenação">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(SORT_LABELS) as TxSort[]).map((s) => (
          <SelectItem key={s} value={s}>
            {SORT_LABELS[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FiltersButton({ filters, onClick }: { filters: TxFilters; onClick: () => void }) {
  const n = countAdvanced(filters);
  return (
    <Button variant="outline" className="h-10" onClick={onClick} aria-label={n ? `Filtros (${n} ativos)` : "Filtros"}>
      <SlidersHorizontal /> Filtros
      {n > 0 && <span className="flex size-5 items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-brand-foreground tabular">{n}</span>}
    </Button>
  );
}

/** Painel com todos os filtros avançados (aplicação imediata). */
export function FiltersSheet({
  open,
  onOpenChange,
  filters,
  onChange,
  onReset,
  resultCount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filters: TxFilters;
  onChange: (p: Partial<TxFilters>) => void;
  onReset: () => void;
  resultCount?: number;
}) {
  const accounts = useAccounts({ includeArchived: true });
  const cards = useCards({ includeArchived: true });
  const members = useMembers();
  const categories = useCategories();
  const findCategoryOfSub = (subId: string) => categories.data?.find((c) => c.subcategories.some((s) => s.id === subId))?.id;
  const kind = filters.types?.length === 1 && (filters.types[0] === "EXPENSE" || filters.types[0] === "INCOME") ? (filters.types[0] as "EXPENSE" | "INCOME") : null;
  // Recorte da barra do topo (mesmo estado): Pessoa física/Empresa só mostram receitas e despesas, sem repasses.
  const pref = useReportScopePreference();
  const natureScope = listNatureScope(filters, pref.scope);
  const scopedOut = pref.scope === "PERSONAL" || pref.scope === "BUSINESS";
  const scopeLabel = pref.scope ? REPORT_SCOPE_LABELS[pref.scope] : "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Filtros</SheetTitle>
          <SheetDescription>Os filtros são aplicados na hora e ficam salvos neste navegador.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 pb-4">
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Tipo</legend>
            <div className="flex flex-wrap gap-2">
              {(["EXPENSE", "INCOME", "TRANSFER", "CARD_PAYMENT", "ADJUSTMENT"] as const).map((t) => {
                const off = Boolean(natureScope) && NON_NATURE_TYPES.includes(t);
                return (
                  <ToggleChip
                    key={t}
                    pressed={!off && Boolean(filters.types?.includes(t))}
                    disabled={off}
                    title={off ? `Não tem natureza: aparece só no recorte ${REPORT_SCOPE_LABELS.ALL}` : undefined}
                    onClick={() => onChange({ types: toggle(filters.types, t) })}
                  >
                    {TRANSACTION_TYPE_LABELS[t]}
                  </ToggleChip>
                );
              })}
            </div>
            {natureScope && (
              <p className="text-xs text-muted-foreground">
                No recorte {scopeLabel} aparecem só receitas e despesas. Transferências, pagamentos de fatura e ajustes não têm natureza.{" "}
                <button type="button" onClick={() => pref.setScope("ALL")} className="font-medium text-brand hover:underline">
                  Ver em {REPORT_SCOPE_LABELS.ALL}
                </button>
              </p>
            )}
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Situação</legend>
            <div className="flex flex-wrap gap-2">
              <ToggleChip pressed={!filters.status} onClick={() => onChange({ status: undefined })}>
                Todas
              </ToggleChip>
              <ToggleChip pressed={filters.status === "CONFIRMED"} onClick={() => onChange({ status: "CONFIRMED" })}>
                Confirmadas
              </ToggleChip>
              <ToggleChip pressed={filters.status === "PENDING"} onClick={() => onChange({ status: "PENDING" })}>
                Pendentes
              </ToggleChip>
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Recorte</legend>
            {pref.scope && (
              <ReportScopeSwitch
                value={pref.scope}
                defaultScope={pref.familyDefault}
                onChange={(s) => {
                  pref.setScope(s);
                  // Escolher um recorte volta a aplicá-lo (sai de "só desconsiderados").
                  if (filters.excluded === "only") onChange({ excluded: undefined });
                }}
                className="w-fit"
              />
            )}
            <p className="text-xs text-muted-foreground">
              É o mesmo recorte da barra no topo da página (fica lembrado e vale também no Painel, Relatórios e Gastos fixos).
              {filters.excluded === "only" ? " Agora não se aplica: a lista mostra só os desconsiderados." : filters.natureReview ? " Agora não se aplica: a lista mostra os que pedem natureza." : ""}
            </p>
            <label className="mt-1 flex items-center justify-between gap-3 text-sm">
              <span>
                Só os que pedem natureza
                <span className="block text-xs text-muted-foreground">Uma regra pediu para escolher entre Pessoal, Empresa ou Repasse.</span>
              </span>
              <Switch checked={Boolean(filters.natureReview)} onCheckedChange={(v) => onChange({ natureReview: v || undefined })} aria-label="Só os que pedem natureza" />
            </label>
            <p className="text-xs text-muted-foreground">Pessoa física e Empresa mostram só receitas e despesas, sem os repasses (veja “Desconsiderados” abaixo). A natureza só muda relatórios: saldo e fatura não mudam.</p>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Desconsiderados nos relatórios (Repasse)</legend>
            <div className="flex flex-wrap gap-2">
              {/* No recorte Pessoa física/Empresa os repasses já ficam de fora: "Mostrar" passa para Tudo; "Somente" ignora o recorte. */}
              <ToggleChip
                pressed={!filters.excluded && !scopedOut}
                onClick={() => {
                  onChange({ excluded: undefined });
                  if (scopedOut) pref.setScope("ALL");
                }}
              >
                Mostrar (padrão)
              </ToggleChip>
              <ToggleChip pressed={filters.excluded === "hide" || (scopedOut && filters.excluded !== "only")} onClick={() => onChange({ excluded: "hide" })}>
                Ocultar
              </ToggleChip>
              <ToggleChip pressed={filters.excluded === "only"} onClick={() => onChange({ excluded: "only" })}>
                Somente
              </ToggleChip>
            </div>
            <p className="text-xs text-muted-foreground">
              Repasses de clientes, reembolsos e outros valores que não são da família. Nunca entram nos totais de receitas e despesas, mas continuam no saldo e na fatura.
              {scopedOut ? ` No recorte ${scopeLabel} eles já ficam de fora; “Mostrar” passa o recorte para ${REPORT_SCOPE_LABELS.ALL}.` : ""}
            </p>
          </fieldset>

          <div className="grid gap-2">
            <Label htmlFor="flt-category" className="text-[13px]">
              Categoria
            </Label>
            <CategoryPicker
              id="flt-category"
              kind={kind}
              allowNone
              noneLabel="Todas as categorias"
              value={
                filters.subcategoryId
                  ? { categoryId: findCategoryOfSub(filters.subcategoryId) ?? "", subcategoryId: filters.subcategoryId }
                  : filters.categoryIds?.[0]
                    ? { categoryId: filters.categoryIds[0], subcategoryId: null }
                    : null
              }
              onChange={(c) => onChange({ categoryIds: c && !c.subcategoryId ? [c.categoryId] : undefined, subcategoryId: c?.subcategoryId ?? undefined, uncategorized: undefined })}
            />
            <label className="mt-1 flex items-center justify-between gap-3 text-sm">
              <span>Somente sem categoria</span>
              <Switch checked={Boolean(filters.uncategorized)} onCheckedChange={(v) => onChange({ uncategorized: v || undefined, ...(v ? { categoryIds: undefined, subcategoryId: undefined } : {}) })} />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="flt-account" className="text-[13px]">
                Conta
              </Label>
              <Select value={filters.accountId ?? ALL} onValueChange={(v) => onChange({ accountId: v === ALL ? undefined : v })}>
                <SelectTrigger id="flt-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas as contas</SelectItem>
                  {(accounts.data ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.archivedAt ? " (arquivada)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="flt-card" className="text-[13px]">
                Cartão
              </Label>
              <Select value={filters.creditCardId ?? ALL} onValueChange={(v) => onChange({ creditCardId: v === ALL ? undefined : v })}>
                <SelectTrigger id="flt-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos os cartões</SelectItem>
                  {(cards.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.archivedAt ? " (arquivado)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="flt-member" className="text-[13px]">
              Pessoa
            </Label>
            <Select value={filters.memberId ?? ALL} onValueChange={(v) => onChange({ memberId: v === ALL ? undefined : v })}>
              <SelectTrigger id="flt-member">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todas as pessoas</SelectItem>
                {(members.data ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {filters.memberId && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Papel da pessoa">
                {(
                  [
                    ["any", "Pagou ou é responsável"],
                    ["payer", "Quem pagou"],
                    ["responsible", "Responsável"],
                  ] as const
                ).map(([v, label]) => (
                  <ToggleChip key={v} pressed={(filters.personMode ?? "any") === v} onClick={() => onChange({ personMode: v })}>
                    {label}
                  </ToggleChip>
                ))}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-2" role="group" aria-label="Responsabilidade">
              <ToggleChip pressed={!filters.ownership} onClick={() => onChange({ ownership: undefined })}>
                Família e individuais
              </ToggleChip>
              <ToggleChip pressed={filters.ownership === "SHARED"} onClick={() => onChange({ ownership: "SHARED" })}>
                Só da família
              </ToggleChip>
              <ToggleChip pressed={filters.ownership === "INDIVIDUAL"} onClick={() => onChange({ ownership: "INDIVIDUAL" })}>
                Só individuais
              </ToggleChip>
            </div>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Forma de pagamento</legend>
            <div className="flex flex-wrap gap-2">
              {Object.entries(PAYMENT_METHOD_LABELS).map(([k, label]) => (
                <ToggleChip key={k} pressed={Boolean(filters.paymentMethods?.includes(k))} onClick={() => onChange({ paymentMethods: toggle(filters.paymentMethods, k) })}>
                  {label}
                </ToggleChip>
              ))}
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Origem</legend>
            <div className="flex flex-wrap gap-2">
              {Object.entries(TRANSACTION_SOURCE_LABELS).map(([k, label]) => (
                <ToggleChip key={k} pressed={Boolean(filters.sources?.includes(k))} onClick={() => onChange({ sources: toggle(filters.sources, k) })}>
                  {label}
                </ToggleChip>
              ))}
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">Faixa de valor</legend>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="flt-min" className="text-xs text-muted-foreground">
                  Mínimo
                </Label>
                <MoneyInput id="flt-min" value={filters.minAmountCents ?? 0} onChange={(v) => onChange({ minAmountCents: v > 0 ? v : undefined })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="flt-max" className="text-xs text-muted-foreground">
                  Máximo
                </Label>
                <MoneyInput id="flt-max" value={filters.maxAmountCents ?? 0} onChange={(v) => onChange({ maxAmountCents: v > 0 ? v : undefined })} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Deixe R$ 0,00 para não limitar.</p>
          </fieldset>
        </div>
        <div className="flex gap-2 border-t p-4">
          <Button variant="ghost" className="flex-1" onClick={onReset}>
            <RotateCcw /> Limpar tudo
          </Button>
          <Button variant="brand" className="flex-1" onClick={() => onOpenChange(false)}>
            {resultCount === undefined ? "Ver resultados" : `Ver ${resultCount} ${resultCount === 1 ? "resultado" : "resultados"}`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Linha de "chips" com os filtros ativos e o que a busca inteligente entendeu. */
export function ActiveFilterChips({
  filters,
  onChange,
  tokens,
  onRemoveToken,
  hidePeriod,
  natureScope = null,
}: {
  filters: TxFilters;
  onChange: (p: Partial<TxFilters>) => void;
  tokens: SmartToken[];
  onRemoveToken: (t: SmartToken) => void;
  hidePeriod?: boolean;
  /** Natureza aplicada pelo recorte da barra (o próprio recorte aparece na barra, não aqui). */
  natureScope?: TransactionScope | null;
}) {
  const accounts = useAccounts({ includeArchived: true });
  const cards = useCards({ includeArchived: true });
  const members = useMembers();
  const categories = useCategories();
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];

  if (!hidePeriod && filters.preset === "custom" && (filters.start || filters.end)) {
    chips.push({ key: "period", label: `${formatDateBR(filters.start)} a ${formatDateBR(filters.end)}`, clear: () => onChange({ preset: "thisMonth", start: undefined, end: undefined }) });
  }
  if (filters.types?.length) {
    // No recorte Pessoa física/Empresa, tipos sem natureza (transferência, fatura, ajuste) não se aplicam.
    const applied = natureScope ? filters.types.filter((t) => !NON_NATURE_TYPES.includes(t)) : filters.types;
    const label = applied.length
      ? applied.map((t) => labelOf(TRANSACTION_TYPE_LABELS, t)).join(", ")
      : `${filters.types.map((t) => labelOf(TRANSACTION_TYPE_LABELS, t)).join(", ")} (só no recorte ${REPORT_SCOPE_LABELS.ALL})`;
    chips.push({ key: "types", label, clear: () => onChange({ types: undefined }) });
  }
  if (filters.status) chips.push({ key: "status", label: filters.status === "PENDING" ? "Pendentes" : "Confirmadas", clear: () => onChange({ status: undefined }) });
  if (filters.categoryIds?.length) {
    const names = filters.categoryIds.map((id) => categories.data?.find((c) => c.id === id)?.name ?? "Categoria");
    chips.push({ key: "cat", label: `Categoria: ${names.join(", ")}`, clear: () => onChange({ categoryIds: undefined }) });
  }
  if (filters.subcategoryId) {
    const cat = categories.data?.find((c) => c.subcategories.some((s) => s.id === filters.subcategoryId));
    const sub = cat?.subcategories.find((s) => s.id === filters.subcategoryId);
    chips.push({ key: "sub", label: `Categoria: ${cat ? `${cat.name} › ${sub?.name}` : "Subcategoria"}`, clear: () => onChange({ subcategoryId: undefined }) });
  }
  if (filters.uncategorized) chips.push({ key: "unc", label: "Sem categoria", clear: () => onChange({ uncategorized: undefined }) });
  if (filters.natureReview) chips.push({ key: "natrev", label: "Pedem natureza", clear: () => onChange({ natureReview: undefined }) });
  if (filters.excluded && !(natureScope && filters.excluded === "hide"))
    chips.push({ key: "excl", label: filters.excluded === "only" ? "Só desconsiderados" : "Sem os desconsiderados", clear: () => onChange({ excluded: undefined }) });
  if (filters.accountId) chips.push({ key: "acc", label: `Conta: ${accounts.data?.find((a) => a.id === filters.accountId)?.name ?? "…"}`, clear: () => onChange({ accountId: undefined }) });
  if (filters.creditCardId) chips.push({ key: "card", label: `Cartão: ${cards.data?.find((c) => c.id === filters.creditCardId)?.name ?? "…"}`, clear: () => onChange({ creditCardId: undefined }) });
  if (filters.memberId) {
    const name = members.data?.find((m) => m.id === filters.memberId)?.displayName ?? "…";
    const role = filters.personMode === "payer" ? " (pagou)" : filters.personMode === "responsible" ? " (responsável)" : "";
    chips.push({ key: "member", label: `Pessoa: ${name}${role}`, clear: () => onChange({ memberId: undefined, personMode: undefined }) });
  }
  if (filters.ownership) chips.push({ key: "own", label: filters.ownership === "SHARED" ? "Só da família" : "Só individuais", clear: () => onChange({ ownership: undefined }) });
  if (filters.paymentMethods?.length) chips.push({ key: "pm", label: filters.paymentMethods.map((m) => labelOf(PAYMENT_METHOD_LABELS, m)).join(", "), clear: () => onChange({ paymentMethods: undefined }) });
  if (filters.sources?.length) chips.push({ key: "src", label: `Origem: ${filters.sources.map((m) => labelOf(TRANSACTION_SOURCE_LABELS, m)).join(", ")}`, clear: () => onChange({ sources: undefined }) });
  if (filters.minAmountCents != null || filters.maxAmountCents != null) {
    const label =
      filters.minAmountCents != null && filters.maxAmountCents != null
        ? `${formatBRL(filters.minAmountCents)} a ${formatBRL(filters.maxAmountCents)}`
        : filters.minAmountCents != null
          ? `A partir de ${formatBRL(filters.minAmountCents)}`
          : `Até ${formatBRL(filters.maxAmountCents)}`;
    chips.push({ key: "amount", label, clear: () => onChange({ minAmountCents: undefined, maxAmountCents: undefined }) });
  }

  if (!chips.length && !tokens.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Filtros ativos">
      {tokens.length > 0 && <span className="text-xs text-muted-foreground">Entendi:</span>}
      {tokens.map((t) => (
        <span key={`${t.kind}-${t.raw}`} className="inline-flex h-7 items-center gap-1 rounded-full border border-info/30 bg-info/10 pl-2.5 pr-1 text-xs font-medium text-info">
          {t.label}
          <button type="button" onClick={() => onRemoveToken(t)} className="rounded-full p-0.5 hover:bg-info/15" aria-label={`Remover "${t.raw}" da busca`}>
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      {tokens.length > 0 && chips.length > 0 && <SelectSeparatorInline />}
      {chips.map((c) => (
        <span key={c.key} className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border bg-card pl-2.5 pr-1 text-xs font-medium">
          <span className="truncate">{c.label}</span>
          <button type="button" onClick={c.clear} className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remover filtro ${c.label}`}>
            <X className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

function SelectSeparatorInline() {
  return <span className="mx-1 h-4 w-px bg-border" aria-hidden />;
}

