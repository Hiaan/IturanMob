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
