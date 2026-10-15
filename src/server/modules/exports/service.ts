import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError } from "../../errors";
import { dateToISO, todayISO } from "@/lib/dates";
import { audit } from "../audit/service";
import { buildTransactionWhere } from "../transactions/service";
import { transactionListSchema, type TransactionListFilters } from "../transactions/schemas";
import { serializeTransaction, transactionInclude } from "../transactions/serialize";
import { getVisibilityScope, visibleAccountWhere, visibleCardWhere, visibleTransactionWhere } from "../visibility/scope";
import { renderTransactionsCsv, toExportRow, type ExportTransactionRow } from "../reports/csv";
import { renderTransactionsXlsx } from "../reports/xlsx";

// -----------------------------------------------------------------------------
// Exportação de transações (CSV / XLSX)
// -----------------------------------------------------------------------------

export const EXPORT_MAX_ROWS = 50_000;
const PAGE = 1_000;

/** Filtros da listagem de transações, sem paginação. */
export const exportFiltersSchema = transactionListSchema.omit({ page: true, pageSize: true });
export type ExportFilters = Omit<TransactionListFilters, "page" | "pageSize">;

/**
 * Coleta as transações (mesmos filtros e visibilidade da listagem) em páginas internas,
 * até o limite de 50 mil linhas.
 */
export async function collectTransactionRows(ctx: ServiceContext, filters: ExportFilters, max = EXPORT_MAX_ROWS): Promise<{ rows: ExportTransactionRow[]; truncated: boolean; total: number }> {
  const f = transactionListSchema.parse({ ...filters, page: 1, pageSize: 1 });
  const where = await buildTransactionWhere(ctx, f);
  const orderBy: Prisma.TransactionOrderByWithRelationInput[] =
    f.sort === "date_asc"
      ? [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }]
      : f.sort === "amount_desc"
        ? [{ amountCents: "desc" }, { date: "desc" }, { id: "asc" }]
        : f.sort === "amount_asc"
          ? [{ amountCents: "asc" }, { date: "desc" }, { id: "asc" }]
          : f.sort === "created_desc"
            ? [{ createdAt: "desc" }, { id: "asc" }]
            : [{ date: "desc" }, { createdAt: "desc" }, { id: "asc" }];
  const total = await prisma.transaction.count({ where });
  const rows: ExportTransactionRow[] = [];
  for (let skip = 0; skip < Math.min(total, max); skip += PAGE) {
    const batch = await prisma.transaction.findMany({ where, orderBy, skip, take: Math.min(PAGE, max - skip), include: transactionInclude });
    for (const tx of batch) rows.push(toExportRow(serializeTransaction(tx)));
    if (batch.length < PAGE) break;
  }
  return { rows, truncated: total > max, total };
}

export const exportTransactionsQuerySchema = exportFiltersSchema.extend({ format: z.enum(["csv", "xlsx"]).default("csv") });

export async function exportTransactions(ctx: ServiceContext, filters: ExportFilters, format: "csv" | "xlsx") {
  assertCan(ctx, "data:export");
  assertCan(ctx, "transactions:read");
  const { rows, truncated, total } = await collectTransactionRows(ctx, filters);
  const content = format === "xlsx" ? await renderTransactionsXlsx(rows, { title: "Transações" }) : renderTransactionsCsv(rows);
  await audit(ctx, {
    action: "EXPORT",
    entityType: "Transaction",
    metadata: { format, rows: rows.length, total, truncated, start: filters.start ?? null, end: filters.end ?? null },
  });
  const stamp = todayISO(ctx.timezone);
  return {
    content,
    rowCount: rows.length,
    truncated,
    fileName: `transacoes-${stamp}.${format}`,
    contentType: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
  };
}

// -----------------------------------------------------------------------------
// Portabilidade (LGPD): exportação completa dos dados da família
// -----------------------------------------------------------------------------

/** Chaves que NUNCA podem sair em exportações (rede de segurança adicional aos selects). */
const FORBIDDEN_KEYS = new Set(["passwordhash", "tokenhash", "token", "accesstoken", "sessiontoken", "encryptedapikey", "apikey", "secret", "creds", "transcription"]);

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase()) || v === undefined) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

/** Datas de calendário (@db.Date) como AAAA-MM-DD. */
function day(d: Date | null | undefined): string | null {
  return d ? dateToISO(d) : null;
}

export interface FullExportOptions {
  /** Registra o evento EXPORT na auditoria (padrão: sim). */
  audit?: boolean;
}

/**
 * Exporta todos os dados da família em JSON (portabilidade — LGPD).
 * Nunca inclui: senhas, sessões, tokens de convite, estado de autenticação do WhatsApp,
 * chaves de API de IA e conteúdo de mídias/transcrições.
 */
export async function exportFullHouseholdData(ctx: ServiceContext, opts: FullExportOptions = {}) {
  assertCan(ctx, "data:export");
  const hh = ctx.householdId;
  const household = await prisma.household.findUnique({ where: { id: hh }, include: { settings: true } });
  if (!household) throw new NotFoundError("Família");
  const visibility = await getVisibilityScope(ctx);
  const txWhere: Prisma.TransactionWhereInput = { householdId: hh, ...visibleTransactionWhere(visibility) };

  const [
    members,
    accounts,
    cards,
    categories,
    subcategories,
    merchants,
    rules,
    transactions,
    budgets,
    goals,
    contributions,
    recurring,
    scheduled,
    notifications,
    notificationPrefs,
    auditLogs,
    pendingItems,
    importBatches,
    reportSchedules,
  ] = await Promise.all([
    prisma.householdMember.findMany({
      where: { householdId: hh },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        displayName: true,
        relation: true,
        role: true,
        color: true,
        canViewOthersPrivate: true,
        whatsappPhone: true,
        whatsappConsentAt: true,
        whatsappAuthorized: true,
        isActive: true,
        createdAt: true,
        user: { select: { name: true, email: true, createdAt: true, lastLoginAt: true } },
      },
    }),
    prisma.account.findMany({ where: visibleAccountWhere(ctx), orderBy: { createdAt: "asc" } }),
    prisma.creditCard.findMany({ where: visibleCardWhere(ctx), orderBy: { createdAt: "asc" } }),
    prisma.category.findMany({ where: { householdId: hh }, orderBy: [{ kind: "asc" }, { sortOrder: "asc" }] }),
    prisma.subcategory.findMany({ where: { householdId: hh }, orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }] }),
    prisma.merchant.findMany({ where: { householdId: hh }, orderBy: { name: "asc" } }),
    prisma.financialRule.findMany({ where: { householdId: hh }, orderBy: { priority: "asc" } }),
    prisma.transaction.findMany({
      where: txWhere,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      include: { allocations: { select: { memberId: true, amountCents: true } }, installments: { orderBy: { number: "asc" } } },
    }),
    prisma.budget.findMany({ where: { householdId: hh }, orderBy: [{ month: "asc" }], include: { alerts: true } }),
    prisma.financialGoal.findMany({ where: { householdId: hh }, orderBy: { createdAt: "asc" } }),
    prisma.goalContribution.findMany({ where: { householdId: hh }, orderBy: { date: "asc" } }),
    prisma.recurringTransaction.findMany({ where: { householdId: hh }, orderBy: { createdAt: "asc" } }),
    prisma.scheduledPayment.findMany({ where: { householdId: hh }, orderBy: { dueDate: "asc" } }),
    prisma.notification.findMany({ where: { householdId: hh }, orderBy: { createdAt: "asc" } }),
    prisma.notificationPreference.findMany({ where: { member: { householdId: hh } } }),
    prisma.auditLog.findMany({ where: { householdId: hh }, orderBy: { createdAt: "asc" } }),
    prisma.pendingItem.findMany({ where: { householdId: hh }, orderBy: { createdAt: "asc" } }),
    prisma.importBatch.findMany({ where: { householdId: hh }, orderBy: { createdAt: "asc" }, select: { id: true, format: true, fileName: true, status: true, accountId: true, creditCardId: true, totalRows: true, importedRows: true, createdAt: true, importedAt: true, undoneAt: true } }),
    prisma.reportSchedule.findMany({ where: { householdId: hh } }),
  ]);

  const accountIds = new Set(accounts.map((a) => a.id));
  const cardIds = new Set(cards.map((c) => c.id));
  const statements = await prisma.creditCardStatement.findMany({ where: { householdId: hh, creditCardId: { in: [...cardIds] } }, orderBy: [{ creditCardId: "asc" }, { dueDate: "asc" }] });
  const visibleRecurring = recurring.filter((r) => !(r.accountId && !accountIds.has(r.accountId)) && !(r.creditCardId && !cardIds.has(r.creditCardId)));
  const visibleScheduled = scheduled.filter((s) => !(s.accountId && !accountIds.has(s.accountId)) && !(s.creditCardId && !cardIds.has(s.creditCardId)));

  // Escopo restrito (membro sem acesso a dados privados de outros): remove tudo que aponta para eles.
  const complete = ctx.canViewOthersPrivate || !ctx.memberId;
  const visibleTxIds = new Set(transactions.map((t) => t.id));
  const hiddenIds = new Set<string>([...visibility.hiddenAccountIds, ...visibility.hiddenCardIds]);
  if (!complete) {
    const all = await prisma.transaction.findMany({ where: { householdId: hh }, select: { id: true } });
    for (const t of all) if (!visibleTxIds.has(t.id)) hiddenIds.add(t.id);
  }
  const hiddenAccount = (id: string | null | undefined) => Boolean(id && (visibility.hiddenAccountIds.includes(id) || visibility.hiddenCardIds.includes(id)));
  const visibleGoals = complete ? goals : goals.filter((g) => !hiddenAccount(g.accountId));
  if (!complete) for (const g of goals) if (!visibleGoals.includes(g)) hiddenIds.add(g.id);
  const goalIds = new Set(visibleGoals.map((g) => g.id));
  const visibleContributions = contributions.filter((c) => goalIds.has(c.goalId) && !(c.transactionId && hiddenIds.has(c.transactionId)));
  const visibleBatches = complete ? importBatches : importBatches.filter((b) => !hiddenAccount(b.accountId) && !hiddenAccount(b.creditCardId));
  if (!complete) {
    for (const b of importBatches) if (!visibleBatches.includes(b)) hiddenIds.add(b.id);
    for (const r of recurring) if (!visibleRecurring.includes(r)) hiddenIds.add(r.id);
    for (const sp of scheduled) if (!visibleScheduled.includes(sp)) hiddenIds.add(sp.id);
  }
  const visibleRules = complete ? rules : rules.filter((r) => !hiddenAccount(r.setAccountId));
  const visiblePending = complete ? pendingItems : pendingItems.filter((p) => !(p.transactionId && hiddenIds.has(p.transactionId)) && !(p.relatedTransactionId && hiddenIds.has(p.relatedTransactionId)));
  const visibleNotifications = complete ? notifications : notifications.filter((n) => !n.recipientMemberId || n.recipientMemberId === ctx.memberId);
  const visibleAudit = complete ? auditLogs : auditLogs.filter((a) => !(a.entityId && hiddenIds.has(a.entityId)));

  const data = {
    format: "finance-ai-household-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    scope: ctx.canViewOthersPrivate || !ctx.memberId ? "COMPLETE" : "VISIBLE_TO_REQUESTER",
    notes: [
      "Valores monetários em centavos (inteiros). Datas de calendário no formato AAAA-MM-DD.",
      "Transações excluídas (lixeira) estão incluídas e marcadas com deleted = true.",
      "Não incluídos por segurança: senhas, sessões, tokens de convite, credenciais do WhatsApp, chaves de API e conteúdo de mídias.",
      ...(ctx.canViewOthersPrivate || !ctx.memberId ? [] : ["Contas e cartões privados de outros membros não são incluídos."]),
    ],
    household: { id: household.id, name: household.name, timezone: household.timezone, currency: household.currency, locale: household.locale, createdAt: household.createdAt },
    settings: household.settings ? { ...household.settings, householdId: undefined } : null,
    members: members.map((m) => ({ ...m, user: m.user ? { name: m.user.name, email: m.user.email, createdAt: m.user.createdAt, lastLoginAt: m.user.lastLoginAt } : null })),
    accounts: accounts.map((a) => ({ ...a, initialBalanceDate: day(a.initialBalanceDate) })),
    creditCards: cards,
    statements: statements.map((s) => ({ ...s, closingDate: day(s.closingDate), dueDate: day(s.dueDate) })),
    categories,
    subcategories,
    merchants,
    rules: visibleRules,
    transactions: transactions.map((t) => {
      const { installments, allocations, aiMetadata, ...rest } = t;
      return {
        ...rest,
        date: day(t.date),
        competenceDate: day(t.competenceDate),
        deleted: Boolean(t.deletedAt),
        aiMetadata,
        allocations,
        installments: installments.map((i) => ({ id: i.id, statementId: i.statementId, number: i.number, totalInstallments: i.totalInstallments, amountCents: i.amountCents, dueDate: day(i.dueDate) })),
      };
    }),
    budgets: budgets.map((b) => ({ ...b, alerts: b.alerts.map((a) => ({ threshold: a.threshold, triggeredAt: a.triggeredAt })) })),
    goals: visibleGoals.map((g) => ({ ...g, deadline: day(g.deadline) })),
    goalContributions: visibleContributions.map((c) => ({ ...c, date: day(c.date), deleted: Boolean(c.deletedAt) })),
    recurringTransactions: visibleRecurring.map((r) => ({ ...r, startDate: day(r.startDate), endDate: day(r.endDate) })),
    scheduledPayments: visibleScheduled.map((s) => ({ ...s, dueDate: day(s.dueDate) })),
    notifications: visibleNotifications,
    notificationPreferences: notificationPrefs,
    pendingItems: visiblePending,
    importBatches: visibleBatches,
    reportSchedules,
    auditLogs: visibleAudit,
  };

  const counts = {
    members: members.length,
    accounts: accounts.length,
    creditCards: cards.length,
    transactions: transactions.length,
    auditLogs: visibleAudit.length,
  };
  if (opts.audit !== false) {
    await audit(ctx, { action: "EXPORT", entityType: "Household", entityId: hh, metadata: { kind: "FULL_EXPORT", ...counts } });
  }
  return sanitize({ ...data, counts }) as Record<string, unknown> & { counts: typeof counts };
}

/** Exportação completa como arquivo JSON para download. */
export async function exportFullHouseholdFile(ctx: ServiceContext) {
  const data = await exportFullHouseholdData(ctx);
  return {
    content: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
    fileName: `finance-ai-dados-${todayISO(ctx.timezone)}.json`,
    contentType: "application/json; charset=utf-8",
  };
}
