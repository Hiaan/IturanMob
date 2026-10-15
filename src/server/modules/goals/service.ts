import { z } from "zod";
import type { FinancialGoal, GoalStatus, Prisma, TransactionSource } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { dateToISO, diffDays, isoToDate, monthKey, monthsBetween, todayISO, type ISODate } from "@/lib/dates";
import { formatBRL, MAX_AMOUNT_CENTS, percentOf } from "@/lib/money";
import { normalizeText, tokenSimilarity } from "@/lib/utils";
import { audit } from "../audit/service";
import { createTransaction, deleteTransaction } from "../transactions/service";
import { amountCentsSchema, idSchema, isoDateSchema } from "../transactions/schemas";
import type { TransactionDTO } from "../transactions/serialize";
import { visibleAccountWhere } from "../visibility/scope";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const GOAL_STATUSES = ["ACTIVE", "COMPLETED", "ARCHIVED"] as const satisfies readonly GoalStatus[];
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida");

const goalFields = {
  name: z.string().trim().min(1, "Informe o nome da meta").max(80),
  targetCents: amountCentsSchema,
  deadline: isoDateSchema.nullish(),
  accountId: idSchema.nullish(),
  color: hexColor,
  icon: z.string().trim().min(1).max(40),
  notes: z.string().trim().max(1000).nullish(),
};

export const goalCreateSchema = z.object({
  ...goalFields,
  color: goalFields.color.default("#059669"),
  icon: goalFields.icon.default("target"),
});
export type GoalCreateInput = z.input<typeof goalCreateSchema>;

export const goalUpdateSchema = z.object(goalFields).partial().extend({ status: z.enum(GOAL_STATUSES).optional() });
export type GoalUpdateInput = z.input<typeof goalUpdateSchema>;

export const goalListSchema = z.object({
  status: z.enum(GOAL_STATUSES).optional(),
  includeArchived: z.boolean().optional(),
});

export const contributionSchema = z.object({
  /** Positivo = contribuição; negativo = resgate. */
  amountCents: z
    .number({ error: "Valor inválido" })
    .int("O valor deve estar em centavos")
    .refine((v) => v !== 0, "O valor deve ser diferente de zero")
    .refine((v) => Math.abs(v) <= MAX_AMOUNT_CENTS, "Valor acima do limite permitido"),
  date: isoDateSchema.optional(),
  /** Conta de onde sai o dinheiro (ou para onde volta, no resgate). */
  fromAccountId: idSchema.nullish(),
  note: z.string().trim().max(500).nullish(),
  sourceMessageId: idSchema.nullish(),
});
export type ContributionInput = z.input<typeof contributionSchema>;

export const contributionListSchema = z.object({
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(64).optional(),
});

// -----------------------------------------------------------------------------
// DTOs e progresso
// -----------------------------------------------------------------------------

export interface GoalProgress {
  savedCents: number;
  /** Percentual atingido (pode passar de 100). */
  percent: number;
  remainingCents: number;
  /** Valor mensal necessário para atingir a meta até o prazo (inclui o mês corrente). */
  monthlyNeededCents: number | null;
  monthsLeft: number | null;
  daysLeft: number | null;
  deadlinePassed: boolean;
}

export interface GoalDTO extends GoalProgress {
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
}

export interface ContributionDTO {
  id: string;
  goalId: string;
  amountCents: number;
  date: string;
  /** ALLOCATION = alocação interna (sem movimento de caixa); TRANSFER = transferência entre contas. */
  kind: "ALLOCATION" | "TRANSFER";
  note: string | null;
  member: { id: string; displayName: string } | null;
  transaction: { id: string; fromAccount: string | null; toAccount: string | null; deletedAt: string | null } | null;
  sourceMessageId: string | null;
  createdAt: string;
  deletedAt: string | null;
}

/** Calcula o progresso da meta a partir do acumulado. */
export function computeGoalProgress(goal: { targetCents: number; deadline: ISODate | null }, savedCents: number, today: ISODate): GoalProgress {
  const remaining = Math.max(0, goal.targetCents - savedCents);
  let monthsLeft: number | null = null;
  let daysLeft: number | null = null;
  let monthlyNeeded: number | null = null;
  let deadlinePassed = false;
  if (goal.deadline) {
    daysLeft = diffDays(goal.deadline, today);
    deadlinePassed = daysLeft < 0;
    if (!deadlinePassed) {
      monthsLeft = monthsBetween(monthKey(today), monthKey(goal.deadline)).length;
      monthlyNeeded = remaining > 0 ? Math.ceil(remaining / Math.max(1, monthsLeft)) : 0;
    }
  }
  return {
    savedCents,
    percent: percentOf(savedCents, goal.targetCents) ?? 0,
    remainingCents: remaining,
    monthlyNeededCents: monthlyNeeded,
    monthsLeft,
    daysLeft,
    deadlinePassed,
  };
}

async function savedByGoal(db: Db, goalIds: string[]) {
  if (!goalIds.length) return new Map<string, { saved: number; count: number; last: Date | null }>();
  const groups = await db.goalContribution.groupBy({
    by: ["goalId"],
    where: { goalId: { in: goalIds }, deletedAt: null },
    _sum: { amountCents: true },
    _count: { _all: true },
    _max: { date: true },
  });
  return new Map(groups.map((g) => [g.goalId, { saved: g._sum.amountCents ?? 0, count: g._count._all, last: g._max.date }]));
}

async function sumSaved(db: Db, goalId: string): Promise<number> {
  const agg = await db.goalContribution.aggregate({ where: { goalId, deletedAt: null }, _sum: { amountCents: true } });
  return agg._sum.amountCents ?? 0;
}

async function toGoalDTOs(ctx: ServiceContext, goals: FinancialGoal[], db: Db = prisma): Promise<GoalDTO[]> {
  if (!goals.length) return [];
  const today = todayISO(ctx.timezone);
  const sums = await savedByGoal(db, goals.map((g) => g.id));
  const accountIds = [...new Set(goals.map((g) => g.accountId).filter(Boolean))] as string[];
  const accounts = accountIds.length
    ? await db.account.findMany({ where: { AND: [visibleAccountWhere(ctx), { id: { in: accountIds } }] }, select: { id: true, name: true, color: true } })
    : [];
  const accMap = new Map(accounts.map((a) => [a.id, a]));
  return goals.map((g) => {
    const s = sums.get(g.id) ?? { saved: 0, count: 0, last: null };
    const deadline = g.deadline ? dateToISO(g.deadline) : null;
    return {
      id: g.id,
      name: g.name,
      targetCents: g.targetCents,
      deadline,
      status: g.status,
      color: g.color,
      icon: g.icon,
      notes: g.notes,
      accountId: g.accountId,
      account: g.accountId ? accMap.get(g.accountId) ?? null : null,
      contributionsCount: s.count,
      lastContributionDate: s.last ? dateToISO(s.last) : null,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
      ...computeGoalProgress({ targetCents: g.targetCents, deadline }, s.saved, today),
    };
  });
}

const contributionInclude = {
  member: { select: { id: true, displayName: true } },
  transaction: { select: { id: true, deletedAt: true, account: { select: { name: true } }, destinationAccount: { select: { name: true } } } },
} satisfies Prisma.GoalContributionInclude;

type ContributionRow = Prisma.GoalContributionGetPayload<{ include: typeof contributionInclude }>;

function toContributionDTO(c: ContributionRow): ContributionDTO {
  return {
    id: c.id,
    goalId: c.goalId,
    amountCents: c.amountCents,
    date: dateToISO(c.date),
    kind: c.transactionId ? "TRANSFER" : "ALLOCATION",
    note: c.note,
    member: c.member,
    transaction: c.transaction
      ? {
          id: c.transaction.id,
          fromAccount: c.transaction.account?.name ?? null,
          toAccount: c.transaction.destinationAccount?.name ?? null,
          deletedAt: c.transaction.deletedAt?.toISOString() ?? null,
        }
      : null,
    sourceMessageId: c.sourceMessageId,
    createdAt: c.createdAt.toISOString(),
    deletedAt: c.deletedAt?.toISOString() ?? null,
  };
}

// -----------------------------------------------------------------------------
// Consulta
// -----------------------------------------------------------------------------

async function findGoalOrThrow(ctx: ServiceContext, id: string, db: Db = prisma): Promise<FinancialGoal> {
  const goal = await db.financialGoal.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!goal) throw new NotFoundError("Meta");
  return goal;
}

/** Metas com progresso (arquivadas somente quando solicitadas). */
export async function listGoals(ctx: ServiceContext, params: z.input<typeof goalListSchema> = {}) {
  const f = goalListSchema.parse(params);
  const goals = await prisma.financialGoal.findMany({
    where: {
      householdId: ctx.householdId,
      ...(f.status ? { status: f.status } : f.includeArchived ? {} : { status: { not: "ARCHIVED" } }),
    },
    orderBy: [{ status: "asc" }, { deadline: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  const items = await toGoalDTOs(ctx, goals);
  const active = items.filter((g) => g.status === "ACTIVE");
  return {
    items,
    totals: {
      activeCount: active.length,
      targetCents: active.reduce((s, g) => s + g.targetCents, 0),
      savedCents: active.reduce((s, g) => s + g.savedCents, 0),
      monthlyNeededCents: active.reduce((s, g) => s + (g.monthlyNeededCents ?? 0), 0),
    },
  };
}

export async function getGoal(ctx: ServiceContext, id: string): Promise<GoalDTO & { recentContributions: ContributionDTO[] }> {
  const goal = await findGoalOrThrow(ctx, id);
  const [dto] = await toGoalDTOs(ctx, [goal]);
  const recent = await prisma.goalContribution.findMany({
    where: { goalId: id, householdId: ctx.householdId, deletedAt: null },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 10,
    include: contributionInclude,
  });
  return { ...dto!, recentContributions: recent.map(toContributionDTO) };
}

/** Histórico de contribuições e resgates da meta. */
export async function listContributions(ctx: ServiceContext, goalId: string, params: z.input<typeof contributionListSchema> = {}) {
  const f = contributionListSchema.parse(params);
  await findGoalOrThrow(ctx, goalId);
  const limit = f.limit ?? 50;
  const rows = await prisma.goalContribution.findMany({
    where: { goalId, householdId: ctx.householdId, ...(f.includeDeleted ? {} : { deletedAt: null }) },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    include: contributionInclude,
  });
  return { items: rows.slice(0, limit).map(toContributionDTO), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

async function validateGoalAccount(ctx: ServiceContext, accountId: string | null | undefined, db: Db = prisma) {
  if (!accountId) return;
  const acc = await db.account.findFirst({ where: { AND: [visibleAccountWhere(ctx), { id: accountId }] }, select: { archivedAt: true } });
  if (!acc) throw new ValidationError("Conta inválida.", { field: "accountId" });
  if (acc.archivedAt) throw new ValidationError("A conta selecionada está arquivada.", { field: "accountId" });
}

async function assertUniqueName(ctx: ServiceContext, name: string, exceptId?: string) {
  const exists = await prisma.financialGoal.findFirst({
    where: { householdId: ctx.householdId, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (exists) throw new ConflictError("Já existe uma meta com este nome.");
}

function goalSnapshot(g: FinancialGoal) {
  return {
    name: g.name,
    targetCents: g.targetCents,
    deadline: g.deadline ? dateToISO(g.deadline) : null,
    accountId: g.accountId,
    color: g.color,
    icon: g.icon,
    status: g.status,
    notes: g.notes,
  };
}

export async function createGoal(ctx: ServiceContext, input: GoalCreateInput): Promise<GoalDTO> {
  assertCan(ctx, "goals:write");
  const data = goalCreateSchema.parse(input);
  await validateGoalAccount(ctx, data.accountId);
  await assertUniqueName(ctx, data.name);
  const goal = await prisma.financialGoal.create({
    data: {
      householdId: ctx.householdId,
      name: data.name,
      targetCents: data.targetCents,
      deadline: data.deadline ? isoToDate(data.deadline) : null,
      accountId: data.accountId ?? null,
      color: data.color,
      icon: data.icon,
      notes: data.notes ?? null,
    },
  });
  await audit(ctx, { action: "CREATE", entityType: "FinancialGoal", entityId: goal.id, after: goalSnapshot(goal) });
  await publishEvent(ctx.householdId, "goal.changed", goal.id);
  return (await toGoalDTOs(ctx, [goal]))[0]!;
}

export async function updateGoal(ctx: ServiceContext, id: string, input: GoalUpdateInput): Promise<GoalDTO> {
  assertCan(ctx, "goals:write");
  const data = goalUpdateSchema.parse(input);
  const current = await findGoalOrThrow(ctx, id);
  if (data.accountId !== undefined && data.accountId !== current.accountId) await validateGoalAccount(ctx, data.accountId);
  if (data.name && data.name.toLowerCase() !== current.name.toLowerCase()) await assertUniqueName(ctx, data.name, id);

  let status = data.status ?? current.status;
  const targetCents = data.targetCents ?? current.targetCents;
  // Mudança no valor desejado sem status explícito: o status acompanha o progresso.
  if (data.status === undefined && data.targetCents !== undefined && data.targetCents !== current.targetCents && current.status !== "ARCHIVED") {
    const saved = await sumSaved(prisma, id);
    status = saved >= targetCents ? "COMPLETED" : "ACTIVE";
  }

  const updated = await prisma.financialGoal.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      targetCents,
      ...(data.deadline !== undefined ? { deadline: data.deadline ? isoToDate(data.deadline) : null } : {}),
      ...(data.accountId !== undefined ? { accountId: data.accountId ?? null } : {}),
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.icon !== undefined ? { icon: data.icon } : {}),
      ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
      status,
    },
  });
  await audit(ctx, { action: "UPDATE", entityType: "FinancialGoal", entityId: id, before: goalSnapshot(current), after: goalSnapshot(updated) });
  await publishEvent(ctx.householdId, "goal.changed", id);
  return (await toGoalDTOs(ctx, [updated]))[0]!;
}

/**
 * Exclui a meta e seu histórico de contribuições. Transferências já realizadas permanecem no
 * extrato (o dinheiro de fato mudou de conta); apenas deixam de estar vinculadas à meta.
 */
export async function deleteGoal(ctx: ServiceContext, id: string): Promise<void> {
  assertCan(ctx, "goals:write");
  const current = await findGoalOrThrow(ctx, id);
  const saved = await sumSaved(prisma, id);
  await withTransaction(async (db) => {
    await db.financialGoal.delete({ where: { id } });
    await audit(ctx, { action: "DELETE", entityType: "FinancialGoal", entityId: id, before: { ...goalSnapshot(current), savedCents: saved } }, db);
  });
  await publishEvent(ctx.householdId, "goal.changed", id);
}

// -----------------------------------------------------------------------------
// Contribuições
// -----------------------------------------------------------------------------

async function autoComplete(ctx: ServiceContext, db: Db, goal: FinancialGoal, savedCents: number): Promise<boolean> {
  if (goal.status !== "ACTIVE" || savedCents < goal.targetCents) return false;
  await db.financialGoal.update({ where: { id: goal.id }, data: { status: "COMPLETED" } });
  await audit(
    ctx,
    {
      action: "UPDATE",
      entityType: "FinancialGoal",
      entityId: goal.id,
      before: { status: goal.status },
      after: { status: "COMPLETED" },
      source: "auto",
      metadata: { reason: "Valor desejado atingido", savedCents, targetCents: goal.targetCents },
    },
    db,
  );
  return true;
}

export interface ContributeOptions {
  /** Origem da transferência (ex.: WHATSAPP_TEXT quando registrada pelo grupo). Padrão: MANUAL. */
  source?: TransactionSource;
  /** Posição do lançamento dentro da mensagem de origem (mensagens com vários lançamentos). */
  sourceIndex?: number;
}

export interface ContributeResult {
  contribution: ContributionDTO;
  goal: GoalDTO;
  transaction: TransactionDTO | null;
  created: boolean;
  completedNow: boolean;
}

/**
 * Registra uma contribuição (valor positivo) ou resgate (valor negativo) na meta.
 *
 * - Com `fromAccountId` diferente da conta vinculada à meta: cria uma TRANSFERÊNCIA entre as contas
 *   (contribuição: origem → conta da meta; resgate: conta da meta → origem) e vincula a contribuição.
 * - Caso contrário: alocação interna (sem movimento de caixa).
 * Nunca gera despesa. Marca a meta como concluída quando o acumulado atinge o valor desejado.
 * Idempotente por `sourceMessageId`.
 */
export async function contributeToGoal(ctx: ServiceContext, goalId: string, input: ContributionInput, opts: ContributeOptions = {}): Promise<ContributeResult> {
  assertCan(ctx, "goals:write");
  const data = contributionSchema.parse(input);
  const goal = await findGoalOrThrow(ctx, goalId);
  if (goal.status === "ARCHIVED") throw new ValidationError("Esta meta está arquivada. Reative-a para registrar contribuições.");

  if (data.sourceMessageId) {
    const existing = await prisma.goalContribution.findFirst({
      where: { householdId: ctx.householdId, goalId, sourceMessageId: data.sourceMessageId, deletedAt: null },
      include: contributionInclude,
    });
    if (existing) {
      return { contribution: toContributionDTO(existing), goal: (await toGoalDTOs(ctx, [goal]))[0]!, transaction: null, created: false, completedNow: false };
    }
  }

  const date = data.date ?? todayISO(ctx.timezone);
  const fromAccountId = data.fromAccountId ?? null;
  if (fromAccountId) await validateGoalAccount(ctx, fromAccountId);
  const useTransfer = Boolean(fromAccountId && goal.accountId && fromAccountId !== goal.accountId);
  const amount = data.amountCents;

  const result = await withTransaction(async (db) => {
    const saved = await sumSaved(db, goalId);
    if (amount < 0 && saved + amount < 0) {
      throw new ValidationError(`O resgate é maior que o valor acumulado na meta (${formatBRL(saved)}).`, { field: "amountCents" });
    }

    let transaction: TransactionDTO | null = null;
    if (useTransfer) {
      const isWithdrawal = amount < 0;
      const res = await createTransaction(
        ctx,
        {
          type: "TRANSFER",
          amountCents: Math.abs(amount),
          description: isWithdrawal ? `Resgate da meta ${goal.name}` : `Meta ${goal.name}`,
          notes: data.note ?? null,
          date,
          accountId: isWithdrawal ? goal.accountId : fromAccountId,
          destinationAccountId: isWithdrawal ? fromAccountId : goal.accountId,
          goalId,
        },
        { source: opts.source ?? "MANUAL", sourceMessageId: data.sourceMessageId ?? null, sourceIndex: opts.sourceIndex, checkDuplicates: false, applyRules: false, db },
      );
      if (!res.created && res.transaction.goalId !== goalId) {
        throw new ConflictError("A mensagem de origem já gerou outro lançamento nesta posição.");
      }
      transaction = res.transaction;
    }

    const contribution = await db.goalContribution.create({
      data: {
        householdId: ctx.householdId,
        goalId,
        amountCents: amount,
        date: isoToDate(date),
        memberId: ctx.memberId,
        transactionId: transaction?.id ?? null,
        sourceMessageId: data.sourceMessageId ?? null,
        note: data.note ?? null,
      },
      include: contributionInclude,
    });
    await audit(
      ctx,
      {
        action: "CREATE",
        entityType: "GoalContribution",
        entityId: contribution.id,
        after: { goalId, amountCents: amount, date, kind: transaction ? "TRANSFER" : "ALLOCATION", transactionId: transaction?.id ?? null },
        metadata: data.sourceMessageId ? { sourceMessageId: data.sourceMessageId } : null,
      },
      db,
    );
    const completedNow = await autoComplete(ctx, db, goal, saved + amount);
    const freshGoal = await db.financialGoal.findUniqueOrThrow({ where: { id: goalId } });
    const goalDTO = (await toGoalDTOs(ctx, [freshGoal], db))[0]!;
    return { contribution: toContributionDTO(contribution), goal: goalDTO, transaction, completedNow };
  });

  await publishEvent(ctx.householdId, "goal.changed", goalId);
  if (result.transaction) {
    await publishEvent(ctx.householdId, "transaction.changed", result.transaction.id);
    await publishEvent(ctx.householdId, "account.changed");
  }
  return { ...result, created: true };
}

/**
 * Exclui (logicamente) uma contribuição. Se ela gerou uma transferência, a transação é excluída
 * pelo serviço de transações (os saldos voltam ao estado anterior). Se a meta estava concluída e o
 * acumulado ficou abaixo do valor desejado, ela volta a ficar ativa.
 */
export async function deleteContribution(ctx: ServiceContext, contributionId: string): Promise<{ goal: GoalDTO }> {
  assertCan(ctx, "goals:write");
  const contribution = await prisma.goalContribution.findFirst({ where: { id: contributionId, householdId: ctx.householdId } });
  if (!contribution) throw new NotFoundError("Contribuição");
  if (contribution.deletedAt) {
    const goal = await findGoalOrThrow(ctx, contribution.goalId);
    return { goal: (await toGoalDTOs(ctx, [goal]))[0]! };
  }

  const goalDTO = await withTransaction(async (db) => {
    if (contribution.amountCents > 0 && (await sumSaved(db, contribution.goalId)) - contribution.amountCents < 0) {
      throw new ValidationError("Não é possível excluir: o acumulado da meta ficaria negativo. Exclua antes os resgates correspondentes.");
    }
    if (contribution.transactionId) {
      await deleteTransaction(ctx, contribution.transactionId, { db, reason: "Contribuição de meta excluída" });
    }
    await db.goalContribution.update({ where: { id: contributionId }, data: { deletedAt: new Date() } });
    await audit(
      ctx,
      {
        action: "DELETE",
        entityType: "GoalContribution",
        entityId: contributionId,
        before: { goalId: contribution.goalId, amountCents: contribution.amountCents, date: dateToISO(contribution.date), transactionId: contribution.transactionId },
      },
      db,
    );
    const goal = await db.financialGoal.findUniqueOrThrow({ where: { id: contribution.goalId } });
    const saved = await sumSaved(db, goal.id);
    let current = goal;
    if (goal.status === "COMPLETED" && saved < goal.targetCents) {
      current = await db.financialGoal.update({ where: { id: goal.id }, data: { status: "ACTIVE" } });
      await audit(
        ctx,
        {
          action: "UPDATE",
          entityType: "FinancialGoal",
          entityId: goal.id,
          before: { status: "COMPLETED" },
          after: { status: "ACTIVE" },
          source: "auto",
          metadata: { reason: "Contribuição excluída; acumulado abaixo do valor desejado", savedCents: saved },
        },
        db,
      );
    }
    return (await toGoalDTOs(ctx, [current], db))[0]!;
  });

  await publishEvent(ctx.householdId, "goal.changed", contribution.goalId);
  if (contribution.transactionId) {
    await publishEvent(ctx.householdId, "transaction.changed", contribution.transactionId);
    await publishEvent(ctx.householdId, "account.changed");
  }
  return { goal: goalDTO };
}

// -----------------------------------------------------------------------------
// Busca por nome (motor de IA: "Separei 500 reais para a viagem")
// -----------------------------------------------------------------------------

const NAME_STOPWORDS = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "para", "pra", "pro", "minha", "meu", "nossa", "nosso", "meta", "e", "em", "no", "na", "um", "uma"]);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ens")) return `${token.slice(0, -3)}em`;
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function nameTokens(text: string): string[] {
  return [...new Set(normalizeText(text).split(" ").filter((t) => t.length > 1 && !NAME_STOPWORDS.has(t)).map(stem))];
}

/** Similaridade (0..1) entre o termo citado e o nome da meta. */
export function goalNameScore(query: string, goalName: string): number {
  const nq = normalizeText(query);
  const ng = normalizeText(goalName);
  if (!nq || !ng) return 0;
  if (nq === ng) return 1;
  const qt = nameTokens(query);
  const gt = nameTokens(goalName);
  if (!qt.length || !gt.length) return 0;
  if (qt.join(" ") === gt.join(" ")) return 0.95;
  const matches = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  const covered = qt.filter((t) => gt.some((g) => matches(t, g))).length;
  const coverage = 0.6 * (covered / qt.length) + 0.4 * (covered / gt.length);
  return Math.max(tokenSimilarity(query, goalName), Math.round(coverage * 1000) / 1000);
}

export interface GoalMatch {
  id: string;
  name: string;
  status: GoalStatus;
  accountId: string | null;
  targetCents: number;
  score: number;
  /** Há outra meta com pontuação muito próxima: o chamador pode pedir confirmação. */
  ambiguous: boolean;
  candidates: Array<{ id: string; name: string; score: number }>;
}

/** Busca aproximada de meta pelo nome (ignora acentos, maiúsculas, artigos e plurais simples). */
export async function findGoalByName(ctx: ServiceContext, name: string, opts: { minScore?: number } = {}): Promise<GoalMatch | null> {
  const minScore = opts.minScore ?? 0.5;
  const goals = await prisma.financialGoal.findMany({
    where: { householdId: ctx.householdId, status: { in: ["ACTIVE", "COMPLETED"] } },
    select: { id: true, name: true, status: true, accountId: true, targetCents: true },
  });
  const ranked = goals
    .map((g) => ({ goal: g, score: goalNameScore(name, g.name) + (g.status === "ACTIVE" ? 0.001 : 0) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return null;
  const second = ranked[1];
  return {
    id: best.goal.id,
    name: best.goal.name,
    status: best.goal.status,
    accountId: best.goal.accountId,
    targetCents: best.goal.targetCents,
    score: Math.min(1, Math.round(best.score * 1000) / 1000),
    ambiguous: Boolean(second && best.score - second.score < 0.1),
    candidates: ranked.slice(0, 5).map((r) => ({ id: r.goal.id, name: r.goal.name, score: Math.min(1, Math.round(r.score * 1000) / 1000) })),
  };
}
