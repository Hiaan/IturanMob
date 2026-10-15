import { z } from "zod";
import { prisma, withTransaction } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { normalizeText } from "@/lib/utils";
import { audit } from "../audit/service";
import { updateTransaction } from "../transactions/service";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(50),
  kind: z.enum(["EXPENSE", "INCOME"]).default("EXPENSE"),
  icon: z.string().max(40).default("tag"),
  color: color.default("#64748b"),
});
export const categoryUpdateSchema = categorySchema.omit({ kind: true }).partial().extend({ archived: z.boolean().optional(), sortOrder: z.number().int().optional() });

export const subcategorySchema = z.object({
  name: z.string().trim().min(1).max(50),
  keywords: z.array(z.string().trim().min(1).max(60)).max(60).default([]),
});
export const subcategoryUpdateSchema = subcategorySchema.partial().extend({ archived: z.boolean().optional() });

export async function listCategories(ctx: ServiceContext, opts: { includeArchived?: boolean; kind?: "EXPENSE" | "INCOME" } = {}) {
  const cats = await prisma.category.findMany({
    where: { householdId: ctx.householdId, ...(opts.includeArchived ? {} : { archivedAt: null }), ...(opts.kind ? { kind: opts.kind } : {}) },
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    include: {
      subcategories: {
        where: opts.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      },
      _count: { select: { transactions: { where: { deletedAt: null } } } },
    },
  });
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    icon: c.icon,
    color: c.color,
    isSystem: c.isSystem,
    sortOrder: c.sortOrder,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    transactionsCount: c._count.transactions,
    subcategories: c.subcategories.map((s) => ({ id: s.id, name: s.name, keywords: s.keywords, archivedAt: s.archivedAt?.toISOString() ?? null })),
  }));
}

export async function createCategory(ctx: ServiceContext, input: z.input<typeof categorySchema>) {
  assertCan(ctx, "categories:write");
  const data = categorySchema.parse(input);
  const exists = await prisma.category.findFirst({ where: { householdId: ctx.householdId, kind: data.kind, name: { equals: data.name, mode: "insensitive" } } });
  if (exists) throw new ConflictError("Já existe uma categoria com este nome.");
  const max = await prisma.category.aggregate({ where: { householdId: ctx.householdId }, _max: { sortOrder: true } });
  const cat = await prisma.category.create({ data: { ...data, householdId: ctx.householdId, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
  await audit(ctx, { action: "CREATE", entityType: "Category", entityId: cat.id, after: cat });
  await publishEvent(ctx.householdId, "category.changed", cat.id);
  return cat;
}

export async function updateCategory(ctx: ServiceContext, id: string, input: z.input<typeof categoryUpdateSchema>) {
  assertCan(ctx, "categories:write");
  const data = categoryUpdateSchema.parse(input);
  const current = await prisma.category.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Categoria");
  if (data.name && data.name.toLowerCase() !== current.name.toLowerCase()) {
    const exists = await prisma.category.findFirst({ where: { householdId: ctx.householdId, kind: current.kind, name: { equals: data.name, mode: "insensitive" }, id: { not: id } } });
    if (exists) throw new ConflictError("Já existe uma categoria com este nome.");
  }
  const { archived, ...rest } = data;
  const updated = await prisma.category.update({
    where: { id },
    data: { ...rest, ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }) },
  });
  await audit(ctx, { action: "UPDATE", entityType: "Category", entityId: id, before: current, after: updated });
  await publishEvent(ctx.householdId, "category.changed", id);
  return updated;
}

/** Exclui se não houver uso; com uso, exige destino para reclassificação ou arquiva. */
export async function deleteCategory(ctx: ServiceContext, id: string, opts: { moveToCategoryId?: string | null } = {}) {
  assertCan(ctx, "categories:write");
  const current = await prisma.category.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Categoria");
  const used = await prisma.transaction.count({ where: { categoryId: id } });
  if (used > 0) {
    if (!opts.moveToCategoryId) {
      throw new ConflictError(`Esta categoria possui ${used} transação(ões). Escolha uma categoria de destino ou arquive-a.`, { transactionsCount: used });
    }
    await reclassifyCategory(ctx, id, opts.moveToCategoryId, null);
  }
  await withTransaction(async (db) => {
    await db.budget.deleteMany({ where: { categoryId: id } });
    await db.category.delete({ where: { id } });
  });
  await audit(ctx, { action: "DELETE", entityType: "Category", entityId: id, before: current });
  await publishEvent(ctx.householdId, "category.changed", id);
}

/** Move todas as transações de uma categoria (ou subcategoria) para outra, com auditoria individual. */
export async function reclassifyCategory(ctx: ServiceContext, fromCategoryId: string, toCategoryId: string, toSubcategoryId: string | null, fromSubcategoryId?: string | null) {
  assertCan(ctx, "transactions:write");
  const [from, to] = await Promise.all([
    prisma.category.findFirst({ where: { id: fromCategoryId, householdId: ctx.householdId } }),
    prisma.category.findFirst({ where: { id: toCategoryId, householdId: ctx.householdId } }),
  ]);
  if (!from || !to) throw new NotFoundError("Categoria");
  if (from.kind !== to.kind) throw new ValidationError("As categorias devem ser do mesmo tipo (despesa ou receita).");
  const txs = await prisma.transaction.findMany({
    where: { householdId: ctx.householdId, categoryId: fromCategoryId, ...(fromSubcategoryId ? { subcategoryId: fromSubcategoryId } : {}), deletedAt: null },
    select: { id: true },
  });
  for (const t of txs) {
    await updateTransaction(ctx, t.id, { categoryId: toCategoryId, subcategoryId: toSubcategoryId }, { reason: "Reclassificação de categoria" });
  }
  return { moved: txs.length };
}

export async function createSubcategory(ctx: ServiceContext, categoryId: string, input: z.input<typeof subcategorySchema>) {
  assertCan(ctx, "categories:write");
  const data = subcategorySchema.parse(input);
  const cat = await prisma.category.findFirst({ where: { id: categoryId, householdId: ctx.householdId } });
  if (!cat) throw new NotFoundError("Categoria");
  const exists = await prisma.subcategory.findFirst({ where: { categoryId, name: { equals: data.name, mode: "insensitive" } } });
  if (exists) throw new ConflictError("Já existe uma subcategoria com este nome.");
  const sub = await prisma.subcategory.create({
    data: { householdId: ctx.householdId, categoryId, name: data.name, keywords: data.keywords.map(normalizeText).filter(Boolean) },
  });
  await audit(ctx, { action: "CREATE", entityType: "Subcategory", entityId: sub.id, after: sub });
  await publishEvent(ctx.householdId, "category.changed", categoryId);
  return sub;
}

export async function updateSubcategory(ctx: ServiceContext, id: string, input: z.input<typeof subcategoryUpdateSchema>) {
  assertCan(ctx, "categories:write");
  const data = subcategoryUpdateSchema.parse(input);
  const current = await prisma.subcategory.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Subcategoria");
  const { archived, keywords, ...rest } = data;
  const updated = await prisma.subcategory.update({
    where: { id },
    data: {
      ...rest,
      ...(keywords ? { keywords: keywords.map(normalizeText).filter(Boolean) } : {}),
      ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
    },
  });
  await audit(ctx, { action: "UPDATE", entityType: "Subcategory", entityId: id, before: current, after: updated });
  await publishEvent(ctx.householdId, "category.changed", current.categoryId);
  return updated;
}

export async function deleteSubcategory(ctx: ServiceContext, id: string) {
  assertCan(ctx, "categories:write");
  const current = await prisma.subcategory.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Subcategoria");
  const used = await prisma.transaction.count({ where: { subcategoryId: id } });
  if (used > 0) throw new ConflictError(`Esta subcategoria possui ${used} transação(ões). Arquive-a ou reclassifique as transações antes.`);
  await prisma.subcategory.delete({ where: { id } });
  await audit(ctx, { action: "DELETE", entityType: "Subcategory", entityId: id, before: current });
  await publishEvent(ctx.householdId, "category.changed", current.categoryId);
}

// -----------------------------------------------------------------------------
// Regras explícitas de categorização
// -----------------------------------------------------------------------------

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  matchField: z.enum(["MERCHANT", "DESCRIPTION", "ANY"]).default("ANY"),
  matchType: z.enum(["CONTAINS", "EQUALS", "STARTS_WITH", "REGEX"]).default("CONTAINS"),
  pattern: z.string().trim().min(1).max(200),
  minAmountCents: z.number().int().min(0).nullish(),
  maxAmountCents: z.number().int().min(0).nullish(),
  transactionType: z.enum(["EXPENSE", "INCOME"]).nullish(),
  setCategoryId: z.string().nullish(),
  setSubcategoryId: z.string().nullish(),
  setPaymentMethod: z.enum(["PIX", "DEBIT_CARD", "CREDIT_CARD", "CASH", "BANK_SLIP", "BANK_TRANSFER", "AUTO_DEBIT", "VOUCHER", "OTHER"]).nullish(),
  setAccountId: z.string().nullish(),
  setOwnership: z.enum(["SHARED", "INDIVIDUAL"]).nullish(),
  setResponsibleMemberId: z.string().nullish(),
  priority: z.number().int().min(0).max(10000).default(100),
  active: z.boolean().default(true),
});

async function validateRuleRefs(ctx: ServiceContext, data: Partial<z.output<typeof ruleSchema>>) {
  if (data.matchType === "REGEX" && data.pattern) {
    try {
      new RegExp(data.pattern);
    } catch {
      throw new ValidationError("Expressão regular inválida.", { field: "pattern" });
    }
  }
  if (data.setSubcategoryId) {
    const sub = await prisma.subcategory.findFirst({ where: { id: data.setSubcategoryId, householdId: ctx.householdId } });
    if (!sub) throw new ValidationError("Subcategoria inválida.");
    data.setCategoryId = sub.categoryId;
  }
  if (data.setCategoryId && !(await prisma.category.findFirst({ where: { id: data.setCategoryId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Categoria inválida.");
  }
  if (data.setAccountId && !(await prisma.account.findFirst({ where: { id: data.setAccountId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Conta inválida.");
  }
  if (data.setResponsibleMemberId && !(await prisma.householdMember.findFirst({ where: { id: data.setResponsibleMemberId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Membro inválido.");
  }
}

export async function listRules(ctx: ServiceContext) {
  return prisma.financialRule.findMany({
    where: { householdId: ctx.householdId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: { category: { select: { name: true, color: true } }, subcategory: { select: { name: true } }, account: { select: { name: true } } },
  });
}

export async function createRule(ctx: ServiceContext, input: z.input<typeof ruleSchema>, source: "USER" | "ASSISTANT" | "WHATSAPP" = "USER") {
  assertCan(ctx, "rules:write");
  const data = ruleSchema.parse(input);
  await validateRuleRefs(ctx, data);
  const rule = await prisma.financialRule.create({ data: { ...data, householdId: ctx.householdId, source, createdById: ctx.memberId } });
  await audit(ctx, { action: "CREATE", entityType: "FinancialRule", entityId: rule.id, after: rule });
  return rule;
}

export async function updateRule(ctx: ServiceContext, id: string, input: Partial<z.input<typeof ruleSchema>>) {
  assertCan(ctx, "rules:write");
  const data = ruleSchema.partial().parse(input);
  const current = await prisma.financialRule.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Regra");
  await validateRuleRefs(ctx, { ...data, matchType: data.matchType ?? current.matchType, pattern: data.pattern ?? current.pattern });
  const updated = await prisma.financialRule.update({ where: { id }, data });
  await audit(ctx, { action: "UPDATE", entityType: "FinancialRule", entityId: id, before: current, after: updated });
  return updated;
}

export async function deleteRule(ctx: ServiceContext, id: string) {
  assertCan(ctx, "rules:write");
  const current = await prisma.financialRule.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Regra");
  await prisma.financialRule.delete({ where: { id } });
  await audit(ctx, { action: "DELETE", entityType: "FinancialRule", entityId: id, before: current });
}

/** Aplica uma regra a transações anteriores sem categoria (ou a todas, se solicitado). */
export async function applyRuleRetroactively(ctx: ServiceContext, id: string, opts: { onlyUncategorized?: boolean } = {}) {
  assertCan(ctx, "transactions:write");
  const rule = await prisma.financialRule.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!rule) throw new NotFoundError("Regra");
  if (!rule.setCategoryId) throw new ValidationError("Esta regra não define categoria.");
  const { findMatchingRule } = await import("../rules/matcher");
  const txs = await prisma.transaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      type: rule.transactionType ?? { in: ["EXPENSE", "INCOME"] },
      ...(opts.onlyUncategorized !== false ? { categoryId: null } : {}),
    },
    include: { merchant: { select: { name: true } }, category: { select: { kind: true } } },
    take: 2000,
  });
  const target = await prisma.category.findUniqueOrThrow({ where: { id: rule.setCategoryId } });
  let applied = 0;
  for (const t of txs) {
    if ((t.type === "INCOME" ? "INCOME" : "EXPENSE") !== target.kind) continue;
    if (!findMatchingRule([rule], { description: t.description, merchant: t.merchant?.name, amountCents: t.amountCents, type: t.type })) continue;
    if (t.categoryId === rule.setCategoryId && t.subcategoryId === rule.setSubcategoryId) continue;
    await updateTransaction(ctx, t.id, { categoryId: rule.setCategoryId, subcategoryId: rule.setSubcategoryId }, { reason: `Regra: ${rule.name}` });
    applied++;
  }
  if (applied) await prisma.financialRule.update({ where: { id }, data: { timesApplied: { increment: applied } } });
  return { applied };
}
