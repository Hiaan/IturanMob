"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleSlash, Globe, Info, Layers, ListChecks, Search, TriangleAlert, Upload, Wand2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { formatBRL, parseAmountToCents } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { CommitImportDialog } from "./commit-dialog";
import { useCommitImport, useResolveReviewRule, useReviewRows, useReviewSaving } from "./use-imports";
import type { ImportPreview, ImportRowDTO, ReviewDecision, ReviewRuleSuggestion } from "./types";

/**
 * "Confirmar fatura": antes da importação final, cada compra nova fica como "Importar" (padrão) ou
 * "Não importar". O total do arquivo × o que vai entrar no app fica sempre à vista. Em faturas de
 * cartão é uma etapa do fluxo; em extratos de conta, uma conferência opcional (painel lateral).
 */

const PAGE_SIZE = 60;
const MAX_MERCHANTS = 8;

/** Sem acentos e minúsculas (busca). */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Fatura no arquivo R$ A · vai entrar R$ B · diferença R$ C (N não importadas)" e o aviso, quando há diferença. */
export function ReviewTotals({ preview, warning = "always", className }: { preview: ImportPreview; warning?: "always" | "sm" | "none"; className?: string }) {
  const r = preview.review;
  const n = r.notImportedCount;
  return (
    <div className={cn("min-w-0 text-sm", className)}>
      <p aria-live="polite" className="break-words">
        <span className="font-medium">{r.scope === "CARD" ? "Fatura no arquivo" : "Saídas no arquivo"}</span> <span className="font-semibold tabular">{formatBRL(r.fileTotalCents)}</span>
        {" · "}vai entrar <span className="font-semibold tabular">{formatBRL(r.appTotalCents)}</span>
        {" · "}diferença <span className={cn("font-semibold tabular", r.differenceCents !== 0 && "text-warning")}>{formatBRL(r.differenceCents)}</span> ({n}{" "}
        {n === 1 ? "não importada" : "não importadas"})
      </p>
      {r.warning && warning !== "none" && (
        <p className={cn("mt-1 items-start gap-1.5 text-xs text-muted-foreground", warning === "sm" ? "hidden sm:flex" : "flex")}>
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0">{r.warning}</span>
        </p>
      )}
    </div>
  );
}

/** "Importar" | "Não importar" como botões de rádio grandes (toque de 44px; estado com ícone e aria-checked). */
function DecisionToggle({ row, onChange, disabled }: { row: ImportRowDTO; onChange: (d: ReviewDecision) => void; disabled: boolean }) {
  const current = row.review?.decision ?? "IMPORT";
  return (
    <div role="radiogroup" aria-label={`Importar “${row.description ?? "compra"}”?`} className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
      {(["IMPORT", "SKIP"] as const).map((d) => {
        const checked = current === d;
        const Icon = d === "IMPORT" ? CheckCircle2 : CircleSlash;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !checked && onChange(d)}
            className={cn(
              "flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
              checked ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              checked && d === "SKIP" && "text-negative ring-1 ring-negative/30",
            )}
          >
            <Icon className={cn("size-4 shrink-0", checked && d === "IMPORT" && "text-positive")} aria-hidden />
            <span className="truncate">{d === "IMPORT" ? "Importar" : "Não importar"}</span>
          </button>
        );
      })}
    </div>
  );
}

function PurchaseCard({ row, onChange, disabled }: { row: ImportRowDTO; onChange: (d: ReviewDecision) => void; disabled: boolean }) {
  const skipped = row.review?.decision === "SKIP";
  const byRule = row.review?.source === "RULE";
  const whole = row.wholePurchase;
  // Por que veio desmarcada (regra "não importar" ou parcela de compra antiga): a mensagem da prévia explica.
  const why = skipped && row.review?.source !== "MANUAL" ? row.message : null;
  return (
    <li className={cn("flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card p-3 sm:p-4", skipped && "border-dashed bg-muted/30")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("break-words font-medium", skipped && "text-muted-foreground")}>{row.description ?? "—"}</p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular">{row.date ? formatDateBR(row.date) : "Sem data"}</p>
        </div>
        <span className={cn("shrink-0 whitespace-nowrap font-semibold tabular", skipped && "text-muted-foreground line-through decoration-muted-foreground/60")}>
          <span className="sr-only">{skipped ? "Não entra: " : "Valor: "}</span>
          {formatBRL(Math.abs(row.amountCents ?? 0))}
        </span>
      </div>
      {(whole || row.flags.international || byRule) && (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {whole && (
            <Badge variant="info" className="h-auto whitespace-normal text-left leading-snug">
              <Layers aria-hidden /> Parcelada — a escolha vale para a compra inteira ({whole.installments} parcelas, total {formatBRL(whole.totalCents)})
            </Badge>
          )}
          {row.flags.international && (
            <Badge variant="outline">
              <Globe aria-hidden /> Internacional/IOF
            </Badge>
          )}
          {byRule && (
            <Badge variant="brand" title={row.message ?? "Desmarcada por uma regra “não importar”"}>
              <Wand2 aria-hidden /> Regra
            </Badge>
          )}
        </div>
      )}
      {why && <p className="break-words text-xs text-muted-foreground">{why}</p>}
      <DecisionToggle row={row} onChange={onChange} disabled={disabled} />
    </li>
  );
}

function SuggestionBanner({ s, card, onResolve, pending }: { s: ReviewRuleSuggestion; card: boolean; onResolve: (accept: boolean) => void; pending: boolean | null }) {
  return (
    <div role="note" className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-accent/40 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
      <div className="flex min-w-0 items-start gap-2 text-sm">
        <Wand2 className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0">
          <p className="break-words font-medium">{s.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            “Não importar” já foi marcado {s.timesMarked} vezes em {card ? "compras" : "saídas"} parecidas. Com a regra, as próximas já vêm desmarcadas
            {s.alsoApplies > 0 ? ` — e ${plural(s.alsoApplies, "outra deste arquivo também", "outras deste arquivo também")}` : ""}.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" size="sm" onClick={() => onResolve(false)} loading={pending === false} disabled={pending !== null}>
          Agora não
        </Button>
        <Button variant="brand" size="sm" onClick={() => onResolve(true)} loading={pending === true} disabled={pending !== null}>
          <Wand2 /> Criar regra
        </Button>
      </div>
    </div>
  );
}

/** Botão de filtro rápido (liga/desliga). */
function FilterChip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
        active ? "border-brand bg-accent text-accent-foreground" : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {active && <Check className="size-3.5 shrink-0" aria-hidden />}
      {children}
    </button>
  );
}

/**
 * Lista das compras novas (cartões, sem tabela larga) com busca, filtros rápidos, sugestões de regra
 * e a escolha "Importar" / "Não importar". Os filtros só mudam o que aparece.
 */
export function StatementCheckPanel({ preview, inSheet = false }: { preview: ImportPreview; inSheet?: boolean }) {
  const card = preview.review.scope === "CARD";
  const editable = preview.batch.status === "PREVIEW";
  const review = useReviewRows(preview.batch.id);
  const resolve = useResolveReviewRule(preview.batch.id);
  const [search, setSearch] = useState("");
  const [minText, setMinText] = useState("");
  const [merchant, setMerchant] = useState<string | null>(null);
  const [installmentsOnly, setInstallmentsOnly] = useState(false);
  const [internationalOnly, setInternationalOnly] = useState(false);
  const [skippedOnly, setSkippedOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const purchases = useMemo(() => preview.rows.filter((r) => r.review !== null), [preview.rows]);
  const merchants = useMemo(() => {
    const byLabel = new Map<string, { count: number; cents: number }>();
    for (const r of purchases) {
      const label = r.merchantLabel.trim();
      if (!label) continue;
      const cur = byLabel.get(label) ?? { count: 0, cents: 0 };
      byLabel.set(label, { count: cur.count + 1, cents: cur.cents + Math.abs(r.amountCents ?? 0) });
    }
    return [...byLabel]
      .sort((a, b) => b[1].count - a[1].count || b[1].cents - a[1].cents)
      .slice(0, MAX_MERCHANTS)
      .map(([label, v]) => ({ label, count: v.count }));
  }, [purchases]);
  const installmentCount = purchases.filter((r) => r.flags.installment).length;
  const internationalCount = purchases.filter((r) => r.flags.international).length;
  const skippedCount = purchases.filter((r) => r.review?.decision === "SKIP").length;

  const minCents = minText.trim() ? parseAmountToCents(minText) : null;
  const minInvalid = Boolean(minText.trim()) && minCents === null;
  const filtering = Boolean(search.trim()) || minCents !== null || merchant !== null || installmentsOnly || internationalOnly || skippedOnly;
  const filtered = useMemo(() => {
    const term = fold(search.trim());
    const min = minCents === null ? null : Math.abs(minCents);
    return purchases.filter(
      (r) =>
        (!term || fold(`${r.description ?? ""} ${r.merchantLabel}`).includes(term)) &&
        (min === null || Math.abs(r.amountCents ?? 0) > min) &&
        (merchant === null || r.merchantLabel.trim() === merchant) &&
        (!installmentsOnly || r.flags.installment) &&
        (!internationalOnly || r.flags.international) &&
        (!skippedOnly || r.review?.decision === "SKIP"),
    );
  }, [purchases, search, minCents, merchant, installmentsOnly, internationalOnly, skippedOnly]);
  const visible = filtered.slice(0, limit);
  const filteredToSkip = filtered.filter((r) => r.review?.decision === "IMPORT");
  const filteredToImport = filtered.filter((r) => r.review?.decision === "SKIP");

  // Qualquer mudança de filtro volta para a primeira página.
  const withReset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setLimit(PAGE_SIZE);
    };
  const clearFilters = () => {
    setSearch("");
    setMinText("");
    setMerchant(null);
    setInstallmentsOnly(false);
    setInternationalOnly(false);
    setSkippedOnly(false);
    setLimit(PAGE_SIZE);
  };
  const decide = (rows: ImportRowDTO[], decision: ReviewDecision) => {
    if (rows.length) review.mutate(rows.map((r) => ({ rowId: r.id, decision })));
  };
  const noun = card ? "compra" : "saída";
  const nouns = card ? "compras" : "saídas";
  const r = preview.review;

  const header = (
    <div className={cn(!inSheet && "rounded-xl border bg-card p-4 shadow-card sm:p-5")}>
      <h2 className="text-[15px] font-semibold">{card ? "Alguma dessas compras não é sua ou está errada?" : "Alguma dessas saídas não é sua ou está errada?"}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Marque “Não importar” no que não deve entrar no app; o resto entra normalmente. O total {card ? "da fatura" : "das saídas"} e a diferença para o arquivo ficam sempre à vista.
      </p>
      {r.ignoredCredits.count > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Pagamentos e créditos da fatura (<span className="tabular">{formatBRL(r.ignoredCredits.cents)}</span>) não entram na conferência.
          </span>
        </p>
      )}
      {/* No celular, o aviso fica aqui (a barra fixa mostra só os totais). */}
      {r.warning && !inSheet && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground sm:hidden">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0">{r.warning}</span>
        </p>
      )}
    </div>
  );

  if (!purchases.length) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon={ListChecks}
          title={card ? "Nenhuma compra nova para conferir" : "Nenhuma saída nova para conferir"}
          description={`As ${nouns} deste arquivo já estavam no app, são repetidas ou foram ignoradas. O que for vinculado ou criado aparece na revisão.`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}

      {editable &&
        r.suggestions.map((s) => (
          <SuggestionBanner
            key={s.key}
            s={s}
            card={card}
            onResolve={(accept) => resolve.mutate({ key: s.key, accept })}
            pending={resolve.isPending && resolve.variables?.key === s.key ? resolve.variables.accept : null}
          />
        ))}

      <div className={cn("space-y-3", !inSheet && "rounded-xl border bg-card p-3 shadow-card sm:p-4")}>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => withReset(setSearch)(e.target.value)} placeholder="Buscar por descrição ou estabelecimento" className="pl-9" aria-label={`Buscar ${nouns}`} />
          </div>
          <label
            className={cn(
              "flex h-10 min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-3 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
              minInvalid && "border-destructive",
            )}
          >
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">Valor acima de R$</span>
            <input
              value={minText}
              onChange={(e) => withReset(setMinText)(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              aria-invalid={minInvalid || undefined}
              className="w-full min-w-0 bg-transparent text-right text-sm outline-none tabular placeholder:text-muted-foreground/70"
            />
          </label>
        </div>

        {merchants.length > 1 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar por estabelecimento">
            <span className="text-xs text-muted-foreground">Estabelecimento:</span>
            {merchants.map((m) => (
              <FilterChip key={m.label} active={merchant === m.label} onClick={() => withReset(setMerchant)(merchant === m.label ? null : m.label)}>
                <span className="min-w-0 truncate">{m.label}</span>
                {m.count > 1 && <span className="shrink-0 tabular opacity-70">{m.count}</span>}
              </FilterChip>
            ))}
          </div>
        )}

        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Filtros rápidos">
          {installmentCount > 0 && (
            <FilterChip active={installmentsOnly} onClick={() => withReset(setInstallmentsOnly)(!installmentsOnly)}>
              <Layers className="size-3.5 shrink-0" aria-hidden /> Só parceladas ({installmentCount})
            </FilterChip>
          )}
          {internationalCount > 0 && (
            <FilterChip active={internationalOnly} onClick={() => withReset(setInternationalOnly)(!internationalOnly)}>
              <Globe className="size-3.5 shrink-0" aria-hidden /> Só internacionais/IOF ({internationalCount})
            </FilterChip>
          )}
          {skippedCount > 0 && (
            <FilterChip active={skippedOnly} onClick={() => withReset(setSkippedOnly)(!skippedOnly)}>
              <CircleSlash className="size-3.5 shrink-0" aria-hidden /> Só “Não importar” ({skippedCount})
            </FilterChip>
          )}
          {filtering && (
            <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
              <X /> Limpar filtros
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {filtering ? `${filtered.length} de ${plural(purchases.length, noun, nouns)}` : plural(purchases.length, `${noun} nova`, `${nouns} novas`)}
            {skippedCount > 0 && !skippedOnly ? ` · ${skippedCount} com “Não importar”` : ""}
          </p>
          {filtering && editable && (filteredToSkip.length > 0 || filteredToImport.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {filteredToSkip.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => decide(filteredToSkip, "SKIP")}>
                  <CircleSlash /> Não importar as filtradas ({filteredToSkip.length})
                </Button>
              )}
              {filteredToImport.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => decide(filteredToImport, "IMPORT")}>
                  <CheckCircle2 /> Importar as filtradas ({filteredToImport.length})
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {!visible.length ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhuma {noun} com esses filtros.</p>
      ) : (
        <ul className={cn("grid gap-2 sm:gap-3", !inSheet && "lg:grid-cols-2")} aria-label={`${card ? "Compras" : "Saídas"} para conferir`}>
          {visible.map((row) => (
            <PurchaseCard key={row.id} row={row} disabled={!editable} onChange={(d) => decide([row], d)} />
          ))}
        </ul>
      )}
      {filtered.length > visible.length && (
        <Button variant="outline" className="w-full" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
          Mostrar mais ({filtered.length - visible.length})
        </Button>
      )}
    </div>
  );
}

/** Etapa "Confirmar fatura" (cartão): a conferência e, na barra fixa, os totais e a importação final. */
export function ConfirmStatementStep({ preview, onBack, onCommitted }: { preview: ImportPreview; onBack: () => void; onCommitted?: (data: ImportPreview) => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const commit = useCommitImport(preview.batch.id, onCommitted);
  // Espera as escolhas em andamento chegarem ao servidor antes de importar.
  const saving = useReviewSaving(preview.batch.id);
  const canCommit = preview.rows.some((r) => r.selected);
  return (
    <div className="space-y-4">
      <StatementCheckPanel preview={preview} />
      <Card
        role="region"
        aria-label="Totais da conferência"
        className="sticky bottom-20 z-10 flex flex-col gap-3 border-brand/30 p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between sm:p-4 lg:bottom-4"
      >
        <ReviewTotals preview={preview} warning="sm" />
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={onBack} className="flex-1 sm:flex-none">
            <ArrowLeft /> Voltar
          </Button>
          <Button
            variant="brand"
            onClick={() => setConfirmOpen(true)}
            disabled={!canCommit || saving}
            loading={commit.isPending}
            className="flex-1 sm:flex-none"
            title={!canCommit ? "Nada selecionado para importar" : saving ? "Salvando as escolhas…" : undefined}
          >
            <Upload /> Importar
          </Button>
        </div>
      </Card>
      <CommitImportDialog preview={preview} open={confirmOpen} onOpenChange={setConfirmOpen} commit={commit} saving={saving} />
    </div>
  );
}

/** Extrato de conta: conferência opcional das saídas (mesmo painel), antes de confirmar na revisão. */
export function AccountCheckSheet({ preview, open, onOpenChange }: { preview: ImportPreview; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 sm:max-w-xl">
        <SheetHeader className="pb-4">
          <SheetTitle>Conferir saídas antes de importar</SheetTitle>
          <SheetDescription>As escolhas valem para esta importação. Depois, confirme a importação na revisão.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
          <StatementCheckPanel preview={preview} inSheet />
        </div>
        <div role="region" aria-label="Totais da conferência" className="flex flex-col gap-3 border-t p-4 sm:px-5">
          <ReviewTotals preview={preview} />
          <Button variant="brand" onClick={() => onOpenChange(false)}>
            <Check /> Concluir conferência
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
