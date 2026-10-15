"use client";

import { Archive, ArchiveRestore, CalendarDays, CircleCheck, History, Landmark, Minus, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { GoalIconBadge } from "./goal-icons";
import type { GoalDTO } from "./types";

export type GoalAction = "edit" | "history" | "contribute" | "withdraw" | "archive" | "unarchive" | "delete";

function deadlineText(goal: GoalDTO): string {
  if (!goal.deadline) return "Sem prazo definido";
  if (goal.deadlinePassed) return `Prazo encerrado em ${formatDateBR(goal.deadline)}`;
  const months = goal.monthsLeft ?? 0;
  return `Até ${formatDateBR(goal.deadline)} · ${months} ${months === 1 ? "mês" : "meses"}`;
}

/** Cartão de meta com progresso, prazo, valor mensal necessário e ações. */
export function GoalCard({ goal, canEdit, onAction }: { goal: GoalDTO; canEdit: boolean; onAction: (action: GoalAction, goal: GoalDTO) => void }) {
  const percent = Math.min(100, goal.percent);
  const archived = goal.status === "ARCHIVED";
  const completed = goal.status === "COMPLETED";

  return (
    <Card className={cn("flex flex-col p-5", archived && "opacity-75")}>
      <div className="flex items-start gap-3">
        <GoalIconBadge icon={goal.icon} color={goal.color} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold leading-tight">{goal.name}</h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {completed && (
              <Badge variant="positive">
                <CircleCheck aria-hidden /> Concluída
              </Badge>
            )}
            {archived && (
              <Badge variant="muted">
                <Archive aria-hidden /> Arquivada
              </Badge>
            )}
            {!completed && !archived && <span className="text-xs text-muted-foreground">{goal.contributionsCount} {goal.contributionsCount === 1 ? "lançamento" : "lançamentos"}</span>}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Ações da meta ${goal.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAction("history", goal)}>
              <History /> Histórico
            </DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuItem onSelect={() => onAction("edit", goal)}>
                  <Pencil /> Editar
                </DropdownMenuItem>
                {archived ? (
                  <DropdownMenuItem onSelect={() => onAction("unarchive", goal)}>
                    <ArchiveRestore /> Reativar
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => onAction("archive", goal)}>
                    <Archive /> Arquivar
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete", goal)}>
                  <Trash2 /> Excluir
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-5">
        <p className="text-2xl font-semibold leading-none tracking-tight">{formatBRL(goal.savedCents)}</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          de {formatBRL(goal.targetCents)} · <span className="tabular">{goal.percent.toLocaleString("pt-BR")}%</span>
        </p>
        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`Progresso da meta ${goal.name}: ${goal.percent.toLocaleString("pt-BR")}%`}
        >
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${percent}%`, backgroundColor: goal.color }} />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Faltam</dt>
          <dd className="font-medium tabular">{formatBRL(goal.remainingCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Por mês até o prazo</dt>
          <dd className="font-medium tabular">{goal.monthlyNeededCents !== null && !completed ? formatBRL(goal.monthlyNeededCents) : "—"}</dd>
        </div>
      </dl>
      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <CalendarDays className="size-3.5" aria-hidden /> {deadlineText(goal)}
        </li>
        <li className="flex items-center gap-1.5">
          <Landmark className="size-3.5" aria-hidden /> {goal.account ? `Conta vinculada: ${goal.account.name}` : "Sem conta vinculada (alocação interna)"}
        </li>
      </ul>

      {canEdit && !archived && (
        <div className="mt-auto flex flex-wrap gap-2 pt-5">
          <Button variant="brand" size="sm" className="flex-1" onClick={() => onAction("contribute", goal)}>
            <Plus /> Contribuir
          </Button>
          <Button variant="outline" size="sm" className="flex-1" onClick={() => onAction("withdraw", goal)} disabled={goal.savedCents <= 0}>
            <Minus /> Resgatar
          </Button>
        </div>
      )}
    </Card>
  );
}
