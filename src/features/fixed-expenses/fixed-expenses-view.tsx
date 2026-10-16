"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { formatBRL } from "@/lib/money";
import { formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCards } from "@/features/finance/hooks";
import type { ReportScope } from "@/features/finance/types";
import { useCan } from "@/features/me/use-me";
import { useHousehold } from "@/features/settings/use-household";
import { SummaryTile } from "@/features/budgets/summary-tile";
import { RecurringFormDialog } from "@/features/recurring/recurring-form-dialog";
import { QuickAddDialog } from "@/features/transactions/quick-add-dialog";
import { ReportScopeSwitch } from "@/features/transactions/nature-control";
import { REPORT_SCOPE_HINTS, REPORT_SCOPE_LABELS, REPORT_SCOPE_PASSTHROUGH_NOTE } from "@/features/transactions/nature";
import { InstallmentsSection } from "./installments-section";
import { ProjectionSection, endingNote } from "./projection-section";
import { RecurringSection } from "./recurring-section";
import { useFixedExpenses } from "./use-fixed-expenses";
import type { FixedExpensesOverview } from "./types";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "novembro" */
const monthName = (m: string) => formatMonthBR(m).split(" de ")[0]!;

function ScopeControl({ value, defaultScope, onChange }: { value: ReportScope; defaultScope: ReportScope | null; onChange: (s: ReportScope) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
      <ReportScopeSwitch value={value} defaultScope={defaultScope} onChange={onChange} className="bg-transparent p-0" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="px-1.5 text-muted-foreground" aria-label="Sobre o recorte Pessoal, Empresa ou Tudo">
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          {(["PERSONAL", "BUSINESS", "ALL"] as const).map((s) => (
            <p key={s} className="mb-1">
              <strong>{REPORT_SCOPE_LABELS[s]}</strong>
              {defaultScope === s ? " (padrão da família)" : ""}: {REPORT_SCOPE_HINTS[s]}
            </p>
          ))}
          <p>{REPORT_SCOPE_PASSTHROUGH_NOTE}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function Tiles({ data }: { data: FixedExpensesOverview }) {
  const next = data.projection[1] ?? data.projection[0];
  const lastEnd = data.installments.items.reduce((m, i) => (i.endsMonth > m ? i.endsMonth : m), "");
  const cardCount = data.installments.byCard.length;
  const note = next ? endingNote(next) : null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <SummaryTile label="Contas fixas por mês" value={<span className="tabular">{formatBRL(data.recurring.monthlyTotalCents)}</span>}>
        {data.recurring.items.length
          ? `${plural(data.recurring.items.length, "conta", "contas")}${data.recurring.estimatedCount ? ` · ${data.recurring.estimatedCount} com valor estimado` : " · valores fixos"}`
          : "Nenhuma recorrência ativa"}
      </SummaryTile>
      <SummaryTile label="Parcelas na próxima fatura" value={<span className="tabular">{formatBRL(data.installments.nextInstallmentsCents)}</span>}>
        {data.installments.items.length ? `${plural(data.installments.items.length, "compra", "compras")} em ${plural(cardCount, "cartão", "cartões")}` : "Nenhuma compra parcelada"}
      </SummaryTile>
      <SummaryTile label={next ? `Comprometido em ${monthName(next.month)}` : "Próximo mês"} value={<span className="tabular">{next ? formatBRL(next.totalCents) : "—"}</span>}>
        {note ?? "Contas fixas + parcelas do mês"}
      </SummaryTile>
      <SummaryTile label="Parcelas a pagar (total)" value={<span className="tabular">{formatBRL(data.installments.totalRemainingCents)}</span>}>
        {lastEnd ? `A última termina em ${formatMonthBR(lastEnd, { short: true })}` : "Sem parcelas futuras"}
      </SummaryTile>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando gastos fixos">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}

/** Gastos fixos: contas que se repetem, parcelas nos cartões e a projeção do que já está comprometido. */
export function FixedExpensesView() {
  const household = useHousehold();
  const defaultScope = household.data?.settings.defaultReportScope ?? null;
  const [scope, setScope] = useState<ReportScope | undefined>(undefined);
  const q = useFixedExpenses(scope);
  const cards = useCards({ includeArchived: true });
  const canEditBills = useCan("bills:write");
  const canWriteTx = useCan("transactions:write");
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const data = q.data;
  const shownScope = scope ?? data?.scope ?? defaultScope;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gastos fixos"
        description={
          data
            ? `Contas que se repetem, parcelas nos cartões e o que já está comprometido · recorte ${REPORT_SCOPE_LABELS[data.scope]}${defaultScope === data.scope ? " (padrão da família)" : ""}`
            : "Contas que se repetem, parcelas nos cartões e o que já está comprometido nos próximos meses"
        }
        actions={shownScope && <ScopeControl value={shownScope} defaultScope={defaultScope} onChange={setScope} />}
      />

      {q.isLoading ? (
        <LoadingState />
      ) : q.error || !data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className={cn("space-y-6 transition-opacity", q.isFetching && "opacity-70")}>
          <Tiles data={data} />
          <RecurringSection data={data.recurring} scope={data.scope} canEdit={canEditBills} onNew={() => setRecurringOpen(true)} />
          <InstallmentsSection data={data.installments} scope={data.scope} canCreate={canWriteTx} onNewPurchase={() => setPurchaseOpen(true)} />
          <ProjectionSection projection={data.projection} cards={cards.data ?? []} />

          <section aria-labelledby="fixed-how-title" className="rounded-xl border border-dashed bg-card/50 px-4 py-3 text-xs text-muted-foreground">
            <h2 id="fixed-how-title" className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
              <Info className="size-3.5 text-brand" aria-hidden /> Como calculamos
            </h2>
            <ul className="list-disc space-y-0.5 pl-5">
              {data.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
              <li>
                Recorte {REPORT_SCOPE_LABELS[data.scope]}: {REPORT_SCOPE_HINTS[data.scope].charAt(0).toLowerCase() + REPORT_SCOPE_HINTS[data.scope].slice(1)} Saldo e faturas não mudam com o recorte.
              </li>
            </ul>
          </section>
        </div>
      )}

      <RecurringFormDialog open={recurringOpen} onOpenChange={setRecurringOpen} recurring={null} />
      <QuickAddDialog open={purchaseOpen} onOpenChange={setPurchaseOpen} />
    </div>
  );
}
