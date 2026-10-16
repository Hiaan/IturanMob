"use client";

import { useState } from "react";
import Link from "next/link";
import { CreditCard, Layers, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { BusinessBadge } from "@/features/transactions/nature-control";
import { REPORT_SCOPE_LABELS } from "@/features/transactions/nature";
import type { ReportScope } from "@/features/finance/types";
import type { FixedExpensesOverview, InstallmentPlanItem } from "./types";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "nov/26" */
const endsLabel = (m: string) => formatMonthBR(m, { short: true });

function CardDot({ color }: { color: string }) {
  return <span className="size-2.5 shrink-0 rounded-full ring-1 ring-foreground/15" style={{ backgroundColor: color }} aria-hidden />;
}

/** Andamento: "parcela 4 de 10" com a barra do que já foi cobrado. */
function Progression({ i }: { i: InstallmentPlanItem }) {
  const paid = Math.max(0, i.currentNumber - 1);
  return (
    <div className="min-w-24">
      <span className="block whitespace-nowrap text-sm font-medium tabular">
        {i.currentNumber}/{i.totalInstallments}
        <span className="sr-only">
          : parcela {i.currentNumber} de {i.totalInstallments}
        </span>
      </span>
      <Progress className="mt-1 h-1" value={(paid / i.totalInstallments) * 100} aria-hidden />
    </div>
  );
}

function Flags({ i, showBusiness }: { i: InstallmentPlanItem; showBusiness: boolean }) {
  return (
    <>
      {i.remainingCount === 1 && <Badge variant="info">última parcela</Badge>}
      {showBusiness && i.scope === "BUSINESS" && <BusinessBadge />}
    </>
  );
}

/** b) Parcelas do cartão: compras parceladas em andamento, por término, com totais por cartão. */
export function InstallmentsSection({
  data,
  scope,
  canCreate,
  onNewPurchase,
}: {
  data: FixedExpensesOverview["installments"];
  scope: ReportScope;
  canCreate: boolean;
  onNewPurchase: () => void;
}) {
  const [cardId, setCardId] = useState<string | null>(null);
  const activeCard = data.byCard.find((c) => c.card.id === cardId) ?? null;
  const items = activeCard ? data.items.filter((i) => i.card.id === activeCard.card.id) : data.items;
  const totalRemaining = items.reduce((s, i) => s + i.remainingCents, 0);
  const totalNext = items.reduce((s, i) => s + i.installmentAmountCents, 0);
  const lastEnd = data.items.reduce((m, i) => (i.endsMonth > m ? i.endsMonth : m), "");
  const showBusiness = scope !== "BUSINESS";

  return (
    <Card aria-labelledby="fixed-installments-title">
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle id="fixed-installments-title" className="flex items-center gap-2">
            <Layers className="size-4 text-brand" aria-hidden /> Parcelas do cartão
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            {data.items.length
              ? `${plural(data.items.length, "compra parcelada", "compras parceladas")} em andamento · ordenadas pelo término${lastEnd ? ` · a última termina em ${endsLabel(lastEnd)}` : ""}`
              : "Compras parceladas no cartão com parcelas a vencer."}
          </CardDescription>
        </div>
        {data.items.length > 0 && (
          <CardAction className="ml-0 sm:ml-auto">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/cartoes">
                <CreditCard /> Cartões e faturas
              </Link>
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.items.length ? (
          <EmptyState
            icon={Layers}
            title={scope === "ALL" ? "Nenhuma compra parcelada em andamento" : `Nenhuma compra parcelada no recorte ${REPORT_SCOPE_LABELS[scope]}`}
            description="Ao lançar uma compra no cartão em várias parcelas, ela aparece aqui com a parcela atual, quanto falta e quando termina."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {canCreate && (
                  <Button variant="brand" onClick={onNewPurchase}>
                    <Plus /> Lançar compra parcelada
                  </Button>
                )}
                <Button variant="ghost" asChild>
                  <Link href="/cartoes">
                    <CreditCard /> Ver cartões
                  </Link>
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="Filtrar parcelas por cartão">
              <button
                type="button"
                aria-pressed={!activeCard}
                onClick={() => setCardId(null)}
                className={cn(
                  "min-w-0 rounded-xl border p-3 text-left outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                  !activeCard ? "border-brand/50 bg-accent/60" : "hover:bg-muted/50",
                )}
              >
                <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                  Todos os cartões <span className="tabular">{plural(data.items.length, "compra", "compras")}</span>
                </span>
                <span className="mt-1 block text-lg font-semibold tabular">{formatBRL(data.totalRemainingCents)}</span>
                <span className="block text-xs text-muted-foreground">
                  restante · <span className="tabular">{formatBRL(data.nextInstallmentsCents)}</span> na próxima fatura
                </span>
              </button>
              {data.byCard.map((c) => {
                const pressed = activeCard?.card.id === c.card.id;
                return (
                  <button
                    key={c.card.id}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => setCardId(pressed ? null : c.card.id)}
                    className={cn(
                      "min-w-0 rounded-xl border p-3 text-left outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                      pressed ? "border-brand/50 bg-accent/60" : "hover:bg-muted/50",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <CardDot color={c.card.color} />
                        <span className="truncate text-foreground">{c.card.name}</span>
                      </span>
                      <span className="shrink-0 tabular">{plural(c.count, "compra", "compras")}</span>
                    </span>
                    <span className="mt-1 block text-lg font-semibold tabular">{formatBRL(c.remainingCents)}</span>
                    <span className="block text-xs text-muted-foreground">
                      <span className="tabular">{formatBRL(c.nextInstallmentsCents)}</span> na próxima fatura{c.endsMonth ? ` · até ${endsLabel(c.endsMonth)}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            {activeCard && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Mostrando só</span>
                <button
                  type="button"
                  onClick={() => setCardId(null)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-2.5 text-xs font-medium outline-none transition hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  aria-label={`Limpar filtro do cartão ${activeCard.card.name}`}
                >
                  <CardDot color={activeCard.card.color} /> {activeCard.card.name} <X className="size-3" aria-hidden />
                </button>
              </div>
            )}

            <div className="hidden xl:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Compra</TableHead>
                    <TableHead>Cartão</TableHead>
                    <TableHead className="text-right">Parcela</TableHead>
                    <TableHead>Atual/total</TableHead>
                    <TableHead className="text-right">Restantes</TableHead>
                    <TableHead className="text-right">Total restante</TableHead>
                    <TableHead>Termina em</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((i) => (
                    <TableRow key={i.transactionId}>
                      <TableCell className="max-w-72 align-top">
                        <Link href={`/transacoes?id=${i.transactionId}`} className="block truncate font-medium hover:underline">
                          {i.description}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <span className="size-2 rounded-full" style={{ backgroundColor: i.category?.color ?? "#94a3b8" }} aria-hidden />
                            {i.category?.name ?? "Sem categoria"}
                          </span>
                          · compra em {formatDateBR(i.purchaseDate)} · {formatBRL(i.totalAmountCents)}
                          <Flags i={i} showBusiness={showBusiness} />
                        </p>
                      </TableCell>
                      <TableCell className="align-top text-sm">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <CardDot color={i.card.color} /> {i.card.name}
                        </span>
                      </TableCell>
                      <TableCell className="text-right align-top font-medium tabular">{formatBRL(i.installmentAmountCents)}</TableCell>
                      <TableCell className="align-top">
                        <Progression i={i} />
                      </TableCell>
                      <TableCell className="text-right align-top tabular">{i.remainingCount}</TableCell>
                      <TableCell className="text-right align-top font-medium tabular">{formatBRL(i.remainingCents)}</TableCell>
                      <TableCell className="whitespace-nowrap align-top text-sm">{formatMonthBR(i.endsMonth, { capitalize: true })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={2} className="font-semibold">
                      {activeCard ? `Total ${activeCard.card.name}` : "Total"}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular" title="Soma das parcelas na próxima fatura de cada compra">
                      {formatBRL(totalNext)}
                    </TableCell>
                    <TableCell colSpan={2} />
                    <TableCell className="text-right font-semibold tabular">{formatBRL(totalRemaining)}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

            <ul className="divide-y rounded-xl border xl:hidden">
              {items.map((i) => (
                <li key={i.transactionId} className="px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/transacoes?id=${i.transactionId}`} className="block font-medium leading-snug hover:underline">
                        {i.description}
                      </Link>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <CardDot color={i.card.color} /> {i.card.name}
                        </span>
                        · {i.category?.name ?? "Sem categoria"}
                      </p>
                    </div>
                    <span className="shrink-0 text-right">
                      <span className="block whitespace-nowrap font-semibold tabular">{formatBRL(i.installmentAmountCents)}</span>
                      <span className="block whitespace-nowrap text-xs text-muted-foreground tabular">
                        parcela {i.currentNumber}/{i.totalInstallments}
                      </span>
                    </span>
                  </div>
                  <Progress className="mt-2 h-1" value={(Math.max(0, i.currentNumber - 1) / i.totalInstallments) * 100} aria-hidden />
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Restantes</dt>
                      <dd className="font-medium tabular">{i.remainingCount}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Falta pagar</dt>
                      <dd className="font-medium tabular">{formatBRL(i.remainingCents)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted-foreground">Termina em</dt>
                      <dd className="font-medium">{endsLabel(i.endsMonth)}</dd>
                    </div>
                  </dl>
                  {(i.remainingCount === 1 || (showBusiness && i.scope === "BUSINESS")) && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Flags i={i} showBusiness={showBusiness} />
                    </div>
                  )}
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 bg-muted/50 px-3 py-3 text-sm font-semibold">
                <span>{activeCard ? `Total ${activeCard.card.name}` : "Total restante"}</span>
                <span className="tabular">{formatBRL(totalRemaining)}</span>
              </li>
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
