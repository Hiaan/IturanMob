"use client";

import { useState } from "react";
import { Plus, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import { PageHeader } from "@/components/shared/page-header";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useCan } from "@/features/me/use-me";
import { SummaryTile } from "@/features/budgets/summary-tile";
import { ContributionDialog, type ContributionMode } from "./contribution-dialog";
import { ContributionsSheet } from "./contributions-sheet";
import { GoalCard, type GoalAction } from "./goal-card";
import { GoalFormDialog } from "./goal-form-dialog";
import type { GoalDTO } from "./types";
import { useGoalMutations, useGoals } from "./use-goals";

export function GoalsView() {
  const canEdit = useCan("goals:write");
  const [showArchived, setShowArchived] = useState(false);
  const q = useGoals(showArchived);
  const { update, remove } = useGoalMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [contribution, setContribution] = useState<{ id: string; mode: ContributionMode } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const items = q.data?.items ?? [];
  // Os diálogos usam sempre a versão mais recente da meta (o progresso muda após cada operação).
  const byId = (id: string | null): GoalDTO | null => (id ? items.find((g) => g.id === id) ?? null : null);
  const editing = byId(editingId);
  const toDelete = byId(deleteId);
  const totals = q.data?.totals;
  const completedCount = items.filter((g) => g.status === "COMPLETED").length;

  const onAction = (action: GoalAction, goal: GoalDTO) => {
    switch (action) {
      case "edit":
        setEditingId(goal.id);
        setFormOpen(true);
        break;
      case "history":
        setHistoryId(goal.id);
        break;
      case "contribute":
      case "withdraw":
        setContribution({ id: goal.id, mode: action });
        break;
      case "archive":
        update.mutate({ id: goal.id, status: "ARCHIVED" });
        break;
      case "unarchive":
        update.mutate({ id: goal.id, status: "ACTIVE" });
        break;
      case "delete":
        setDeleteId(goal.id);
        break;
    }
  };

  const newGoal = () => {
    setEditingId(null);
    setFormOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Metas"
        description="Objetivos da família e quanto falta para alcançá-los"
        actions={
          <>
            <label className="flex h-10 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Mostrar metas arquivadas" />
              Mostrar arquivadas
            </label>
            {canEdit && (
              <Button variant="brand" onClick={newGoal}>
                <Plus /> Nova meta
              </Button>
            )}
          </>
        }
      />

      {q.isLoading ? (
        <div className="space-y-6" aria-busy="true" aria-label="Carregando metas">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-80 rounded-xl" />
            ))}
          </div>
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={Target}
          title={showArchived ? "Nenhuma meta cadastrada" : "Nenhuma meta em andamento"}
          description="Crie metas como uma viagem, a reserva de emergência ou a troca do carro e acompanhe o progresso a cada contribuição."
          action={
            canEdit ? (
              <Button variant="brand" onClick={newGoal}>
                <Plus /> Criar meta
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={cn("space-y-6 transition-opacity", q.isFetching && "opacity-70")}>
          {totals && (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
              <SummaryTile label="Metas ativas" value={totals.activeCount}>
                {completedCount > 0 ? `${completedCount} ${completedCount === 1 ? "concluída" : "concluídas"}` : "Em andamento"}
              </SummaryTile>
              <SummaryTile label="Acumulado nas metas ativas" value={formatBRL(totals.savedCents)}>
                de {formatBRL(totals.targetCents)}
              </SummaryTile>
              <SummaryTile label="Falta juntar" value={formatBRL(Math.max(0, totals.targetCents - totals.savedCents))}>
                Soma das metas ativas
              </SummaryTile>
              <SummaryTile label="Necessário por mês" value={formatBRL(totals.monthlyNeededCents)}>
                Para cumprir os prazos definidos
              </SummaryTile>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((goal) => (
              <GoalCard key={goal.id} goal={goal} canEdit={canEdit} onAction={onAction} />
            ))}
          </div>
        </div>
      )}

      <GoalFormDialog open={formOpen} onOpenChange={setFormOpen} goal={editing} />
      <ContributionDialog goal={byId(contribution?.id ?? null)} mode={contribution?.mode ?? "contribute"} onOpenChange={(o) => !o && setContribution(null)} />
      <ContributionsSheet goal={byId(historyId)} onOpenChange={(o) => !o && setHistoryId(null)} canEdit={canEdit} />

      <AlertDialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir a meta {toDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              O histórico de contribuições da meta será removido. Transferências já realizadas continuam no extrato das contas. Se preferir manter o histórico, arquive a meta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => toDelete && remove.mutate(toDelete.id)}>
              Excluir meta
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
