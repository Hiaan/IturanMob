import { z } from "zod";
import type { ReportExclusionReason, TransactionScope } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { publishEvent } from "../../events";
import { audit } from "../audit/service";
import { resolvePendingWhere } from "../pending/service";
import { getVisibilityScope, visibleTransactionWhere } from "../visibility/scope";
import { idSchema } from "./schemas";
import { serializeTransaction, transactionInclude } from "./serialize";
import { canExcludeType, EXCLUSION_REASONS, exclusionFields, type ExclusionSkip } from "./report-exclusion";

/**
 * Natureza do lançamento: PESSOAL (família), EMPRESA ou REPASSE (de cliente — desconsiderado nos
 * relatórios). Só muda relatórios e análises: saldo das contas, ledger, fatura do cartão, projeção
 * de caixa e contas a pagar nunca mudam por causa dela (nada é repostado).
 *
 * Internamente: `scope` (PERSONAL/BUSINESS) + a marca de desconsiderado (`excludedFromReports`).
 */

export const NATURES = ["PERSONAL", "BUSINESS", "PASSTHROUGH"] as const;
export type Nature = (typeof NATURES)[number];

export const NATURE_LABELS: Record<Nature, string> = { PERSONAL: "Pessoal", BUSINESS: "Empresa", PASSTHROUGH: "Repasse" };

export function natureOf(t: { scope: TransactionScope; excludedFromReports: boolean }): Nature {
  if (t.excludedFromReports) return "PASSTHROUGH";
  return t.scope === "BUSINESS" ? "BUSINESS" : "PERSONAL";
}

export const setNatureSchema = z.object({
  transactionIds: z.array(idSchema).min(1).max(500),
  nature: z.enum(NATURES),
  /** Só para REPASSE: motivo (padrão repasse de cliente), cliente e observação. */
  reason: z.enum(EXCLUSION_REASONS).nullish(),
  party: z
    .string()
    .trim()
    .max(80)
    .transform((v) => v || null)
    .nullish(),
  note: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v || null)
    .nullish(),
});
export type SetNatureInput = z.input<typeof setNatureSchema>;

/** Campos gravados para uma natureza (REPASSE mantém o `scope` atual). */
export function natureFields(
  ctx: Pick<ServiceContext, "memberId">,
  nature: Nature,
  current: { scope: TransactionScope },
  passthrough?: { reason?: ReportExclusionReason | null; party?: string | null; note?: string | null },
) {
  if (nature === "PASSTHROUGH") {
    return { scope: current.scope, natureReview: false, ...exclusionFields(ctx, true, passthrough?.reason ?? "CLIENT_PASSTHROUGH", passthrough?.party ?? null, passthrough?.note ?? null) };
  }
  return { scope: nature as TransactionScope, natureReview: false, ...exclusionFields(ctx, false) };
}

const snapshot = (t: { scope: TransactionScope; natureReview: boolean; excludedFromReports: boolean; exclusionReason: ReportExclusionReason | null; exclusionParty: string | null; exclusionNote: string | null }) => ({
  nature: natureOf(t),
  scope: t.scope,
  natureReview: t.natureReview,
  excludedFromReports: t.excludedFromReports,
  exclusionReason: t.exclusionReason,
  exclusionParty: t.exclusionParty,
  exclusionNote: t.exclusionNote,
});

/** Resolve as pendências "escolher natureza" dos lançamentos. */
export async function resolveNatureReview(db: Db, ctx: ServiceContext, transactionIds: string[], resolution: string) {
  if (!transactionIds.length) return 0;
  return resolvePendingWhere(db, { householdId: ctx.householdId, type: "NATURE_REVIEW", transactionId: { in: transactionIds } }, resolution, ctx.memberId ?? null);
}

/**
 * Define a natureza de um ou vários lançamentos (botão no detalhe, ação em lote, WhatsApp, prévia
 * de importação). Auditado e reversível; resolve a pendência "escolher natureza".
 */
export async function setTransactionNature(ctx: ServiceContext, raw: SetNatureInput, opts: { db?: Db; reason?: string } = {}) {
  assertCan(ctx, "transactions:write");
  const input = setNatureSchema.parse(raw);
  const ids = [...new Set(input.transactionIds)];
  const scope = await getVisibilityScope(ctx);
  const txs = await prisma.transaction.findMany({
    where: { id: { in: ids }, householdId: ctx.householdId, ...visibleTransactionWhere(scope) },
    select: { id: true, type: true, description: true, deletedAt: true, scope: true, natureReview: true, excludedFromReports: true, exclusionReason: true, exclusionParty: true, exclusionNote: true },
  });
  const byId = new Map(txs.map((t) => [t.id, t]));
  const skipped: ExclusionSkip[] = [];
  const toUpdate: typeof txs = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) skipped.push({ id, description: null, reason: "Lançamento não encontrado." });
    else if (t.deletedAt) skipped.push({ id, description: t.description, reason: "Lançamento excluído." });
    else if (!canExcludeType(t.type)) skipped.push({ id, description: t.description, reason: "Só receitas e despesas têm natureza (transferências e pagamentos de fatura não entram nos relatórios)." });
    else {
      const same =
        natureOf(t) === input.nature &&
        !t.natureReview &&
        (input.nature !== "PASSTHROUGH" ||
          ((input.reason == null || t.exclusionReason === input.reason) && (input.party === undefined || t.exclusionParty === input.party) && (input.note === undefined || t.exclusionNote === input.note)));
      if (same) skipped.push({ id, description: t.description, reason: `Já está como ${NATURE_LABELS[input.nature]}.` });
      else toUpdate.push(t);
    }
  }

  const run = async (db: Db) => {
    for (const t of toUpdate) {
      const fields = natureFields(ctx, input.nature, t, {
        reason: input.reason ?? (t.excludedFromReports ? t.exclusionReason : null),
        party: input.party === undefined ? (t.excludedFromReports ? t.exclusionParty : null) : input.party,
        note: input.note === undefined ? (t.excludedFromReports ? t.exclusionNote : null) : input.note,
      });
      await db.transaction.update({ where: { id: t.id }, data: { ...fields, version: { increment: 1 } } });
      await audit(
        ctx,
        {
          action: "UPDATE",
          entityType: "Transaction",
          entityId: t.id,
          before: snapshot(t),
          after: snapshot(fields),
          source: opts.reason ?? `Natureza: ${NATURE_LABELS[input.nature]} (saldo e fatura não mudam)`,
        },
        db,
      );
    }
    await resolveNatureReview(db, ctx, toUpdate.map((t) => t.id), `Natureza definida: ${NATURE_LABELS[input.nature]}`);
  };
  if (toUpdate.length) {
    if (opts.db) await run(opts.db);
    else {
      await withTransaction(run);
      await publishEvent(ctx.householdId, "transaction.changed");
      await publishEvent(ctx.householdId, "pending.changed");
    }
  }
  const items = toUpdate.length
    ? (await (opts.db ?? prisma).transaction.findMany({ where: { id: { in: toUpdate.map((t) => t.id) } }, include: transactionInclude })).map(serializeTransaction)
    : [];
  return { updated: toUpdate.length, skipped, items };
}

/**
 * Pede para escolher a natureza (regra "perguntar"): marca os lançamentos e abre uma pendência para
 * cada um. Só os ainda não decididos (Pessoal, não desconsiderados, sem pedido aberto).
 */
export async function requestNatureReview(ctx: ServiceContext, transactionIds: string[], reason: string): Promise<number> {
  assertCan(ctx, "transactions:write");
  const { createPendingItem } = await import("../pending/service");
  const txs = await prisma.transaction.findMany({
    where: { id: { in: transactionIds }, householdId: ctx.householdId, deletedAt: null, type: { in: ["INCOME", "EXPENSE"] }, scope: "PERSONAL", excludedFromReports: false, natureReview: false },
    select: { id: true, description: true },
  });
  if (!txs.length) return 0;
  await withTransaction(async (db) => {
    for (const t of txs) {
      await db.transaction.update({ where: { id: t.id }, data: { natureReview: true } });
      await createPendingItem(db, {
        householdId: ctx.householdId,
        type: "NATURE_REVIEW",
        title: `Escolher natureza: ${t.description}`,
        description: `${reason}: confirme se é Pessoal, da Empresa ou Repasse de cliente. Saldo e fatura não mudam.`,
        transactionId: t.id,
        dedupeKey: `nature:${t.id}`,
      });
    }
  });
  await publishEvent(ctx.householdId, "transaction.changed");
  await publishEvent(ctx.householdId, "pending.changed");
  return txs.length;
}
