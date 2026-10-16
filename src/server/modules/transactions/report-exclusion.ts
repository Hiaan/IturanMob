import { z } from "zod";
import type { FinancialRule, Prisma, ReportExclusionReason } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { audit } from "../audit/service";
import { dateToISO, isoToDate } from "@/lib/dates";
import { getVisibilityScope, visibleTransactionWhere } from "../visibility/scope";
import { idSchema, isoDateSchema } from "./schemas";
import { serializeTransaction, transactionInclude } from "./serialize";

/**
 * "Desconsiderar nos relatórios": receitas/despesas que não são da família — repasse de cliente
 * (anúncios pagos no cartão e reembolsados por Pix), reembolso, etc.
 *
 * Sai de: receitas/despesas, categorias, pessoas, orçamentos, relatórios, comparativos e respostas do
 * assistente (todos leem `recognizedRows`, que ignora os desconsiderados).
 * NÃO muda: saldo das contas e ledger, fatura do cartão (parcelas e pagamento), projeção de caixa e
 * contas a pagar — só a marca é gravada; nada é repostado.
 */

export const EXCLUSION_REASONS = ["CLIENT_PASSTHROUGH", "REIMBURSEMENT", "OTHER"] as const;

export const EXCLUSION_REASON_LABELS: Record<ReportExclusionReason, string> = {
  CLIENT_PASSTHROUGH: "Repasse de cliente",
  REIMBURSEMENT: "Reembolso",
  OTHER: "Outro",
};

const partySchema = z
  .string()
  .trim()
  .max(80)
  .transform((v) => v || null)
  .nullish();

export const reportExclusionSchema = z.object({
  transactionIds: z.array(idSchema).min(1).max(500),
  excluded: z.boolean(),
  reason: z.enum(EXCLUSION_REASONS).nullish(),
  /** Cliente/pessoa do repasse (agrupa o saldo do repasse). */
  party: partySchema,
  note: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v || null)
    .nullish(),
});
export type ReportExclusionInput = z.input<typeof reportExclusionSchema>;

/** Só receitas e despesas entram nos relatórios; transferência e pagamento de fatura já ficam de fora. */
export function canExcludeType(type: string): boolean {
  return type === "EXPENSE" || type === "INCOME";
}

export interface ExclusionFields {
  excludedFromReports: boolean;
  exclusionReason: ReportExclusionReason | null;
  exclusionParty: string | null;
  exclusionNote: string | null;
  excludedAt: Date | null;
  excludedByMemberId: string | null;
}

export function exclusionFields(ctx: Pick<ServiceContext, "memberId">, excluded: boolean, reason?: ReportExclusionReason | null, party?: string | null, note?: string | null): ExclusionFields {
  return excluded
    ? { excludedFromReports: true, exclusionReason: reason ?? "OTHER", exclusionParty: party ?? null, exclusionNote: note ?? null, excludedAt: new Date(), excludedByMemberId: ctx.memberId ?? null }
    : { excludedFromReports: false, exclusionReason: null, exclusionParty: null, exclusionNote: null, excludedAt: null, excludedByMemberId: null };
}

/** Campos de exclusão que uma regra aplica a um lançamento novo (ou null se a regra não desconsidera). */
export function exclusionFromRule(ctx: Pick<ServiceContext, "memberId">, rule: Pick<FinancialRule, "setExcludeFromReports" | "setExclusionReason" | "setExclusionParty">): ExclusionFields | null {
  if (!rule.setExcludeFromReports) return null;
  return exclusionFields(ctx, true, rule.setExclusionReason ?? "CLIENT_PASSTHROUGH", rule.setExclusionParty ?? null, null);
}

const snapshot = (t: { excludedFromReports: boolean; exclusionReason: ReportExclusionReason | null; exclusionParty: string | null; exclusionNote: string | null }) => ({
  excludedFromReports: t.excludedFromReports,
  exclusionReason: t.exclusionReason,
  exclusionParty: t.exclusionParty,
  exclusionNote: t.exclusionNote,
});

export interface ExclusionSkip {
  id: string;
  description: string | null;
  reason: string;
}

/**
 * Marca (ou desmarca) lançamentos como desconsiderados nos relatórios. Auditado; desfazer é chamar
 * de novo com `excluded: false`. Não reposta o ledger nem as parcelas.
 */
export async function setReportExclusion(ctx: ServiceContext, raw: ReportExclusionInput, opts: { db?: Db; reason?: string } = {}) {
  assertCan(ctx, "transactions:write");
  const input = reportExclusionSchema.parse(raw);
  if (!input.excluded && (input.reason || input.party || input.note)) {
    // Voltar a considerar limpa motivo, cliente e observação.
    input.reason = null;
    input.party = null;
    input.note = null;
  }
  const ids = [...new Set(input.transactionIds)];
  const scope = await getVisibilityScope(ctx);
  const txs = await prisma.transaction.findMany({
    where: { id: { in: ids }, householdId: ctx.householdId, ...visibleTransactionWhere(scope) },
    select: { id: true, type: true, description: true, deletedAt: true, excludedFromReports: true, exclusionReason: true, exclusionParty: true, exclusionNote: true },
  });
  const byId = new Map(txs.map((t) => [t.id, t]));
  const skipped: ExclusionSkip[] = [];
  const toUpdate: typeof txs = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) skipped.push({ id, description: null, reason: "Lançamento não encontrado." });
    else if (t.deletedAt) skipped.push({ id, description: t.description, reason: "Lançamento excluído." });
    else if (!canExcludeType(t.type)) skipped.push({ id, description: t.description, reason: "Transferências e pagamentos de fatura já não contam como receita nem despesa." });
    else if (!input.excluded && !t.excludedFromReports) skipped.push({ id, description: t.description, reason: "Já é considerado nos relatórios." });
    else if (
      input.excluded &&
      t.excludedFromReports &&
      t.exclusionReason === (input.reason ?? t.exclusionReason) &&
      (input.party === undefined || t.exclusionParty === input.party) &&
      (input.note === undefined || t.exclusionNote === input.note)
    )
      skipped.push({ id, description: t.description, reason: "Já estava desconsiderado." });
    else toUpdate.push(t);
  }

  const run = async (db: Db) => {
    for (const t of toUpdate) {
      // Ao editar só o cliente/observação de um já desconsiderado, mantém o que não foi informado.
      const fields = input.excluded
        ? exclusionFields(
            ctx,
            true,
            input.reason ?? t.exclusionReason ?? "OTHER",
            input.party === undefined ? t.exclusionParty : input.party,
            input.note === undefined ? t.exclusionNote : input.note,
          )
        : exclusionFields(ctx, false);
      await db.transaction.update({ where: { id: t.id }, data: { ...fields, version: { increment: 1 } } });
      await audit(
        ctx,
        {
          action: "UPDATE",
          entityType: "Transaction",
          entityId: t.id,
          before: snapshot(t),
          after: snapshot(fields),
          source: opts.reason ?? (input.excluded ? "Desconsiderado nos relatórios (saldo e fatura não mudam)" : "Voltou a ser considerado nos relatórios"),
        },
        db,
      );
    }
  };
  if (toUpdate.length) {
    if (opts.db) await run(opts.db);
    else await withTransaction(run);
    if (!opts.db) {
      await publishEvent(ctx.householdId, "transaction.changed");
    }
  }
  const items = toUpdate.length
    ? (await (opts.db ?? prisma).transaction.findMany({ where: { id: { in: toUpdate.map((t) => t.id) } }, include: transactionInclude })).map(serializeTransaction)
    : [];
  return { updated: toUpdate.length, skipped, items };
}

// -----------------------------------------------------------------------------
// Saldo dos repasses por cliente
// -----------------------------------------------------------------------------

export const passthroughQuerySchema = z.object({
  start: isoDateSchema.optional(),
  end: isoDateSchema.optional(),
});

/**
 * Repasses de cliente desconsiderados, agrupados pelo cliente: quanto entrou (Pix do cliente), quanto
 * saiu (gastos no cartão/conta em nome dele) e a diferença. Saldo positivo: recebido a mais (ainda a
 * gastar ou devolver); negativo: gasto a mais (ainda a receber do cliente).
 */
export async function passthroughSummary(ctx: ServiceContext, raw: z.input<typeof passthroughQuerySchema> = {}) {
  assertCan(ctx, "transactions:read");
  const q = passthroughQuerySchema.parse(raw);
  const scope = await getVisibilityScope(ctx);
  const where: Prisma.TransactionWhereInput = {
    householdId: ctx.householdId,
    deletedAt: null,
    status: "CONFIRMED",
    excludedFromReports: true,
    exclusionReason: "CLIENT_PASSTHROUGH",
    type: { in: ["EXPENSE", "INCOME"] },
    ...(q.start || q.end ? { date: { ...(q.start ? { gte: isoToDate(q.start) } : {}), ...(q.end ? { lte: isoToDate(q.end) } : {}) } } : {}),
    ...visibleTransactionWhere(scope),
  };
  const rows = await prisma.transaction.findMany({
    where,
    select: { type: true, amountCents: true, currency: true, amountBrlCents: true, exclusionParty: true, date: true },
    take: 20_000,
  });
  const groups = new Map<string, { party: string | null; receivedCents: number; spentCents: number; count: number; firstDate: string; lastDate: string; missingFx: number }>();
  for (const r of rows) {
    const label = r.exclusionParty?.trim() || null;
    const key = label ? label.toLocaleLowerCase("pt-BR") : "";
    const date = dateToISO(r.date);
    const g = groups.get(key) ?? { party: label, receivedCents: 0, spentCents: 0, count: 0, firstDate: date, lastDate: date, missingFx: 0 };
    const brl = r.currency === "BRL" ? r.amountCents : r.amountBrlCents;
    if (brl === null) g.missingFx++;
    else if (r.type === "INCOME") g.receivedCents += brl;
    else g.spentCents += brl;
    g.count++;
    if (date < g.firstDate) g.firstDate = date;
    if (date > g.lastDate) g.lastDate = date;
    groups.set(key, g);
  }
  const parties = [...groups.values()]
    .map((g) => ({ ...g, balanceCents: g.receivedCents - g.spentCents }))
    .sort((a, b) => (a.party === null ? 1 : b.party === null ? -1 : a.party.localeCompare(b.party, "pt-BR")));
  const totals = parties.reduce(
    (t, p) => ({ receivedCents: t.receivedCents + p.receivedCents, spentCents: t.spentCents + p.spentCents, balanceCents: t.balanceCents + p.balanceCents, count: t.count + p.count }),
    { receivedCents: 0, spentCents: 0, balanceCents: 0, count: 0 },
  );
  return { period: { start: q.start ?? null, end: q.end ?? null }, parties, totals };
}

/** Nomes de cliente já usados (sugestões no formulário). */
export async function listExclusionParties(ctx: ServiceContext): Promise<string[]> {
  assertCan(ctx, "transactions:read");
  const rows = await prisma.transaction.groupBy({
    by: ["exclusionParty"],
    where: { householdId: ctx.householdId, excludedFromReports: true, exclusionParty: { not: null }, deletedAt: null },
    _count: { _all: true },
    orderBy: { _count: { exclusionParty: "desc" } },
    take: 50,
  });
  return rows.map((r) => r.exclusionParty!).filter(Boolean);
}

export function assertExclusionRuleCompatible(rule: { setExcludeFromReports?: boolean | null; setTransferAccountId?: string | null }) {
  if (rule.setExcludeFromReports && rule.setTransferAccountId) {
    throw new ValidationError("Uma regra não pode transformar em transferência e desconsiderar ao mesmo tempo.", { field: "setExcludeFromReports" });
  }
}
