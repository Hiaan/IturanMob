import { z } from "zod";
import { prisma, withTransaction } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan, can } from "../../auth/permissions";
import { ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { addDays, dateToISO, diffDays, isoToDate } from "@/lib/dates";
import { getVisibilityScope, visibleTransactionWhere } from "../visibility/scope";
import { deleteTransaction, updateTransaction } from "./service";

/**
 * "Converter em transferência": receitas/despesas que na verdade são dinheiro da família indo para
 * (ou voltando de) outra conta própria — aplicação e resgate de investimento, "mesma titularidade".
 *
 * - Despesa na conta A → transferência A → B. Receita na conta A → transferência B → A.
 * - O outro lado do mesmo movimento, se já estiver registrado na conta B (ex.: o extrato do CDB
 *   também foi importado), é unido à transferência: excluído de forma restaurável, com auditoria,
 *   para não contar duas vezes. O mesmo vale quando a transferência já existe.
 * - Saldos e relatórios são recalculados pelo ledger; transferência não é receita nem despesa.
 * - `dryRun` mostra o plano sem alterar nada.
 */

export const convertTransferSchema = z.object({
  transactionIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  /** Conta do outro lado (investimento, poupança ou outra conta própria). */
  counterpartAccountId: z.string().min(1).max(64),
  dryRun: z.boolean().default(false),
});
export type ConvertTransferInput = z.input<typeof convertTransferSchema>;

const MIRROR_WINDOW_DAYS = 3;

export interface ConvertPlanItem {
  transactionId: string;
  description: string;
  amountCents: number;
  date: string;
  /** CONVERT: vira transferência; MERGE: já existe a mesma transferência (este é excluído); SKIP: não se aplica. */
  action: "CONVERT" | "MERGE" | "SKIP";
  fromAccountId: string | null;
  toAccountId: string | null;
  /** Outro lado do movimento já registrado na conta de destino/origem (será unido). */
  mirrorTransactionId: string | null;
  mirror: { description: string; date: string; amountCents: number; accountName: string } | null;
  reason: string | null;
}

export async function convertToTransfers(ctx: ServiceContext, raw: ConvertTransferInput) {
  assertCan(ctx, "transactions:write");
  const input = convertTransferSchema.parse(raw);
  const ids = [...new Set(input.transactionIds)];
  const scope = await getVisibilityScope(ctx);
  const counterpart = await prisma.account.findFirst({
    where: { id: input.counterpartAccountId, householdId: ctx.householdId, archivedAt: null },
    select: { id: true, name: true },
  });
  if (!counterpart || scope.hiddenAccountIds.includes(counterpart.id)) throw new ValidationError("Conta inválida.", { field: "counterpartAccountId" });

  const txs = await prisma.transaction.findMany({ where: { id: { in: ids }, householdId: ctx.householdId, ...visibleTransactionWhere(scope) } });
  const byId = new Map(txs.map((t) => [t.id, t]));
  const dates = txs.map((t) => dateToISO(t.date)).sort();
  // Candidatos a "outro lado": movimentos na conta escolhida em torno das datas selecionadas.
  const nearby = dates.length
    ? await prisma.transaction.findMany({
        where: {
          householdId: ctx.householdId,
          deletedAt: null,
          id: { notIn: ids },
          date: { gte: isoToDate(addDays(dates[0]!, -MIRROR_WINDOW_DAYS)), lte: isoToDate(addDays(dates[dates.length - 1]!, MIRROR_WINDOW_DAYS)) },
          OR: [
            { accountId: counterpart.id, type: { in: ["EXPENSE", "INCOME"] }, creditCardId: null },
            { type: "TRANSFER", OR: [{ accountId: counterpart.id }, { destinationAccountId: counterpart.id }] },
          ],
          ...visibleTransactionWhere(scope),
        },
        select: { id: true, type: true, amountCents: true, date: true, accountId: true, destinationAccountId: true, description: true },
      })
    : [];
  const used = new Set<string>();
  const findNearby = (pred: (n: (typeof nearby)[number]) => boolean, date: string) =>
    nearby
      .filter((n) => !used.has(n.id) && pred(n) && Math.abs(diffDays(dateToISO(n.date), date)) <= MIRROR_WINDOW_DAYS)
      .sort((a, b) => Math.abs(diffDays(dateToISO(a.date), date)) - Math.abs(diffDays(dateToISO(b.date), date)))[0];

  const items: ConvertPlanItem[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    const base = { transactionId: id, description: t?.description ?? "", amountCents: t?.amountCents ?? 0, date: t ? dateToISO(t.date) : "", fromAccountId: null, toAccountId: null, mirrorTransactionId: null, mirror: null };
    const skip = (reason: string) => items.push({ ...base, action: "SKIP", reason });
    if (!t) {
      skip("Lançamento não encontrado.");
      continue;
    }
    if (t.deletedAt) skip("Lançamento excluído.");
    else if (t.type === "TRANSFER") skip("Já é uma transferência.");
    else if (t.type !== "EXPENSE" && t.type !== "INCOME") skip("Só receitas e despesas podem virar transferência.");
    else if (t.creditCardId || t.paymentMethod === "CREDIT_CARD") skip("Compra no cartão de crédito não é movimentação entre contas.");
    else if (!t.accountId) skip("Lançamento sem conta: informe a conta antes de converter.");
    else if (t.accountId === counterpart.id) skip("A conta do lançamento é a mesma escolhida para o outro lado.");
    else if (t.installmentCount > 1) skip("Lançamento parcelado não pode virar transferência.");
    if (items[items.length - 1]?.transactionId === id) continue;

    const own = t.accountId!;
    const outflow = t.type === "EXPENSE";
    const from = outflow ? own : counterpart.id;
    const to = outflow ? counterpart.id : own;
    const date = dateToISO(t.date);
    // A mesma transferência já existe (ex.: importada pelo extrato da outra conta).
    const existing = findNearby((n) => n.type === "TRANSFER" && n.amountCents === t.amountCents && n.accountId === from && n.destinationAccountId === to, date);
    if (existing) {
      used.add(existing.id);
      items.push({
        ...base,
        action: "MERGE",
        fromAccountId: from,
        toAccountId: to,
        mirrorTransactionId: existing.id,
        mirror: { description: existing.description, date: dateToISO(existing.date), amountCents: existing.amountCents, accountName: counterpart.name },
        reason: "A mesma transferência já está registrada: este lançamento será excluído (restaurável).",
      });
      continue;
    }
    // O outro lado registrado como receita/despesa na conta escolhida: vira parte da mesma transferência.
    const mirror = findNearby((n) => n.type === (outflow ? "INCOME" : "EXPENSE") && n.accountId === counterpart.id && n.amountCents === t.amountCents, date);
    if (mirror) used.add(mirror.id);
    items.push({
      ...base,
      action: "CONVERT",
      fromAccountId: from,
      toAccountId: to,
      mirrorTransactionId: mirror?.id ?? null,
      mirror: mirror ? { description: mirror.description, date: dateToISO(mirror.date), amountCents: mirror.amountCents, accountName: counterpart.name } : null,
      reason: mirror ? `O outro lado (${outflow ? "entrada" : "saída"} em ${counterpart.name}) já estava registrado e será unido a esta transferência.` : null,
    });
  }

  // Um lançamento selecionado que é o outro lado de outro selecionado entra uma vez só.
  const mirrorsInSelection = new Set(items.filter((i) => i.action === "CONVERT" && i.mirrorTransactionId).map((i) => i.mirrorTransactionId!));
  for (const i of items) {
    if (i.action === "CONVERT" && mirrorsInSelection.has(i.transactionId)) {
      i.action = "SKIP";
      i.reason = "É o outro lado de outra transferência da seleção (unido a ela).";
    }
  }

  const totals = {
    convert: items.filter((i) => i.action === "CONVERT").length,
    merge: items.filter((i) => i.action === "MERGE").length + items.filter((i) => i.action === "CONVERT" && i.mirrorTransactionId).length,
    skip: items.filter((i) => i.action === "SKIP").length,
  };
  if (input.dryRun) return { dryRun: true, counterpart, items, totals, converted: 0, merged: 0 };
  if (totals.merge && !can(ctx.role, "transactions:delete")) throw new ValidationError("Unir os lançamentos repetidos exige permissão para excluir lançamentos.");

  let converted = 0;
  let merged = 0;
  for (const item of items) {
    if (item.action === "SKIP") continue;
    await withTransaction(async (db) => {
      if (item.action === "MERGE") {
        await deleteTransaction(ctx, item.transactionId, { db, reason: `Unido à transferência existente ${item.mirrorTransactionId}` });
        merged++;
        return;
      }
      await updateTransaction(
        ctx,
        item.transactionId,
        { type: "TRANSFER", accountId: item.fromAccountId, destinationAccountId: item.toAccountId, categoryId: null, subcategoryId: null },
        { db, reason: "Convertido em transferência (movimentação entre contas próprias)" },
      );
      converted++;
      if (item.mirrorTransactionId) {
        await deleteTransaction(ctx, item.mirrorTransactionId, { db, reason: `Outro lado da transferência ${item.transactionId} (unido)` });
        merged++;
      }
    });
  }
  await publishEvent(ctx.householdId, "transaction.changed");
  await publishEvent(ctx.householdId, "account.changed");
  await publishEvent(ctx.householdId, "pending.changed");
  return { dryRun: false, counterpart, items, totals, converted, merged };
}
