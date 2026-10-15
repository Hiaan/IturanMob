"use client";

import { useState } from "react";
import { BellRing, Check, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { MoneyInput } from "@/components/shared/money-input";
import { formatBRL } from "@/lib/money";
import { formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { BudgetItem } from "./types";
import { useBudgetMutations } from "./use-budgets";

function pct(n: number) {
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

/** Linha de orçamento por categoria: medidor, valores, edição inline do limite e exclusão. */
export function BudgetRow({ item, month, isCurrentMonth, canEdit }: { item: BudgetItem; month: string; isCurrentMonth: boolean; canEdit: boolean }) {
  const { update, remove } = useBudgetMutations();
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState(item.limitCents);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const over = item.remainingCents < 0;

  const save = () => {
    if (limit <= 0) return;
    if (limit === item.limitCents) {
      setEditing(false);
      return;
    }
    update.mutate({ id: item.budgetId, limitCents: limit }, { onSuccess: () => setEditing(false) });
  };

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.category.color }} aria-hidden />
          <span className="truncate font-medium">{item.category.name}</span>
          {item.alertsTriggered.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="muted" className="cursor-help" tabIndex={0}>
                  <BellRing aria-hidden /> {item.alertsTriggered.map((t) => `${t}%`).join(" · ")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Avisos já enviados neste mês ao atingir {item.alertsTriggered.map((t) => `${t}%`).join(", ")} do limite.</TooltipContent>
            </Tooltip>
          )}
        </div>

        {editing ? (
          <form
            className="flex w-full items-center gap-2 sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <MoneyInput value={limit} onChange={setLimit} className="h-9 w-full sm:w-44" autoFocus aria-invalid={limit <= 0} id={`limit-${item.budgetId}`} />
            <Button type="submit" size="icon-sm" variant="brand" aria-label="Salvar limite" loading={update.isPending} disabled={limit <= 0}>
              {!update.isPending && <Check />}
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Cancelar edição"
              onClick={() => {
                setLimit(item.limitCents);
                setEditing(false);
              }}
            >
              <X />
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-1">
            <p className="text-sm tabular">
              <span className="font-semibold">{formatBRL(item.spentCents)}</span>
              <span className="text-muted-foreground"> de {formatBRL(item.limitCents)}</span>
            </p>
            {canEdit && (
              <>
                <Button size="icon-sm" variant="ghost" aria-label={`Editar limite de ${item.category.name}`} onClick={() => setEditing(true)}>
                  <Pencil />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Excluir orçamento de ${item.category.name}`} onClick={() => setConfirmDelete(true)}>
                  <Trash2 />
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <Progress
        className="mt-2.5"
        value={Math.min(100, item.percentUsed)}
        indicatorClassName={cn(item.percentUsed >= 100 ? "bg-warning" : "bg-brand")}
        aria-label={`${item.category.name}: ${pct(item.percentUsed)} do limite utilizado`}
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular">
          {pct(item.percentUsed)} utilizado ·{" "}
          {over ? <span className="font-medium text-warning">{formatBRL(-item.remainingCents)} acima do limite</span> : <>restam {formatBRL(item.remainingCents)}</>}
        </span>
        {isCurrentMonth && (
          <span className="flex items-center gap-1.5 tabular">
            Projeção para o mês: {formatBRL(item.projectedCents)}
            <Badge variant="muted" className="px-1.5 py-0 text-[10px]">
              estimativa
            </Badge>
          </span>
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir orçamento?</AlertDialogTitle>
            <AlertDialogDescription>
              O limite de {item.category.name} em {formatMonthBR(month)} será removido. As despesas registradas não são alteradas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => remove.mutate(item.budgetId)}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
