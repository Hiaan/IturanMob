"use client";

import { useState } from "react";
import Link from "next/link";
import { CreditCard, Landmark, Layers, MoreHorizontal, Pencil, Plus, Repeat, Trash2, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BusinessBadge } from "@/features/transactions/nature-control";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCan } from "@/features/me/use-me";
import { SummaryTile } from "@/features/budgets/summary-tile";
import { RecurringFormDialog } from "./recurring-form-dialog";
import type { RecurringDTO } from "./types";
import { useRecurringList, useRecurringMutations } from "./use-recurring";

const TYPE_FILTERS = [
  { value: "all", label: "Todas" },
  { value: "EXPENSE", label: "Despesas" },
  { value: "INCOME", label: "Receitas" },
] as const;

function Payer({ r }: { r: RecurringDTO }) {
  if (r.creditCard)
    return (
      <span className="inline-flex items-center gap-1.5">
        <CreditCard className="size-3.5 text-muted-foreground" aria-hidden /> {r.creditCard.name}
      </span>
    );
  if (r.account)
    return (
      <span className="inline-flex items-center gap-1.5">
        <Landmark className="size-3.5 text-muted-foreground" aria-hidden /> {r.account.name}
      </span>
    );
  return <span className="text-muted-foreground">Definir no pagamento</span>;
}

function Tags({ r }: { r: RecurringDTO }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {r.category && (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: r.category.color }} aria-hidden />
          {r.subcategory ? `${r.category.name} › ${r.subcategory.name}` : r.category.name}
        </span>
      )}
      {r.scope === "BUSINESS" && <BusinessBadge title="Natureza Empresa: os lançamentos gerados entram no recorte Empresa dos relatórios. Saldo e contas a pagar não mudam." />}
      {r.autoPost && (
        <Badge variant="info">
          <Zap aria-hidden /> automático
        </Badge>
      )}
      {r.isVariableAmount && <Badge variant="muted">valor estimado</Badge>}
      {!r.active && <Badge variant="muted">inativa</Badge>}
    </span>
  );
}

function Value({ r }: { r: RecurringDTO }) {
  return (
    <span className="shrink-0 text-right">
      <span className={cn("block whitespace-nowrap font-semibold tabular", r.type === "INCOME" && "text-positive")}>
        {r.type === "INCOME" ? "+" : ""}
        {formatBRL(r.amountCents)}
      </span>
      {r.monthlyEquivalentCents !== r.amountCents && <span className="block whitespace-nowrap text-xs text-muted-foreground tabular">≈ {formatBRL(r.monthlyEquivalentCents)}/mês</span>}
    </span>
  );
}

function ActiveSwitch({ r, canEdit, busy, onToggle }: { r: RecurringDTO; canEdit: boolean; busy: boolean; onToggle: (active: boolean) => void }) {
  return <Switch checked={r.active} disabled={!canEdit || busy} onCheckedChange={onToggle} aria-label={`${r.active ? "Desativar" : "Ativar"} ${r.description}`} />;
}

function RowMenu({ r, onEdit, onDelete }: { r: RecurringDTO; onEdit: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Ações: ${r.description}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil /> Editar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 /> Excluir
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RecurringTab() {
  const canEdit = useCan("bills:write");
  const q = useRecurringList();
  const { toggle, remove } = useRecurringMutations();
  const [typeFilter, setTypeFilter] = useState<(typeof TYPE_FILTERS)[number]["value"]>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringDTO | null>(null);
  const [toDelete, setToDelete] = useState<RecurringDTO | null>(null);
  const items = (q.data?.items ?? []).filter((r) => typeFilter === "all" || r.type === typeFilter);
  const totals = q.data?.totals;

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const edit = (r: RecurringDTO) => {
    setEditing(r);
    setFormOpen(true);
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="group" aria-label="Filtrar por tipo">
          {TYPE_FILTERS.map((f) => (
            <Button key={f.value} size="sm" variant={typeFilter === f.value ? "default" : "outline"} aria-pressed={typeFilter === f.value} onClick={() => setTypeFilter(f.value)}>
              {f.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/gastos-fixos">
              <Layers /> Gastos fixos<span className="hidden sm:inline"> e projeção</span>
            </Link>
          </Button>
          {canEdit && (
            <Button variant="brand" onClick={openNew}>
              <Plus /> Nova recorrência
            </Button>
          )}
        </div>
      </div>

      {q.isLoading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Carregando recorrências">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-xl" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState
          icon={Repeat}
          title="Nenhuma recorrência cadastrada"
          description="Cadastre aluguel, internet, assinaturas, salário e outras contas que se repetem. As próximas ocorrências aparecem automaticamente em Contas."
          action={
            canEdit ? (
              <Button variant="brand" onClick={openNew}>
                <Plus /> Nova recorrência
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={cn("space-y-5 transition-opacity", q.isFetching && "opacity-70")}>
          {totals && (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
              <SummaryTile label="Despesas recorrentes" value={formatBRL(totals.monthlyExpenseCents)}>
                Equivalente mensal
              </SummaryTile>
              <SummaryTile label="Receitas recorrentes" value={formatBRL(totals.monthlyIncomeCents)}>
                Equivalente mensal
              </SummaryTile>
              <SummaryTile label="Saldo recorrente" value={formatBRL(totals.monthlyNetCents)}>
                Receitas menos despesas por mês
              </SummaryTile>
              <SummaryTile label="Ativas" value={totals.activeCount}>
                {totals.estimatedCount ? `${totals.estimatedCount} com valor estimado` : "Todas com valor fixo"}
              </SummaryTile>
            </div>
          )}

          {!items.length ? (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhuma recorrência deste tipo.</p>
          ) : (
            <>
              <Card className="hidden overflow-hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Ativa</TableHead>
                      <TableHead>Descrição</TableHead>
                      <TableHead>Frequência</TableHead>
                      <TableHead>Próximo vencimento</TableHead>
                      <TableHead>Conta / cartão</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead className="w-12">
                        <span className="sr-only">Ações</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((r) => (
                      <TableRow key={r.id} className={cn(!r.active && "text-muted-foreground")}>
                        <TableCell>
                          <ActiveSwitch r={r} canEdit={canEdit} busy={toggle.isPending && toggle.variables?.id === r.id} onToggle={(active) => toggle.mutate({ id: r.id, active })} />
                        </TableCell>
                        <TableCell className="max-w-72">
                          <p className="truncate font-medium text-foreground">{r.description}</p>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            <Tags r={r} />
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{r.scheduleLabel}</TableCell>
                        <TableCell className="text-sm tabular">{r.nextOccurrence ? formatDateBR(r.nextOccurrence) : "—"}</TableCell>
                        <TableCell className="text-sm">
                          <Payer r={r} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Value r={r} />
                        </TableCell>
                        <TableCell>
                          {canEdit && <RowMenu r={r} onEdit={() => edit(r)} onDelete={() => setToDelete(r)} />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>

              <ul className="space-y-2 md:hidden">
                {items.map((r) => (
                  <li key={r.id}>
                    <Card className={cn("p-4", !r.active && "opacity-80")}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium leading-snug">{r.description}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{r.scheduleLabel}</p>
                        </div>
                        <Value r={r} />
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        <Tags r={r} />
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-xs">
                        <span className="text-muted-foreground">
                          {r.nextOccurrence ? `Próximo: ${formatDateBR(r.nextOccurrence)}` : "Sem próximas ocorrências"} · <Payer r={r} />
                        </span>
                        <span className="flex items-center gap-2">
                          <ActiveSwitch r={r} canEdit={canEdit} busy={toggle.isPending && toggle.variables?.id === r.id} onToggle={(active) => toggle.mutate({ id: r.id, active })} />
                          {canEdit && <RowMenu r={r} onEdit={() => edit(r)} onDelete={() => setToDelete(r)} />}
                        </span>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <RecurringFormDialog open={formOpen} onOpenChange={setFormOpen} recurring={editing} />
      <AlertDialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir a recorrência {toDelete?.description}?</AlertDialogTitle>
            <AlertDialogDescription>
              As próximas ocorrências previstas serão removidas de Contas a pagar. Pagamentos já registrados e contas vencidas em aberto são mantidos. Para apenas pausar, desative a recorrência.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => toDelete && remove.mutate(toDelete.id)}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
