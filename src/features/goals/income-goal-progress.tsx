import { Progress } from "@/components/ui/progress";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { IncomeGoalProgress } from "./types";

const days = (n: number) => `${n} ${n === 1 ? "dia" : "dias"}`;

/**
 * Progresso da meta de ganho no mês: barra (limitada a 100%, com o percentual real ao lado),
 * "R$ X de R$ Y", quanto falta e em quantos dias, e a projeção pelo ritmo do mês.
 */
export function IncomeGoalProgressBody({ goal, className }: { goal: IncomeGoalProgress; className?: string }) {
  const percent = goal.percent.toLocaleString("pt-BR");
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 break-words text-sm">
          <span className="font-semibold tabular">{formatBRL(goal.incomeCents)}</span> <span className="text-muted-foreground">de {formatBRL(goal.targetCents)}</span>
        </p>
        <span className={cn("shrink-0 text-sm font-semibold tabular", goal.reached && "text-positive")}>{percent}%</span>
      </div>
      <Progress
        value={Math.min(100, goal.percent)}
        className="mt-2"
        indicatorClassName={goal.reached ? "bg-positive" : "bg-brand"}
        aria-label={`${goal.label}: ${percent}% da meta`}
      />
      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        {goal.reached ? (
          <li className="font-medium text-positive">🎉 Meta batida</li>
        ) : (
          <li>
            Faltam <span className="tabular">{formatBRL(goal.remainingCents)}</span>
            {goal.daysLeft > 0 && ` em ${days(goal.daysLeft)}`}
          </li>
        )}
        {goal.projectedCents !== null && (
          <li>
            Pelo ritmo do mês: <span className="tabular">{formatBRL(goal.projectedCents)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
