import { z } from "zod";
import { parsePatch } from "../../validation";
import { assertExclusionRuleCompatible } from "../transactions/report-exclusion";

/** Regra "não importar" só desmarca a linha na importação; não combina com outros efeitos. */
function assertSkipRuleCompatible(rule: { skipOnImport?: boolean | null; setExcludeFromReports?: boolean | null; setScope?: string | null; askNature?: boolean | null; setTransferAccountId?: string | null; setCategoryId?: string | null }) {
  if (rule.skipOnImport && (rule.setExcludeFromReports || rule.setScope || rule.askNature || rule.setTransferAccountId || rule.setCategoryId)) {
    throw new ValidationError("Regra \"não importar\" não define categoria, natureza nem transferência: a linha simplesmente não é importada.", { field: "skipOnImport" });
  }
}
/** Uma regra define uma única natureza: Repasse (desconsiderar), Pessoal/Empresa ou perguntar. */
function assertNatureRuleCompatible(rule: { setExcludeFromReports?: boolean | null; setScope?: string | null; askNature?: boolean | null; setTransferAccountId?: string | null }) {
  const count = [rule.setExcludeFromReports, rule.setScope, rule.askNature].filter(Boolean).length;
  if (count > 1) throw new ValidationError("Escolha uma só natureza na regra: Pessoal/Empresa, Repasse (desconsiderar) ou perguntar.", { field: "setScope" });
  if (count && rule.setTransferAccountId) throw new ValidationError("Regra de transferência não define natureza (transferência não entra nos relatórios).", { field: "setScope" });
}
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
  const data = parsePatch(categoryUpdateSchema, input);
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

// -----------------------------------------------------------------------------
// Criação rápida (seletores de categoria e WhatsApp)
// -----------------------------------------------------------------------------

/** Cores das categorias criadas na hora (a pessoa troca depois em Categorias). */
const QUICK_COLORS = ["#0ea5e9", "#f97316", "#a855f7", "#14b8a6", "#ec4899", "#84cc16", "#eab308", "#6366f1"];

export const quickCategorySchema = z.object({
  name: z.string().trim().min(1, "Informe o nome").max(50),
  kind: z.enum(["EXPENSE", "INCOME"]).default("EXPENSE"),
  /** Categoria-mãe: com ela, cria (ou escolhe) a subcategoria. */
  parentId: z.string().max(40).nullish(),
});

export interface QuickCategoryResult {
  categoryId: string;
  subcategoryId: string | null;
  /** "Pet" ou "Pet › Ração". */
  label: string;
  kind: "EXPENSE" | "INCOME";
  /** false = já existia com esse nome (foi só escolhida; arquivada volta a ficar ativa). */
  created: boolean;
}

/**
 * Cria a categoria (ou a subcategoria dentro de `parentId`) e devolve o que selecionar. Nome que já
 * existe (sem diferenciar maiúsculas) não duplica: devolve a existente, reativando se estava arquivada.
 */
export async function quickCreateCategory(ctx: ServiceContext, input: z.input<typeof quickCategorySchema>): Promise<QuickCategoryResult> {
  assertCan(ctx, "categories:write");
  const data = quickCategorySchema.parse(input);
  const name = data.name.charAt(0).toLocaleUpperCase("pt-BR") + data.name.slice(1);
  if (data.parentId) {
    const parent = await prisma.category.findFirst({ where: { id: data.parentId, householdId: ctx.householdId } });
    if (!parent) throw new NotFoundError("Categoria");
    if (parent.archivedAt) await updateCategory(ctx, parent.id, { archived: false });
    const existing = await prisma.subcategory.findFirst({ where: { categoryId: parent.id, name: { equals: name, mode: "insensitive" } } });
    if (existing) {
      if (existing.archivedAt) await updateSubcategory(ctx, existing.id, { archived: false });
      return { categoryId: parent.id, subcategoryId: existing.id, label: `${parent.name} › ${existing.name}`, kind: parent.kind, created: false };
    }
    const sub = await createSubcategory(ctx, parent.id, { name, keywords: [normalizeText(name)].filter(Boolean) });
    return { categoryId: parent.id, subcategoryId: sub.id, label: `${parent.name} › ${sub.name}`, kind: parent.kind, created: true };
  }
  const existing = await prisma.category.findFirst({ where: { householdId: ctx.householdId, kind: data.kind, name: { equals: name, mode: "insensitive" } } });
  if (existing) {
    if (existing.archivedAt) await updateCategory(ctx, existing.id, { archived: false });
    return { categoryId: existing.id, subcategoryId: null, label: existing.name, kind: existing.kind, created: false };
  }
  const count = await prisma.category.count({ where: { householdId: ctx.householdId, kind: data.kind } });
  const cat = await createCategory(ctx, { name, kind: data.kind, icon: "tag", color: QUICK_COLORS[count % QUICK_COLORS.length]! });
  return { categoryId: cat.id, subcategoryId: null, label: cat.name, kind: cat.kind, created: true };
}

export async function updateSubcategory(ctx: ServiceContext, id: string, input: z.input<typeof subcategoryUpdateSchema>) {
  assertCan(ctx, "categories:write");
  const data = parsePatch(subcategoryUpdateSchema, input);
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
  /** Transforma a movimentação em transferência com esta conta (aplicação/resgate, contas próprias). */
  setTransferAccountId: z.string().nullish(),
  setOwnership: z.enum(["SHARED", "INDIVIDUAL"]).nullish(),
  setResponsibleMemberId: z.string().nullish(),
  /** Desconsiderar nos relatórios (repasse de cliente, reembolso): saldo e fatura não mudam. */
  setExcludeFromReports: z.boolean().default(false),
  setExclusionReason: z.enum(["CLIENT_PASSTHROUGH", "REIMBURSEMENT", "OTHER"]).nullish(),
  setExclusionParty: z
    .string()
    .trim()
    .max(80)
    .transform((v) => v || null)
    .nullish(),
  /** Natureza definida pela regra (Pessoal/Empresa) ou pedir para escolher. */
  setScope: z.enum(["PERSONAL", "BUSINESS"]).nullish(),
  askNature: z.boolean().default(false),
  /** "Não importar": nas próximas importações, a linha que casa vem desmarcada (Confirmar fatura). */
  skipOnImport: z.boolean().default(false),
  /** Condições opcionais: só lançamentos desta conta / deste cartão. */
  matchAccountId: z.string().nullish(),
  matchCreditCardId: z.string().nullish(),
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
  if (data.setTransferAccountId) {
    if (!(await prisma.account.findFirst({ where: { id: data.setTransferAccountId, householdId: ctx.householdId } }))) throw new ValidationError("Conta da transferência inválida.");
    // Regra de transferência não define categoria (transferência não é receita nem despesa).
    data.setCategoryId = null;
    data.setSubcategoryId = null;
  }
  if (data.setResponsibleMemberId && !(await prisma.householdMember.findFirst({ where: { id: data.setResponsibleMemberId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Membro inválido.");
  }
  if (data.matchAccountId && !(await prisma.account.findFirst({ where: { id: data.matchAccountId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Conta da condição inválida.", { field: "matchAccountId" });
  }
  if (data.matchCreditCardId && !(await prisma.creditCard.findFirst({ where: { id: data.matchCreditCardId, householdId: ctx.householdId } }))) {
    throw new ValidationError("Cartão da condição inválido.", { field: "matchCreditCardId" });
  }
  if (data.matchAccountId && data.matchCreditCardId) {
    throw new ValidationError("Escolha uma conta ou um cartão na condição, não os dois.", { field: "matchCreditCardId" });
  }
  assertExclusionRuleCompatible(data);
  assertNatureRuleCompatible(data);
  assertSkipRuleCompatible(data);
  if (data.setExcludeFromReports && !data.setExclusionReason) data.setExclusionReason = "CLIENT_PASSTHROUGH";
  if (data.setExcludeFromReports === false) {
    data.setExclusionReason = null;
    data.setExclusionParty = null;
  }
}

export async function listRules(ctx: ServiceContext) {
  return prisma.financialRule.findMany({
    where: { householdId: ctx.householdId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: {
      category: { select: { name: true, color: true } },
      subcategory: { select: { name: true } },
      account: { select: { name: true } },
      transferAccount: { select: { name: true } },
      matchAccount: { select: { name: true } },
      matchCreditCard: { select: { name: true } },
    },
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
  const data = parsePatch(ruleSchema.partial(), input);
  const current = await prisma.financialRule.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!current) throw new NotFoundError("Regra");
  await validateRuleRefs(ctx, { ...data, matchType: data.matchType ?? current.matchType, pattern: data.pattern ?? current.pattern });
  const merged = {
    setExcludeFromReports: data.setExcludeFromReports ?? current.setExcludeFromReports,
    setTransferAccountId: data.setTransferAccountId === undefined ? current.setTransferAccountId : data.setTransferAccountId,
    setScope: data.setScope === undefined ? current.setScope : data.setScope,
    askNature: data.askNature ?? current.askNature,
    skipOnImport: data.skipOnImport ?? current.skipOnImport,
    setCategoryId: data.setCategoryId === undefined ? current.setCategoryId : data.setCategoryId,
  };
  assertExclusionRuleCompatible(merged);
  assertNatureRuleCompatible(merged);
  assertSkipRuleCompatible(merged);
  if (data.matchAccountId && current.matchCreditCardId && data.matchCreditCardId === undefined) data.matchCreditCardId = null;
  if (data.matchCreditCardId && current.matchAccountId && data.matchAccountId === undefined) data.matchAccountId = null;
  if (data.setTransferAccountId) {
    data.setCategoryId = null;
    data.setSubcategoryId = null;
  }
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
  if (rule.skipOnImport) throw new ValidationError("Regra \"não importar\" vale nas próximas importações; não muda lançamentos já registrados.");
  if (rule.setTransferAccountId) {
    // Regra de transferência: converte receitas/despesas antigas que casam com o padrão.
    const { findMatchingRule } = await import("../rules/matcher");
    const { convertToTransfers } = await import("../transactions/convert-transfer");
    const candidates = await prisma.transaction.findMany({
      where: { householdId: ctx.householdId, deletedAt: null, type: { in: ["EXPENSE", "INCOME"] }, creditCardId: null, accountId: { not: null }, NOT: { accountId: rule.setTransferAccountId } },
      include: { merchant: { select: { name: true } } },
      take: 2000,
    });
    const ids = candidates
      .filter((t) => findMatchingRule([rule], { description: t.description, merchant: t.merchant?.name, amountCents: t.amountCents, type: t.type, accountId: t.accountId, creditCardId: t.creditCardId }))
      .map((t) => t.id);
    if (!ids.length) return { applied: 0 };
    const res = await convertToTransfers(ctx, { transactionIds: ids.slice(0, 500), counterpartAccountId: rule.setTransferAccountId });
    if (res.converted) await prisma.financialRule.update({ where: { id }, data: { timesApplied: { increment: res.converted } } });
    return { applied: res.converted };
  }
  // Contagem acumulada: uma regra pode definir natureza/desconsiderar e também a categoria.
  let natureApplied = 0;
  if (rule.setExcludeFromReports) {
    // Desconsiderar: marca os lançamentos anteriores que casam com a regra (saldo e fatura não mudam).
    const { findMatchingRule } = await import("../rules/matcher");
    const { setReportExclusion } = await import("../transactions/report-exclusion");
    const candidates = await prisma.transaction.findMany({
      where: { householdId: ctx.householdId, deletedAt: null, excludedFromReports: false, type: rule.transactionType ?? { in: ["EXPENSE", "INCOME"] } },
      include: { merchant: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: 5000,
    });
    const ids = candidates
      .filter((t) => findMatchingRule([rule], { description: t.description, merchant: t.merchant?.name, amountCents: t.amountCents, type: t.type, accountId: t.accountId, creditCardId: t.creditCardId }))
      .map((t) => t.id);
    let applied = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const res = await setReportExclusion(
        ctx,
        { transactionIds: ids.slice(i, i + 500), excluded: true, reason: rule.setExclusionReason ?? "CLIENT_PASSTHROUGH", party: rule.setExclusionParty ?? null },
        { reason: `Regra: ${rule.name}` },
      );
      applied += res.updated;
    }
    natureApplied += applied;
    // A mesma regra também classifica? Segue para a categoria abaixo.
    if (!rule.setCategoryId) {
      if (applied) await prisma.financialRule.update({ where: { id }, data: { timesApplied: { increment: applied } } });
      return { applied };
    }
  }
  if (rule.setScope || rule.askNature) {
    // Natureza: Pessoal/Empresa nos anteriores que casam, ou pedido para escolher.
    const { findMatchingRule } = await import("../rules/matcher");
    const { requestNatureReview, setTransactionNature } = await import("../transactions/nature");
    const candidates = await prisma.transaction.findMany({
      where: { householdId: ctx.householdId, deletedAt: null, excludedFromReports: false, type: rule.transactionType ?? { in: ["EXPENSE", "INCOME"] } },
      include: { merchant: { select: { name: true } } },
      orderBy: { date: "desc" },
      take: 5000,
    });
    const ids = candidates
      .filter((t) => (rule.setScope ? t.scope !== rule.setScope : true))
      .filter((t) => findMatchingRule([rule], { description: t.description, merchant: t.merchant?.name, amountCents: t.amountCents, type: t.type, accountId: t.accountId, creditCardId: t.creditCardId }))
      .map((t) => t.id);
    let applied = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      applied += rule.setScope
        ? (await setTransactionNature(ctx, { transactionIds: chunk, nature: rule.setScope }, { reason: `Regra: ${rule.name}` })).updated
        : await requestNatureReview(ctx, chunk, `Regra "${rule.name}"`);
    }
    natureApplied += applied;
    if (!rule.setCategoryId) {
      if (applied) await prisma.financialRule.update({ where: { id }, data: { timesApplied: { increment: applied } } });
      return { applied };
    }
  }
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
    if (!findMatchingRule([rule], { description: t.description, merchant: t.merchant?.name, amountCents: t.amountCents, type: t.type, accountId: t.accountId, creditCardId: t.creditCardId })) continue;
    if (t.categoryId === rule.setCategoryId && t.subcategoryId === rule.setSubcategoryId) continue;
    await updateTransaction(ctx, t.id, { categoryId: rule.setCategoryId, subcategoryId: rule.setSubcategoryId }, { reason: `Regra: ${rule.name}` });
    applied++;
  }
  if (applied) await prisma.financialRule.update({ where: { id }, data: { timesApplied: { increment: applied } } });
  // Regra que desconsidera/define natureza e também classifica: soma os dois efeitos.
  return { applied: applied + natureApplied };
}
