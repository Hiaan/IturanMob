import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../db";
import { systemContext, type ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { addMonthsToKey, isMonthKey, monthKey, monthRange, monthsBetween, MONTH_NAMES, todayISO, type MonthKey } from "@/lib/dates";
import { formatBRL, percentOf } from "@/lib/money";
import { audit } from "../audit/service";
import { budgetOverview, recognizedRows, resolveRegime } from "../analytics/service";
import { getSettings } from "../households/service";
import { notify } from "../notifications/service";
import { amountCentsSchema, idSchema } from "../transactions/schemas";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

export const monthKeySchema = z.string().refine((v) => isMonthKey(v), "Mês inválido (use AAAA-MM)");
const regimeSchema = z.enum(["ACCRUAL", "CASH"]);

export const budgetUpsertSchema = z.object({
  categoryId: idSchema,
  month: monthKeySchema,
  limitCents: amountCentsSchema,
});
export type BudgetUpsertInput = z.input<typeof budgetUpsertSchema>;

export const budgetUpdateSchema = z.object({ limitCents: amountCentsSchema });

export const budgetBulkSchema = z.object({
  month: monthKeySchema,
  /** `limitCents` nulo ou zero remove o orçamento da categoria no mês. */
  items: z
    .array(z.object({ categoryId: idSchema, limitCents: z.number().int().min(0).max(1_000_000_000).nullable() }))
    .min(1)
    .max(200),
});
export type BudgetBulkInput = z.input<typeof budgetBulkSchema>;

export const budgetCopySchema = z.object({ month: monthKeySchema });

export const budgetListSchema = z.object({ month: monthKeySchema.optional(), regime: regimeSchema.optional() });

export const budgetHistorySchema = z.object({
  months: z.number().int().min(1).max(24).default(6),
  endMonth: monthKeySchema.optional(),
  categoryId: idSchema.optional(),
  regime: regimeSchema.optional(),
});

// -----------------------------------------------------------------------------
// Consulta
// -----------------------------------------------------------------------------

function currentMonth(ctx: ServiceContext): MonthKey {
  return monthKey(todayISO(ctx.timezone));
}

/**
 * Orçamentos do mês (limite × realizado por categoria, no regime padrão da família),
 * com os limiares de alerta já atingidos e as categorias de despesa ainda sem orçamento.
 */
export async function listBudgets(ctx: ServiceContext, params: z.input<typeof budgetListSchema> = {}) {
  const f = budgetListSchema.parse(params);
  const month = f.month ?? currentMonth(ctx);
  const overview = await budgetOverview(ctx, month, f.regime);
  const budgetIds = overview.items.map((i) => i.budgetId);
  const [alerts, categories] = await Promise.all([
    budgetIds.length ? prisma.budgetAlert.findMany({ where: { budgetId: { in: budgetIds } }, orderBy: { threshold: "asc" } }) : Promise.resolve([]),
    prisma.category.findMany({
      where: { householdId: ctx.householdId, kind: "EXPENSE", archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, color: true, icon: true },
    }),
  ]);
  const budgeted = new Set(overview.items.map((i) => i.category.id));
  return {
    ...overview,
    items: overview.items.map((i) => ({
      ...i,
      alertsTriggered: alerts.filter((a) => a.budgetId === i.budgetId).map((a) => a.threshold),
    })),
    unbudgetedCategories: categories.filter((c) => !budgeted.has(c.id)),
  };
}

// -----------------------------------------------------------------------------
// Mutações
// -----------------------------------------------------------------------------

async function assertExpenseCategory(ctx: ServiceContext, categoryId: string, db: Db = prisma) {
  const cat = await db.category.findFirst({ where: { id: categoryId, householdId: ctx.householdId }, select: { id: true, kind: true, archivedAt: true, name: true } });
  if (!cat) throw new ValidationError("Categoria inválida.", { field: "categoryId" });
  if (cat.kind !== "EXPENSE") throw new ValidationError("Orçamentos são definidos apenas para categorias de despesa.", { field: "categoryId" });
  if (cat.archivedAt) throw new ValidationError(`A categoria ${cat.name} está arquivada.`, { field: "categoryId" });
  return cat;
}

/** Cria ou atualiza o limite de uma categoria no mês. */
export async function upsertBudget(ctx: ServiceContext, input: BudgetUpsertInput) {
  assertCan(ctx, "budgets:write");
  const data = budgetUpsertSchema.parse(input);
  await assertExpenseCategory(ctx, data.categoryId);
  const key = { householdId_categoryId_month: { householdId: ctx.householdId, categoryId: data.categoryId, month: data.month } };
  const before = await prisma.budget.findUnique({ where: key });
  const budget = await prisma.budget.upsert({
    where: key,
    update: { limitCents: data.limitCents },
    create: { householdId: ctx.householdId, categoryId: data.categoryId, month: data.month, limitCents: data.limitCents },
  });
  await audit(ctx, { action: before ? "UPDATE" : "CREATE", entityType: "Budget", entityId: budget.id, before: before ?? undefined, after: budget });
  await publishEvent(ctx.householdId, "budget.changed", budget.id);
  return budget;
}

export async function updateBudget(ctx: ServiceContext, id: string, input: z.input<typeof budgetUpdateSchema>) {
  assertCan(ctx, "budgets:write");
  const data = budgetUpdateSchema.parse(input);
  const current = await prisma.budget.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Orçamento");
  const updated = await prisma.budget.update({ where: { id }, data: { limitCents: data.limitCents } });
  await audit(ctx, { action: "UPDATE", entityType: "Budget", entityId: id, before: current, after: updated });
  await publishEvent(ctx.householdId, "budget.changed", id);
  return updated;
}

export async function deleteBudget(ctx: ServiceContext, id: string): Promise<void> {
  assertCan(ctx, "budgets:write");
  const current = await prisma.budget.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Orçamento");
  await prisma.budget.delete({ where: { id } });
  await audit(ctx, { action: "DELETE", entityType: "Budget", entityId: id, before: current });
  await publishEvent(ctx.householdId, "budget.changed", id);
}

/** Define vários limites de uma vez (limite nulo/zero remove o orçamento da categoria). */
export async function setBudgetsBulk(ctx: ServiceContext, input: BudgetBulkInput) {
  assertCan(ctx, "budgets:write");
  const data = budgetBulkSchema.parse(input);
  const ids = data.items.map((i) => i.categoryId);
  if (new Set(ids).size !== ids.length) throw new ValidationError("Cada categoria pode aparecer apenas uma vez.", { field: "items" });

  const result = await withTransaction(async (db) => {
    let upserted = 0;
    let removed = 0;
    for (const item of data.items) {
      const key = { householdId_categoryId_month: { householdId: ctx.householdId, categoryId: item.categoryId, month: data.month } };
      const before = await db.budget.findUnique({ where: key });
      if (!item.limitCents) {
        if (before) {
          await db.budget.delete({ where: { id: before.id } });
          await audit(ctx, { action: "DELETE", entityType: "Budget", entityId: before.id, before, source: "bulk" }, db);
          removed++;
        }
        continue;
      }
      await assertExpenseCategory(ctx, item.categoryId, db);
      if (before?.limitCents === item.limitCents) continue;
      const budget = await db.budget.upsert({
        where: key,
        update: { limitCents: item.limitCents },
        create: { householdId: ctx.householdId, categoryId: item.categoryId, month: data.month, limitCents: item.limitCents },
      });
      await audit(ctx, { action: before ? "UPDATE" : "CREATE", entityType: "Budget", entityId: budget.id, before: before ?? undefined, after: budget, source: "bulk" }, db);
      upserted++;
    }
    return { upserted, removed };
  });
  await publishEvent(ctx.householdId, "budget.changed");
  return { ...result, month: data.month };
}

/** Copia os orçamentos do mês anterior sem sobrescrever os já definidos no mês de destino. */
export async function copyPreviousMonth(ctx: ServiceContext, input: z.input<typeof budgetCopySchema>) {
  assertCan(ctx, "budgets:write");
  const { month } = budgetCopySchema.parse(input);
  const source = addMonthsToKey(month, -1);
  const [previous, existing] = await Promise.all([
    prisma.budget.findMany({ where: { householdId: ctx.householdId, month: source, category: { archivedAt: null, kind: "EXPENSE" } } }),
    prisma.budget.findMany({ where: { householdId: ctx.householdId, month }, select: { categoryId: true } }),
  ]);
  const taken = new Set(existing.map((e) => e.categoryId));
  const toCopy = previous.filter((p) => !taken.has(p.categoryId));
  if (toCopy.length) {
    await withTransaction(async (db) => {
      await db.budget.createMany({
        data: toCopy.map((p) => ({ householdId: ctx.householdId, categoryId: p.categoryId, month, limitCents: p.limitCents })),
        skipDuplicates: true,
      });
      await audit(ctx, { action: "CREATE", entityType: "Budget", entityId: null, after: { month, copiedFrom: source, categories: toCopy.map((p) => p.categoryId) }, source: "copy-previous" }, db);
    });
    await publishEvent(ctx.householdId, "budget.changed");
  }
  return { month, sourceMonth: source, copied: toCopy.length, skipped: previous.length - toCopy.length };
}

// -----------------------------------------------------------------------------
// Histórico
// -----------------------------------------------------------------------------

/** Evolução de limite × realizado por categoria nos últimos N meses. */
export async function budgetHistory(ctx: ServiceContext, params: z.input<typeof budgetHistorySchema> = {}) {
  const f = budgetHistorySchema.parse(params);
  const regime = await resolveRegime(ctx, f.regime);
  const endMonth = f.endMonth ?? currentMonth(ctx);
  const startMonth = addMonthsToKey(endMonth, -(f.months - 1));
  const months = monthsBetween(startMonth, endMonth);

  const budgets = await prisma.budget.findMany({
    where: { householdId: ctx.householdId, month: { in: months }, ...(f.categoryId ? { categoryId: f.categoryId } : {}) },
    include: { category: { select: { id: true, name: true, color: true, icon: true, sortOrder: true } } },
  });
  const categories = new Map<string, { id: string; name: string; color: string; icon: string; sortOrder: number }>();
  for (const b of budgets) categories.set(b.categoryId, b.category);
  if (f.categoryId && !categories.has(f.categoryId)) {
    const cat = await prisma.category.findFirst({ where: { id: f.categoryId, householdId: ctx.householdId }, select: { id: true, name: true, color: true, icon: true, sortOrder: true } });
    if (!cat) throw new NotFoundError("Categoria");
    categories.set(cat.id, cat);
  }

  const rows = categories.size
    ? (await recognizedRows(ctx, { start: monthRange(startMonth).start, end: monthRange(endMonth).end }, regime, { categoryIds: [...categories.keys()] })).filter(
        (r) => r.type === "EXPENSE",
      )
    : [];
  const spent = new Map<string, number>(); // `${categoryId}|${month}`
  for (const r of rows) {
    if (!r.categoryId) continue;
    const k = `${r.categoryId}|${monthKey(r.date)}`;
    spent.set(k, (spent.get(k) ?? 0) + r.amountCents);
  }
  const limits = new Map(budgets.map((b) => [`${b.categoryId}|${b.month}`, b.limitCents]));

  const series = [...categories.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((category) => ({
      category: { id: category.id, name: category.name, color: category.color, icon: category.icon },
      points: months.map((month) => {
        const limitCents = limits.get(`${category.id}|${month}`) ?? null;
        const spentCents = spent.get(`${category.id}|${month}`) ?? 0;
        return { month, limitCents, spentCents, percentUsed: limitCents ? percentOf(spentCents, limitCents) : null };
      }),
    }));

  const totals = months.map((month) => {
    let limitCents = 0;
    let spentWithBudget = 0;
    for (const s of series) {
      const p = s.points.find((x) => x.month === month)!;
      if (p.limitCents !== null) {
        limitCents += p.limitCents;
        spentWithBudget += p.spentCents;
      }
    }
    return { month, limitCents, spentCents: spentWithBudget, percentUsed: limitCents ? percentOf(spentWithBudget, limitCents) : null };
  });

  return { regime, months, series, totals };
}

// -----------------------------------------------------------------------------
// Alertas
// -----------------------------------------------------------------------------

/** Mensagem informativa e neutra: "Alimentação atingiu 75% do orçamento de outubro (R$ 1.500,00 de R$ 2.000,00)." */
export function budgetAlertMessage(categoryName: string, threshold: number, month: MonthKey, spentCents: number, limitCents: number): string {
  const monthName = MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
  return `${categoryName} atingiu ${threshold}% do orçamento de ${monthName} (${formatBRL(spentCents)} de ${formatBRL(limitCents)}).`;
}

/** Limiar atingido sem arredondamentos: gasto × 100 ≥ limiar × limite. */
function reached(spentCents: number, limitCents: number, threshold: number): boolean {
  return limitCents > 0 && spentCents * 100 >= threshold * limitCents;
}

/**
 * Verifica os orçamentos do mês corrente (fuso da família, regime padrão) e registra cada limiar
 * atingido uma única vez (BudgetAlert). Quando vários limiares são atingidos de uma vez, apenas o
 * maior gera notificação (os demais ficam registrados), evitando mensagens repetidas.
 * Idempotente.
 */
export async function checkBudgetAlerts(householdId: string): Promise<{ alerts: number; notifications: number }> {
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { timezone: true } });
  if (!household) return { alerts: 0, notifications: 0 };
  const settings = await getSettings(householdId);
  const thresholds = [...new Set(settings.budgetAlertThresholds)].filter((t) => t > 0).sort((a, b) => a - b);
  if (!thresholds.length) return { alerts: 0, notifications: 0 };

  const ctx = systemContext(householdId, household.timezone);
  const month = currentMonth(ctx);
  const overview = await budgetOverview(ctx, month, settings.defaultRegime);
  if (!overview.items.length) return { alerts: 0, notifications: 0 };

  const existing = await prisma.budgetAlert.findMany({ where: { budgetId: { in: overview.items.map((i) => i.budgetId) } } });
  let alerts = 0;
  let notifications = 0;

  for (const item of overview.items) {
    const already = new Set(existing.filter((a) => a.budgetId === item.budgetId).map((a) => a.threshold));
    const newlyReached: number[] = [];
    for (const threshold of thresholds) {
      if (already.has(threshold) || !reached(item.spentCents, item.limitCents, threshold)) continue;
      try {
        await prisma.budgetAlert.create({ data: { budgetId: item.budgetId, threshold } });
        newlyReached.push(threshold);
        alerts++;
      } catch (err) {
        // Outra execução registrou o mesmo limiar: nada a fazer.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      }
    }
    const top = newlyReached[newlyReached.length - 1];
    if (top === undefined) continue;
    const res = await notify({
      householdId,
      type: "BUDGET_THRESHOLD",
      title: `Orçamento de ${item.category.name}`,
      body: budgetAlertMessage(item.category.name, top, month, item.spentCents, item.limitCents),
      dedupeKey: `budget:${item.budgetId}:${top}`,
      data: { budgetId: item.budgetId, categoryId: item.category.id, month, threshold: top, spentCents: item.spentCents, limitCents: item.limitCents },
    });
    if (res.created) notifications++;
  }
  if (alerts) await publishEvent(householdId, "budget.changed");
  return { alerts, notifications };
}
