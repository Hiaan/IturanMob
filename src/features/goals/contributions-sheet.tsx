"use client";

import { useState } from "react";
import { ArrowRightLeft, History, Layers, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import type { ContributionDTO, GoalDTO } from "./types";
import { useContributions, useGoalMutations } from "./use-goals";

/** Histórico de contribuições e resgates da meta, com exclusão. */
export function ContributionsSheet({ goal, onOpenChange, canEdit }: { goal: GoalDTO | null; onOpenChange: (open: boolean) => void; canEdit: boolean }) {
  const q = useContributions(goal?.id ?? null);
  const { removeContribution } = useGoalMutations();
  const [toDelete, setToDelete] = useState<ContributionDTO | null>(null);
  const items = q.data?.items ?? [];

  return (
    <Sheet open={Boolean(goal)} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Histórico da meta</SheetTitle>
          <SheetDescription>
            {goal ? `${goal.name} · acumulado ${formatBRL(goal.savedCents)} de ${formatBRL(goal.targetCents)}` : null}
          </SheetDescription>
        </SheetHeader>
        <div className="px-5 pb-6">
          {q.isLoading ? (
            <div className="grid gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : q.error ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
          ) : !items.length ? (
            <EmptyState icon={History} title="Nenhuma contribuição ainda" description="As contribuições e os resgates desta meta aparecerão aqui." />
          ) : (
            <ul className="divide-y rounded-xl border">
              {items.map((c) => {
                const withdrawal = c.amountCents < 0;
                return (
                  <li key={c.id} className="flex items-start gap-3 p-3">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
                      {c.kind === "TRANSFER" ? <ArrowRightLeft className="size-4" /> : <Layers className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={cn("font-semibold tabular", withdrawal ? "text-foreground" : "text-positive")}>
                          {withdrawal ? "−" : "+"}
                          {formatBRL(Math.abs(c.amountCents))}
                        </span>
                        <Badge variant={withdrawal ? "muted" : "positive"}>{withdrawal ? "Resgate" : "Contribuição"}</Badge>
                        <Badge variant="outline">{c.kind === "TRANSFER" ? "Transferência" : "Alocação interna"}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDateBR(c.date)}
                        {c.member && ` · ${c.member.displayName}`}
                        {c.transaction?.fromAccount && c.transaction.toAccount && ` · ${c.transaction.fromAccount} → ${c.transaction.toAccount}`}
                      </p>
                      {c.note && <p className="mt-1 text-sm">{c.note}</p>}
                    </div>
                    {canEdit && (
                      <Button size="icon-sm" variant="ghost" aria-label="Excluir lançamento da meta" onClick={() => setToDelete(c)}>
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <AlertDialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{toDelete && toDelete.amountCents < 0 ? "Excluir resgate?" : "Excluir contribuição?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {toDelete?.kind === "TRANSFER"
                  ? "A transferência vinculada também será excluída e os saldos das contas voltarão ao valor anterior."
                  : "O valor deixará de contar no acumulado da meta. Nenhum saldo é alterado."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => toDelete && removeContribution.mutate(toDelete, { onSettled: () => setToDelete(null) })}
              >
                Excluir
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
