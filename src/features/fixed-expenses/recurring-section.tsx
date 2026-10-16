"use client";

import Link from "next/link";
import { CreditCard, Landmark, Plus, Repeat, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { formatBRL } from "@/lib/money";
import { formatDayMonthBR } from "@/lib/dates";
import { BusinessBadge } from "@/features/transactions/nature-control";
import { REPORT_SCOPE_LABELS } from "@/features/transactions/nature";
import type { ReportScope } from "@/features/finance/types";
import type { FixedExpensesOverview, FixedRecurringItem } from "./types";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Payer({ r }: { r: FixedRecurringItem }) {
  if (r.creditCard)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <CreditCard className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{r.creditCard.name}</span>
      </span>
    );
  if (r.account)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Landmark className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{r.account.name}</span>
      </span>
    );
  return <span className="text-muted-foreground">Definir no pagamento</span>;
}

function CategoryTag({ category }: { category: FixedRecurringItem["category"] }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: category?.color ?? "#94a3b8" }} aria-hidden />
      <span className={category ? "truncate" : "truncate text-muted-foreground"}>{category?.name ?? "Sem categoria"}</span>
    </span>
  );
}

/** Valor da conta: fixo ou "≈ estimado" (conta variável). */
function Amount({ r }: { r: FixedRecurringItem }) {
  return (
    <span className="whitespace-nowrap font-semibold tabular" title={r.isEstimate ? "Conta variável: o valor é uma estimativa" : undefined}>
      {r.isEstimate && (
        <span aria-hidden className="mr-0.5 text-muted-foreground">
          ≈
        </span>
      )}
      {r.isEstimate && <span className="sr-only">aproximadamente </span>}
      {formatBRL(r.amountCents)}
    </span>
  );
}

function DueDay({ r }: { r: FixedRecurringItem }) {
  return (
    <>
      <span className="block whitespace-nowrap font-medium tabular">{r.dayOfMonth ? `dia ${r.dayOfMonth}` : "—"}</span>
      {r.nextDueDate && <span className="block whitespace-nowrap text-xs text-muted-foreground tabular">próx. {formatDayMonthBR(r.nextDueDate)}</span>}
    </>
  );
}

/** a) Contas fixas: recorrências de despesa ativas, com o equivalente mensal e o total. */
export function RecurringSection({
  data,
  scope,
  canEdit,
  onNew,
}: {
  data: FixedExpensesOverview["recurring"];
  scope: ReportScope;
  canEdit: boolean;
  onNew: () => void;
}) {
  const items = data.items;
  // Sob "Tudo" (ou Pessoal, se houver), as contas da empresa ganham o selo; no recorte Empresa todas são da empresa.
  const showBusiness = scope !== "BUSINESS";
  const manage = (size: "sm" | "default") => (
    <Button variant="ghost" size={size} asChild>
      <Link href="/contas-a-pagar?aba=recorrencias">
        <Settings2 /> Gerenciar
      </Link>
    </Button>
  );

  return (
    <Card aria-labelledby="fixed-recurring-title">
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle id="fixed-recurring-title" className="flex items-center gap-2">
            <Repeat className="size-4 text-brand" aria-hidden /> Contas fixas
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            {items.length
              ? `${plural(items.length, "conta que se repete", "contas que se repetem")} · ${formatBRL(data.monthlyTotalCents)} por mês${data.estimatedCount ? ` · ${plural(data.estimatedCount, "com valor estimado", "com valor estimado")}` : ""}`
              : "Aluguel, condomínio, escola, assinaturas e outras despesas que se repetem."}
          </CardDescription>
        </div>
        {items.length > 0 && (
          <CardAction className="ml-0 flex flex-wrap gap-2 sm:ml-auto">
            {canEdit && (
              <Button variant="outline" size="sm" onClick={onNew}>
                <Plus /> Nova recorrência
              </Button>
            )}
            {manage("sm")}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {!items.length ? (
          <EmptyState
            icon={Repeat}
            title={scope === "ALL" ? "Nenhuma conta fixa cadastrada" : `Nenhuma conta fixa no recorte ${REPORT_SCOPE_LABELS[scope]}`}
            description="Cadastre aluguel, internet, plano de saúde e assinaturas como recorrências: elas entram aqui e na projeção dos próximos meses."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {canEdit && (
                  <Button variant="brand" onClick={onNew}>
                    <Plus /> Nova recorrência
                  </Button>
                )}
                {manage("default")}
              </div>
            }
          />
        ) : (
          <>
            <div className="hidden xl:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-24">Vencimento</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Conta / cartão</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead className="text-right">Por mês</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="align-top">
                        <DueDay r={r} />
                      </TableCell>
                      <TableCell className="max-w-72 align-top">
                        <p className="truncate font-medium">{r.description}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {r.scheduleLabel}
                          {showBusiness && r.scope === "BUSINESS" && <BusinessBadge />}
                          {r.isEstimate && <Badge variant="muted">valor estimado</Badge>}
                        </p>
                      </TableCell>
                      <TableCell className="max-w-44 align-top text-sm">
                        <CategoryTag category={r.category} />
                      </TableCell>
                      <TableCell className="max-w-48 align-top text-sm">
                        <Payer r={r} />
                      </TableCell>
                      <TableCell className="text-right align-top">
                        <Amount r={r} />
                      </TableCell>
                      <TableCell className="text-right align-top tabular">
                        <span className={r.monthlyEquivalentCents === r.amountCents ? "text-muted-foreground" : "font-medium"}>{formatBRL(r.monthlyEquivalentCents)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="font-semibold">
                      Total mensal{data.estimatedCount ? <span className="ml-1 text-xs font-normal text-muted-foreground">(inclui valores estimados)</span> : null}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular">{formatBRL(data.monthlyTotalCents)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

            <ul className="divide-y rounded-xl border xl:hidden">
              {items.map((r) => (
                <li key={r.id} className="px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium leading-snug">{r.description}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {r.dayOfMonth ? `Dia ${r.dayOfMonth}` : r.scheduleLabel}
                        {r.nextDueDate && ` · próx. ${formatDayMonthBR(r.nextDueDate)}`}
                      </p>
                    </div>
                    <span className="shrink-0 text-right">
                      <Amount r={r} />
                      {r.monthlyEquivalentCents !== r.amountCents && <span className="block whitespace-nowrap text-xs text-muted-foreground tabular">{formatBRL(r.monthlyEquivalentCents)}/mês</span>}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <Payer r={r} />
                    <CategoryTag category={r.category} />
                    {r.frequencyLabel !== "Mensal" && <span className="text-muted-foreground">{r.scheduleLabel}</span>}
                    {showBusiness && r.scope === "BUSINESS" && <BusinessBadge />}
                    {r.isEstimate && <Badge variant="muted">valor estimado</Badge>}
                  </div>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 bg-muted/50 px-3 py-3 text-sm font-semibold">
                <span>Total mensal</span>
                <span className="tabular">{formatBRL(data.monthlyTotalCents)}</span>
              </li>
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
