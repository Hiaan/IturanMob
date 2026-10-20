"use client";

import Link from "next/link";
import { ArrowRight, Target, TrendingUp } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCan } from "@/features/me/use-me";
import { IncomeGoalProgressBody } from "@/features/goals/income-goal-progress";
import { useIncomeGoals } from "@/features/goals/use-income-goals";

/**
 * Metas de ganho ativas no mês corrente (independe do período dos filtros). Sem meta, só um link
 * discreto para defini-la, para quem pode editar metas.
 */
export function IncomeGoalsCard() {
  const canEdit = useCan("goals:write");
  const q = useIncomeGoals();
  const goals = q.data ?? [];

  if (q.isLoading) return <Skeleton className="h-36 rounded-xl" aria-busy="true" aria-label="Carregando metas de ganho" />;
  if (q.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Meta de ganho</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        </CardContent>
      </Card>
    );
  }
  if (!goals.length) {
    if (!canEdit) return null;
    return (
      <div className="flex justify-end">
        <Link href="/metas" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline">
          <Target className="size-4" aria-hidden /> Definir meta de ganho
        </Link>
      </div>
    );
  }

  return (
    <Card aria-labelledby="income-goals-title" className={cn("transition-opacity", q.isFetching && "opacity-70")}>
      <CardHeader className="flex-row items-start gap-3">
        <div className="min-w-0">
          <CardTitle id="income-goals-title" className="flex items-center gap-2">
            <TrendingUp className="size-4 text-positive" aria-hidden /> {goals.length === 1 ? "Meta de ganho" : "Metas de ganho"}
          </CardTitle>
          <CardDescription className="mt-1 text-xs">{formatMonthBR(goals[0]!.month, { capitalize: true })} · receita reconhecida no regime da família</CardDescription>
        </div>
        <CardAction>
          <Button size="sm" variant="ghost" asChild>
            <Link href="/metas">
              Metas <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          {goals.map((g) => (
            <li key={g.id} className="min-w-0">
              <p className="mb-2 break-words text-sm font-medium">{g.label}</p>
              <IncomeGoalProgressBody goal={g} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
