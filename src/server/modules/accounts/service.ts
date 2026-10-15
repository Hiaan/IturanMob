import { z } from "zod";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { dateToISO, daysBetween, isoToDate, todayISO, type ISODate } from "@/lib/dates";
import { audit } from "../audit/service";
import { visibleAccountWhere } from "../visibility/scope";
import { createTransaction } from "../transactions/service";
import { isoDateSchema } from "../transactions/schemas";

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(60),
  institution: z.string().trim().max(60).nullish(),
  type: z.enum(["CHECKING", "SAVINGS", "WALLET", "INVESTMENT", "DIGITAL", "OTHER"]).default("CHECKING"),
  visibility: z.enum(["SHARED", "PRIVATE"]).default("SHARED"),
  ownerMemberId: z.string().nullish(),
  initialBalanceCents: z.number().int().min(-1_000_000_000).max(10_000_000_000).default(0),
  initialBalanceDate: isoDateSchema.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0f766e"),
  icon: z.string().max(40).default("landmark"),
  includeInTotals: z.boolean().default(true),
});

export const accountUpdateSchema = accountSchema.partial().extend({ archived: z.boolean().optional() });

export interface AccountDTO {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  visibility: string;
  ownerMemberId: string | null;
  ownerName: string | null;
  initialBalanceCents: number;
  initialBalanceDate: string;
  balanceCents: number;
  color: string;
  icon: string;
  includeInTotals: boolean;
  archivedAt: string | null;
  transactionsCount: number;
}

/** Saldo = saldo inicial + soma dos movimentos do ledger (fonte única da verdade). */
export async function listAccounts(ctx: ServiceContext, opts: { includeArchived?: boolean; asOf?: ISODate } = {}): Promise<AccountDTO[]> {
  const accounts = await prisma.account.findMany({
    where: { ...visibleAccountWhere(ctx), ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: "asc" }, { createdAt: "asc" }],
    include: { owner: { select: { displayName: true } } },
  });
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a.id);
  const [sums, counts] = await Promise.all([
    prisma.ledgerEntry.groupBy({
      by: ["accountId"],
      where: { accountId: { in: ids }, ...(opts.asOf ? { date: { lte: isoToDate(opts.asOf) } } : {}) },
      _sum: { amountCents: true },
    }),
    prisma.ledgerEntry.groupBy({ by: ["accountId"], where: { accountId: { in: ids } }, _count: { _all: true } }),
  ]);
  const sumMap = new Map(sums.map((s) => [s.accountId, s._sum.amountCents ?? 0]));
  const countMap = new Map(counts.map((c) => [c.accountId, c._count._all]));
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    institution: a.institution,
    type: a.type,
    visibility: a.visibility,
    ownerMemberId: a.ownerMemberId,
    ownerName: a.owner?.displayName ?? null,
    initialBalanceCents: a.initialBalanceCents,
    initialBalanceDate: dateToISO(a.initialBalanceDate),
    balanceCents: a.initialBalanceCents + (sumMap.get(a.id) ?? 0),
    color: a.color,
    icon: a.icon,
    includeInTotals: a.includeInTotals,
    archivedAt: a.archivedAt?.toISOString() ?? null,
    transactionsCount: countMap.get(a.id) ?? 0,
  }));
}

export async function getAccount(ctx: ServiceContext, id: string) {
  const all = await listAccounts(ctx, { includeArchived: true });
  const account = all.find((a) => a.id === id);
  if (!account) throw new NotFoundError("Conta");
  return account;
}

async function validateOwner(ctx: ServiceContext, ownerMemberId: string | null | undefined) {
  if (!ownerMemberId) return;
  const m = await prisma.householdMember.findFirst({ where: { id: ownerMemberId, householdId: ctx.householdId } });
  if (!m) throw new ValidationError("Titular inválido.", { field: "ownerMemberId" });
}

export async function createAccount(ctx: ServiceContext, input: z.input<typeof accountSchema>) {
  assertCan(ctx, "accounts:write");
  const data = accountSchema.parse(input);
  await validateOwner(ctx, data.ownerMemberId);
  if (data.visibility === "PRIVATE" && !data.ownerMemberId) data.ownerMemberId = ctx.memberId;
  const exists = await prisma.account.findFirst({ where: { householdId: ctx.householdId, name: data.name } });
  if (exists) throw new ConflictError("Já existe uma conta com este nome.");
  const account = await prisma.account.create({
    data: {
      ...data,
      householdId: ctx.householdId,
      initialBalanceDate: isoToDate(data.initialBalanceDate ?? todayISO(ctx.timezone)),
    },
  });
  await audit(ctx, { action: "CREATE", entityType: "Account", entityId: account.id, after: account });
  await publishEvent(ctx.householdId, "account.changed", account.id);
  return getAccount(ctx, account.id);
}

export async function updateAccount(ctx: ServiceContext, id: string, input: z.input<typeof accountUpdateSchema>) {
  assertCan(ctx, "accounts:write");
  const data = accountUpdateSchema.parse(input);
  const current = await prisma.account.findFirst({ where: { id, ...visibleAccountWhere(ctx) } });
  if (!current) throw new NotFoundError("Conta");
  await validateOwner(ctx, data.ownerMemberId);
  if (data.name && data.name !== current.name) {
    const exists = await prisma.account.findFirst({ where: { householdId: ctx.householdId, name: data.name, id: { not: id } } });
    if (exists) throw new ConflictError("Já existe uma conta com este nome.");
  }
  const { archived, initialBalanceDate, ...rest } = data;
  const updated = await prisma.account.update({
    where: { id },
    data: {
      ...rest,
      ...(initialBalanceDate ? { initialBalanceDate: isoToDate(initialBalanceDate) } : {}),
      ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
    },
  });
  await audit(ctx, { action: "UPDATE", entityType: "Account", entityId: id, before: current, after: updated });
  await publishEvent(ctx.householdId, "account.changed", id);
  return getAccount(ctx, id);
}

/** Exclui a conta somente se não houver movimentações; caso contrário, sugere arquivar. */
export async function deleteAccount(ctx: ServiceContext, id: string) {
  assertCan(ctx, "accounts:write");
  const current = await prisma.account.findFirst({ where: { id, ...visibleAccountWhere(ctx) } });
  if (!current) throw new NotFoundError("Conta");
  const used = await prisma.transaction.count({ where: { OR: [{ accountId: id }, { destinationAccountId: id }] } });
  if (used > 0) throw new ConflictError("Esta conta possui movimentações. Arquive-a em vez de excluir.");
  await prisma.$transaction([
    prisma.creditCard.updateMany({ where: { paymentAccountId: id }, data: { paymentAccountId: null } }),
    prisma.account.delete({ where: { id } }),
  ]);
  await audit(ctx, { action: "DELETE", entityType: "Account", entityId: id, before: current });
  await publishEvent(ctx.householdId, "account.changed", id);
}

/** Ajuste de saldo: cria uma transação ADJUSTMENT com a diferença (não é receita nem despesa). */
export async function adjustBalance(ctx: ServiceContext, id: string, input: { targetBalanceCents: number; date?: string; note?: string }) {
  assertCan(ctx, "accounts:write");
  const account = await getAccount(ctx, id);
  const diff = input.targetBalanceCents - account.balanceCents;
  if (diff === 0) return { adjusted: false, account };
  await createTransaction(
    ctx,
    {
      type: "ADJUSTMENT",
      amountCents: Math.abs(diff),
      description: input.note?.trim() || "Ajuste de saldo",
      date: input.date ?? todayISO(ctx.timezone),
      ...(diff > 0 ? { destinationAccountId: id } : { accountId: id }),
    },
    { source: "MANUAL", checkDuplicates: false },
  );
  return { adjusted: true, account: await getAccount(ctx, id) };
}

/** Série diária de saldo (para gráfico de evolução). */
export async function balanceHistory(ctx: ServiceContext, params: { start: ISODate; end: ISODate; accountIds?: string[] }) {
  const accounts = (await listAccounts(ctx)).filter((a) => a.includeInTotals && (!params.accountIds?.length || params.accountIds.includes(a.id)));
  if (!accounts.length) return { points: [] as Array<{ date: string; balanceCents: number }> };
  const ids = accounts.map((a) => a.id);
  const initial = accounts.reduce((s, a) => s + a.initialBalanceCents, 0);
  const before = await prisma.ledgerEntry.aggregate({
    where: { accountId: { in: ids }, date: { lt: isoToDate(params.start) } },
    _sum: { amountCents: true },
  });
  const daily = await prisma.ledgerEntry.groupBy({
    by: ["date"],
    where: { accountId: { in: ids }, date: { gte: isoToDate(params.start), lte: isoToDate(params.end) } },
    _sum: { amountCents: true },
  });
  const map = new Map(daily.map((d) => [dateToISO(d.date), d._sum.amountCents ?? 0]));
  let running = initial + (before._sum.amountCents ?? 0);
  const points = daysBetween(params.start, params.end).map((date) => {
    running += map.get(date) ?? 0;
    return { date, balanceCents: running };
  });
  return { points };
}

/** Verificação de integridade: transferências somam zero e cada transação tem os lançamentos esperados. */
export async function verifyLedgerIntegrity(householdId: string) {
  const issues: string[] = [];
  const transfers = await prisma.ledgerEntry.groupBy({
    by: ["transactionId"],
    where: { householdId, kind: { in: ["TRANSFER_IN", "TRANSFER_OUT"] } },
    _sum: { amountCents: true },
  });
  for (const t of transfers) if ((t._sum.amountCents ?? 0) !== 0) issues.push(`Transferência ${t.transactionId} não soma zero.`);
  const orphan = await prisma.ledgerEntry.count({
    where: { householdId, transaction: { OR: [{ deletedAt: { not: null } }, { status: "PENDING" }] } },
  });
  if (orphan) issues.push(`${orphan} movimento(s) de transações excluídas/pendentes.`);
  const cardWithEntries = await prisma.ledgerEntry.count({ where: { householdId, kind: "EXPENSE", transaction: { creditCardId: { not: null } } } });
  if (cardWithEntries) issues.push(`${cardWithEntries} compra(s) no crédito com movimento de caixa indevido.`);
  const badInstallments = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT t.id FROM "Transaction" t
    JOIN "Installment" i ON i."transactionId" = t.id
    WHERE t."householdId" = ${householdId}
    GROUP BY t.id, t."amountCents"
    HAVING SUM(i."amountCents") <> t."amountCents"`;
  for (const b of badInstallments) issues.push(`Parcelas da transação ${b.id} não somam o valor total.`);
  return { ok: issues.length === 0, issues, checkedAt: new Date().toISOString() };
}


