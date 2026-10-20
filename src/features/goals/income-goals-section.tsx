"use client";

import { useState } from "react";
import { BellRing, MoreHorizontal, Pencil, Plus, Power, PowerOff, Trash2, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { errorMessage } from "@/lib/client/api";
import { formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { IncomeGoalFormDialog } from "./income-goal-form-dialog";
import { IncomeGoalProgressBody } from "./income-goal-progress";
import type { IncomeGoalProgress } from "./types";
import { useIncomeGoalMutations, useIncomeGoals } from "./use-income-goals";

type Action = "edit" | "toggle" | "delete";

function IncomeGoalCard({ goal, canEdit, onAction }: { goal: IncomeGoalProgress; canEdit: boolean; onAction: (action: Action, goal: IncomeGoalProgress) => void }) {
  const ownBands = goal.alertThresholds.length > 0;
  return (
    <Card className={cn("flex flex-col p-5", !goal.active && "opacity-75")}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-positive/12 text-positive" aria-hidden>
          <TrendingUp className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-semibold leading-tight">{goal.label}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {goal.active ? <span className="text-xs text-muted-foreground">{formatMonthBR(goal.month, { capitalize: true })}</span> : <Badge variant="muted">Inativa</Badge>}
          </div>
        </div>
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Ações: ${goal.label}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onAction("edit", goal)}>
                <Pencil /> Editar
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAction("toggle", goal)}>
                {goal.active ? (
                  <>
                    <PowerOff /> Desativar
                  </>
                ) : (
                  <>
                    <Power /> Ativar
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete", goal)}>
                <Trash2 /> Excluir
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <IncomeGoalProgressBody goal={goal} className="mt-5" />
      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <BellRing className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          {goal.effectiveThresholds.length ? `Avisos em ${goal.effectiveThresholds.map((t) => `${t}%`).join(", ")}` : "Sem faixas de aviso"}
          {ownBands ? "" : " (as do orçamento)"}
        </span>
      </p>
    </Card>
  );
}

/** Metas de ganho do mês na página de Metas: lista com progresso, criação/edição, ativação e exclusão. */
export function IncomeGoalsSection({ canEdit }: { canEdit: boolean }) {
  const q = useIncomeGoals({ includeInactive: true });
  const { update, remove } = useIncomeGoalMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const items = q.data ?? [];
  const byId = (id: string | null) => (id ? items.find((g) => g.id === id) ?? null : null);
  const toDelete = byId(deleteId);

  const newGoal = () => {
    setEditingId(null);
    setFormOpen(true);
  };

  const onAction = (action: Action, goal: IncomeGoalProgress) => {
    if (action === "edit") {
      setEditingId(goal.id);
      setFormOpen(true);
    } else if (action === "toggle") {
      // Reativar pode esbarrar na regra de uma meta ativa por recorte e categoria: mostra a mensagem do servidor.
      update.mutate({ id: goal.id, active: !goal.active }, { onError: (err) => toast.error(errorMessage(err)) });
    } else setDeleteId(goal.id);
  };

  return (
    <section aria-labelledby="income-goals-heading" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 id="income-goals-heading" className="text-lg font-semibold tracking-tight">
            Metas de ganho
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Quanto a família quer ganhar por mês, no total, como pessoa física ou na empresa.</p>
        </div>
        {canEdit && items.length > 0 && (
          <Button variant="outline" onClick={newGoal} className="self-start sm:self-auto">
            <Plus /> Nova meta de ganho
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Carregando metas de ganho">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
      ) : !items.length ? (
        <EmptyState
          icon={TrendingUp}
          className="py-8"
          title="Nenhuma meta de ganho"
          description="Defina quanto quer ganhar no mês e acompanhe quanto falta, o ritmo e os avisos de cada faixa."
          action={
            canEdit ? (
              <Button variant="brand" onClick={newGoal}>
                <Plus /> Definir meta de ganho
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={cn("grid gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-3", q.isFetching && "opacity-70")}>
          {items.map((g) => (
            <IncomeGoalCard key={g.id} goal={g} canEdit={canEdit} onAction={onAction} />
          ))}
        </div>
      )}

      <IncomeGoalFormDialog open={formOpen} onOpenChange={setFormOpen} goal={byId(editingId)} />

      <AlertDialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir esta meta de ganho?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.label}. Os avisos desta meta param e os lançamentos não mudam. Se quiser só pausar, desative a meta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => toDelete && remove.mutate(toDelete.id, { onError: (err) => toast.error(errorMessage(err)) })}
            >
              Excluir meta
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
