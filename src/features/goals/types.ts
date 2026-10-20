/** Tipos de resposta da API de metas (espelham src/server/modules/goals/service.ts). */
export type GoalStatus = "ACTIVE" | "COMPLETED" | "ARCHIVED";

export interface GoalDTO {
  id: string;
  name: string;
  targetCents: number;
  deadline: string | null;
  status: GoalStatus;
  color: string;
  icon: string;
  notes: string | null;
  account: { id: string; name: string; color: string } | null;
  accountId: string | null;
  contributionsCount: number;
  lastContributionDate: string | null;
  createdAt: string;
  updatedAt: string;
  savedCents: number;
  percent: number;
  remainingCents: number;
  monthlyNeededCents: number | null;
  monthsLeft: number | null;
  daysLeft: number | null;
  deadlinePassed: boolean;
}

export interface GoalList {
  items: GoalDTO[];
  totals: { activeCount: number; targetCents: number; savedCents: number; monthlyNeededCents: number };
}

export interface ContributionDTO {
  id: string;
  goalId: string;
  amountCents: number;
  date: string;
  kind: "ALLOCATION" | "TRANSFER";
  note: string | null;
  member: { id: string; displayName: string } | null;
  transaction: { id: string; fromAccount: string | null; toAccount: string | null; deletedAt: string | null } | null;
  sourceMessageId: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface ContributeResult {
  contribution: ContributionDTO;
  goal: GoalDTO;
  created: boolean;
  completedNow: boolean;
}

/** Recorte da meta de ganho (mesmos valores do recorte de relatórios). */
export type IncomeGoalScope = "ALL" | "PERSONAL" | "BUSINESS";

/** Meta de ganho com o progresso do mês (espelha IncomeGoalProgress de src/server/modules/income-goals/service.ts). */
export interface IncomeGoalProgress {
  id: string;
  scope: IncomeGoalScope;
  scopeLabel: string;
  categoryId: string | null;
  categoryName: string | null;
  /** "Meta de ganho · Empresa" / "Meta de ganho · Clientes (Pessoa física)". */
  label: string;
  targetCents: number;
  /** Faixas de aviso próprias; vazio = as mesmas do orçamento. */
  alertThresholds: number[];
  /** Faixas em uso (as próprias ou as do orçamento). */
  effectiveThresholds: number[];
  active: boolean;
  month: string;
  incomeCents: number;
  /** Percentual inteiro (arredondado para baixo); pode passar de 100. */
  percent: number;
  remainingCents: number;
  reached: boolean;
  /** Projeção pelo ritmo do mês; só no mês corrente. */
  projectedCents: number | null;
  /** Dias que faltam no mês, incluindo hoje. */
  daysLeft: number;
}

export interface IncomeGoalInput {
  scope: IncomeGoalScope;
  categoryId: string | null;
  targetCents: number;
  alertThresholds: number[];
  active: boolean;
}
