import { z } from "zod";
import type { IncomeGoal, ReportScope } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { daysInMonth, diffDays, endOfMonth, formatMonthBR, isMonthKey, monthKey, monthRange, todayISO, type MonthKey } from "@/lib/dates";
import { formatBRL, MAX_AMOUNT_CENTS } from "@/lib/money";
import { audit } from "../audit/service";
import { getSettings } from "../households/service";
import { recognizedRows, resolveRegime } from "../analytics/service";
import { idSchema } from "../transactions/schemas";

/**
 * Meta de ganho: receita do mês por recorte (Pessoa física / Empresa / Tudo) e, opcionalmente, por
 * categoria de receita. Conta a receita reconhecida no regime da família; repasses (desconsiderados
 * nos relatórios) nunca entram. A meta vale todo mês até ser desativada.
 */

export const INCOME_GOAL_SCOPES = ["ALL", "PERSONAL", "BUSINESS"] as const satisfies readonly ReportScope[];
export const INCOME_GOAL_SCOPE_LABELS: Record<ReportScope, string> = { ALL: "Tudo", PERSONAL: "Pessoa física", BUSINESS: "Empresa" };

const thresholdsSchema = z
  .array(z.number().int().min(1).max(200))
  .max(8)
  .transform((v) => [...new Set(v)].sort((a, b) => a - b));

export const incomeGoalSchema = z.object({
  scope: z.enum(INCOME_GOAL_SCOPES).default("ALL"),
  categoryId: idSchema.nullish(),
  targetCents: z.number().int().positive().max(MAX_AMOUNT_CENTS),
  /** Faixas de aviso próprias; vazio = as mesmas do orçamento. */
  alertThresholds: thresholdsSchema.default([]),
  active: z.boolean().default(true),
});
export type IncomeGoalInput = z.input<typeof incomeGoalSchema>;
export const incomeGoalUpdateSchema = z.object({
  scope: z.enum(INCOME_GOAL_SCOPES).optional(),
  categoryId: idSchema.nullish(),
  targetCents: z.number().int().positive().max(MAX_AMOUNT_CENTS).optional(),
  alertThresholds: thresholdsSchema.optional(),
  active: z.boolean().optional(),
});

export interface IncomeGoalProgress {
  id: string;
  scope: ReportScope;
  scopeLabel: string;
  categoryId: string | null;
  categoryName: string | null;
  /** "Meta de ganho · Empresa" / "Meta de ganho · Clientes (Pessoa física)". */
  label: string;
  targetCents: number;
  alertThresholds: number[];
  /** Faixas em uso (as próprias ou as do orçamento). */
  effectiveThresholds: number[];
  active: boolean;
  month: MonthKey;
  incomeCents: number;
  percent: number;
  remainingCents: number;
  reached: boolean;
  /** Projeção pelo ritmo do mês (receita até hoje ÷ dias passados × dias do mês); só no mês corrente. */
  projectedCents: number | null;
  /** Dias que faltam no mês (incluindo hoje); 0 em meses passados. */
  daysLeft: number;
}

/** Nome do mês sem o ano ("outubro"). */
export function monthName(month: MonthKey): string {
  return formatMonthBR(month).split(" de ")[0]!;
}

export function incomeGoalLabel(goal: { scope: ReportScope; categoryName?: string | null }): string {
  const scope = goal.scope === "ALL" ? null : INCOME_GOAL_SCOPE_LABELS[goal.scope];
  if (goal.categoryName) return `Meta de ganho · ${goal.categoryName}${scope ? ` (${scope})` : ""}`;
  return `Meta de ganho${scope ? ` · ${scope}` : ""}`;
}

/** Receita reconhecida no mês, no recorte (e na categoria) da meta. */
export async function incomeForGoal(ctx: ServiceContext, goal: Pick<IncomeGoal, "scope" | "categoryId">, month: MonthKey): Promise<number> {
  const regime = await resolveRegime(ctx);
  const rows = await recognizedRows(ctx, monthRange(month), regime, { scope: goal.scope, categoryIds: goal.categoryId ? [goal.categoryId] : null });
  return rows.filter((r) => r.type === "INCOME").reduce((s, r) => s + r.amountCents, 0);
}

export function computeIncomeProgress(targetCents: number, incomeCents: number, month: MonthKey, today: string) {
  const percent = targetCents > 0 ? Math.floor((incomeCents * 100) / targetCents) : 0;
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = daysInMonth(y, m);
  const current = monthKey(today) === month;
  const elapsed = current ? Number(today.slice(8, 10)) : total;
  const daysLeft = current ? diffDays(endOfMonth(today), today) + 1 : monthKey(today) < month ? total : 0;
  return {
    percent,
    remainingCents: Math.max(0, targetCents - incomeCents),
    reached: incomeCents >= targetCents,
    projectedCents: current ? Math.round((incomeCents / Math.max(1, elapsed)) * total) : null,
    daysLeft,
  };
}

async function validateCategory(ctx: ServiceContext, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const cat = await prisma.category.findFirst({ where: { id: categoryId, householdId: ctx.householdId } });
  if (!cat) throw new ValidationError("Categoria inválida.", { field: "categoryId" });
  if (cat.kind !== "INCOME") throw new ValidationError("Use uma categoria de receita.", { field: "categoryId" });
}

/** Uma meta ativa por recorte + categoria (a mesma combinação atualiza a existente). */
async function assertUnique(ctx: ServiceContext, scope: ReportScope, categoryId: string | null, exceptId?: string) {
  const other = await prisma.incomeGoal.findFirst({ where: { householdId: ctx.householdId, active: true, scope, categoryId, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (other) throw new ValidationError("Já existe uma meta de ganho ativa para este recorte e categoria. Edite a existente.", { field: "scope" });
}

export async function listIncomeGoals(ctx: ServiceContext, opts: { month?: string; includeInactive?: boolean } = {}): Promise<IncomeGoalProgress[]> {
  const today = todayISO(ctx.timezone);
  const month = opts.month && isMonthKey(opts.month) ? opts.month : monthKey(today);
  const goals = await prisma.incomeGoal.findMany({
    where: { householdId: ctx.householdId, ...(opts.includeInactive ? {} : { active: true }) },
    include: { category: { select: { name: true } } },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  if (!goals.length) return [];
  const settings = await getSettings(ctx.householdId);
  const out: IncomeGoalProgress[] = [];
  for (const g of goals) {
    const incomeCents = await incomeForGoal(ctx, g, month);
    out.push({
      id: g.id,
      scope: g.scope,
      scopeLabel: INCOME_GOAL_SCOPE_LABELS[g.scope],
      categoryId: g.categoryId,
      categoryName: g.category?.name ?? null,
      label: incomeGoalLabel({ scope: g.scope, categoryName: g.category?.name }),
      targetCents: g.targetCents,
      alertThresholds: g.alertThresholds,
      effectiveThresholds: effectiveThresholds(g.alertThresholds, settings.budgetAlertThresholds),
      active: g.active,
      month,
      incomeCents,
      ...computeIncomeProgress(g.targetCents, incomeCents, month, today),
    });
  }
  return out;
}

export function effectiveThresholds(own: number[], budget: number[]): number[] {
  return [...new Set(own.length ? own : budget)].filter((t) => t > 0).sort((a, b) => a - b);
}

export async function createIncomeGoal(ctx: ServiceContext, raw: IncomeGoalInput, source: "USER" | "WHATSAPP" = "USER") {
  assertCan(ctx, "goals:write");
  const data = incomeGoalSchema.parse(raw);
  await validateCategory(ctx, data.categoryId);
  if (data.active) await assertUnique(ctx, data.scope, data.categoryId ?? null);
  const goal = await prisma.incomeGoal.create({ data: { ...data, categoryId: data.categoryId ?? null, householdId: ctx.householdId, createdById: ctx.memberId } });
  await audit(ctx, { action: "CREATE", entityType: "IncomeGoal", entityId: goal.id, after: goal, source });
  await publishEvent(ctx.householdId, "goal.changed", goal.id);
  return goal;
}

export async function updateIncomeGoal(ctx: ServiceContext, id: string, raw: z.input<typeof incomeGoalUpdateSchema>, source: "USER" | "WHATSAPP" = "USER") {
  assertCan(ctx, "goals:write");
  const data = incomeGoalUpdateSchema.parse(raw);
  const current = await prisma.incomeGoal.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Meta de ganho");
  if (data.categoryId !== undefined) await validateCategory(ctx, data.categoryId);
  const next = { scope: data.scope ?? current.scope, categoryId: data.categoryId === undefined ? current.categoryId : data.categoryId ?? null, active: data.active ?? current.active };
  if (next.active) await assertUnique(ctx, next.scope, next.categoryId, id);
  const updated = await prisma.incomeGoal.update({ where: { id }, data: { ...data, categoryId: next.categoryId } });
  await audit(ctx, { action: "UPDATE", entityType: "IncomeGoal", entityId: id, before: current, after: updated, source });
  await publishEvent(ctx.householdId, "goal.changed", id);
  return updated;
}

export async function deleteIncomeGoal(ctx: ServiceContext, id: string) {
  assertCan(ctx, "goals:write");
  const current = await prisma.incomeGoal.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Meta de ganho");
  await prisma.incomeGoal.delete({ where: { id } });
  await audit(ctx, { action: "DELETE", entityType: "IncomeGoal", entityId: id, before: current });
  await publishEvent(ctx.householdId, "goal.changed", id);
}

/**
 * "meta de ganho da empresa 30 mil": cria a meta do recorte (sem categoria) ou atualiza o valor da
 * existente. Devolve se foi criada.
 */
export async function setIncomeGoal(ctx: ServiceContext, scope: ReportScope, targetCents: number): Promise<{ goal: IncomeGoal; created: boolean; previousCents: number | null }> {
  const existing = await prisma.incomeGoal.findFirst({ where: { householdId: ctx.householdId, active: true, scope, categoryId: null } });
  if (existing) {
    const goal = await updateIncomeGoal(ctx, existing.id, { targetCents }, "WHATSAPP");
    return { goal, created: false, previousCents: existing.targetCents };
  }
  return { goal: await createIncomeGoal(ctx, { scope, targetCents }, "WHATSAPP"), created: true, previousCents: null };
}

/** Linha de resumo: "Meta de ganho · Empresa (outubro): R$ 22.500 de R$ 30.000 (75%) — faltam R$ 7.500 em 6 dias." */
export function progressLine(p: IncomeGoalProgress): string {
  const head = `${p.label} (${monthName(p.month)}): ${formatBRL(p.incomeCents)} de ${formatBRL(p.targetCents)} (${p.percent}%)`;
  if (p.reached) return `${head} — meta batida! 🎉`;
  const days = p.daysLeft ? ` em ${p.daysLeft} dia${p.daysLeft === 1 ? "" : "s"}` : "";
  const projection = p.projectedCents !== null ? ` Pelo ritmo do mês: ${formatBRL(p.projectedCents)}.` : "";
  return `${head} — faltam ${formatBRL(p.remainingCents)}${days}.${projection}`;
}
