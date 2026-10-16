"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Banknote, EyeOff, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import { addDays, formatDateBR, formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { BusinessBadge } from "@/features/transactions/nature-control";
import { CategorySummary, NatureBreakdown, sliceKey } from "./category-summary";
import { StatementStatusBadge } from "./statement-status";
import type { StatementDetail } from "./types";
import type { PayTarget } from "./pay-statement-dialog";

function Metric({ label, value, tone }: { label: string; value: number; tone?: "positive" | "warning" }) {
  return (
    <div className="min-w-0 rounded-xl border p-2.5 sm:p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("whitespace-nowrap text-sm font-semibold tabular sm:text-base", tone === "positive" && "text-positive", tone === "warning" && value > 0 && "text-warning")}>{formatBRL(value)}</p>
    </div>
  );
}

/** Detalhe de uma fatura: parcelas, pagamentos e ação de pagar. */
export function StatementSheet({ statementId, onClose, onPay, canPay }: { statementId: string | null; onClose: () => void; onPay: (t: PayTarget) => void; canPay: boolean }) {
  const q = useQuery({
    queryKey: qk.statement(statementId ?? "none"),
    queryFn: () => api.get<StatementDetail>(`/api/v1/statements/${statementId}`),
    enabled: Boolean(statementId),
  });
  const st = q.data;
  /** Filtro das linhas por categoria ("none" = sem categoria). */
  const [category, setCategory] = useState<string | null>(null);
  useEffect(() => setCategory(null), [statementId]);
  const byCategory = st?.byCategory ?? [];
  const lines = st ? (category ? st.installments.filter((i) => (i.categoryId ?? "none") === category) : st.installments) : [];
  const activeCategory = byCategory.find((c) => sliceKey(c) === category) ?? null;

  return (
    <Sheet open={Boolean(statementId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 sm:max-w-xl">
        {q.isLoading || (!st && !q.error) ? (
          <>
            <SheetHeader className="pb-4">
              <SheetTitle>Carregando fatura…</SheetTitle>
              <SheetDescription className="sr-only">Aguarde o carregamento da fatura.</SheetDescription>
            </SheetHeader>
            <div className="space-y-3 px-5">
              <Skeleton className="h-20" />
              <Skeleton className="h-48" />
            </div>
          </>
        ) : q.error || !st ? (
          <>
            <SheetHeader className="pb-4">
              <SheetTitle>Fatura</SheetTitle>
              <SheetDescription className="sr-only">Não foi possível carregar a fatura.</SheetDescription>
            </SheetHeader>
            <div className="px-5">
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            </div>
          </>
        ) : (
          <>
            <SheetHeader className="pb-4">
              <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: st.card.color }} aria-hidden />
                {st.card.name}
              </p>
              <SheetTitle>Fatura de {formatMonthBR(st.referenceMonth)}</SheetTitle>
              <SheetDescription>
                Fecha em {formatDateBR(st.closingDate)} · vence em {formatDateBR(st.dueDate)}
              </SheetDescription>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatementStatusBadge status={st.status} />
              </div>
            </SheetHeader>
            <div className="flex-1 space-y-6 overflow-y-auto px-5 pb-6">
              <div className="grid grid-cols-3 gap-2">
                <Metric label="Total" value={st.totalCents} />
                <Metric label="Pago" value={st.paidCents} tone="positive" />
                <Metric label="Restante" value={st.remainingCents} tone="warning" />
              </div>
              {st.remainingCents > 0 && canPay && (
                <Button
                  variant="brand"
                  className="w-full"
                  onClick={() =>
                    onPay({ statementId: st.id, cardName: st.card.name, referenceMonth: st.referenceMonth, dueDate: st.dueDate, remainingCents: st.remainingCents, paymentAccountId: st.card.paymentAccountId })
                  }
                >
                  <Banknote /> Pagar fatura ({formatBRL(st.remainingCents)})
                </Button>
              )}
              {(st.status === "OPEN" || st.status === "FUTURE") && (
                <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-info">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  Compras feitas até {formatDateBR(addDays(st.closingDate, -1))} entram nesta fatura; a partir de {formatDateBR(st.closingDate)}, vão para a seguinte. O valor ainda pode mudar.
                </p>
              )}

              {byCategory.length > 0 && (
                <section className="space-y-2" aria-labelledby="statement-categories-title">
                  <h3 id="statement-categories-title" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Por categoria
                  </h3>
                  <CategorySummary items={byCategory} selected={category} onSelect={setCategory} />
                  <NatureBreakdown byNature={st.byNature} />
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground" aria-live="polite">
                  Lançamentos ({activeCategory ? `${lines.length} de ${st.installments.length} · ${activeCategory.name}` : st.installments.length})
                </h3>
                {st.installments.length === 0 ? (
                  <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Nenhuma compra nesta fatura.</p>
                ) : (
                  <ul className="divide-y rounded-xl border">
                    {lines.map((i) => (
                      <li key={i.id}>
                        <Link href={`/transacoes?id=${i.transactionId}`} className="flex items-start gap-3 px-3 py-2.5 text-sm transition hover:bg-muted/50">
                          <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.category?.color ?? "#94a3b8" }} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{i.description}</span>
                            <span className="block text-xs text-muted-foreground">
                              {formatDateBR(i.purchaseDate)} · {i.category?.name ?? "Sem categoria"}
                              {i.payerName && ` · ${i.payerName.split(" ")[0]}`}
                            </span>
                            {(i.nature === "BUSINESS" || i.nature === "PASSTHROUGH") && (
                              <span className="mt-1 flex">
                                {i.nature === "BUSINESS" ? (
                                  <BusinessBadge title="Natureza Empresa: entra no recorte Empresa dos relatórios. A fatura cobra normalmente." />
                                ) : (
                                  <Badge variant="outline" className="border-dashed border-muted-foreground/50 text-muted-foreground" title="Repasse de cliente: fora dos relatórios. A fatura cobra normalmente.">
                                    <EyeOff aria-hidden /> Repasse
                                  </Badge>
                                )}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block font-medium tabular">{formatBRL(i.amountCents)}</span>
                            {i.totalInstallments > 1 && (
                              <span className="block text-xs text-muted-foreground tabular" title={`Parcela ${i.number} de ${i.totalInstallments} · total ${formatBRL(i.totalAmountCents)}`}>
                                parcela {i.number}/{i.totalInstallments}
                              </span>
                            )}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pagamentos ({st.payments.length})</h3>
                {st.payments.length === 0 ? (
                  <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Nenhum pagamento registrado.</p>
                ) : (
                  <ul className="divide-y rounded-xl border">
                    {st.payments.map((p) => (
                      <li key={p.id}>
                        <Link href={`/transacoes?id=${p.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm transition hover:bg-muted/50">
                          <span className="min-w-0">
                            <span className="block font-medium">{formatDateBR(p.date)}</span>
                            <span className="block text-xs text-muted-foreground">
                              {p.account?.name ?? "Conta"}
                              {p.status === "PENDING" && " · aguardando confirmação"}
                            </span>
                          </span>
                          <span className="font-medium tabular text-positive">{formatBRL(p.amountCents)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
