import { z } from "zod";
import { parsePatch } from "../../validation";
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
  /** Moeda da conta (BRL, USD, EUR, GBP). Não muda depois que a conta tem movimentos. */
  currency: z.enum(["BRL", "USD", "EUR", "GBP"]).default("BRL"),
  /** Rendimento automático (investimento/poupança): indexador, taxa (centésimos) e início. */
  yieldIndex: z.enum(["CDI", "SELIC", "IPCA", "PREFIXED"]).nullish(),
  yieldRateBps: z.number().int().min(1).max(100_000).nullish(),
  yieldStartDate: isoDateSchema.nullish(),
});

export const accountUpdateSchema = accountSchema.partial().extend({ archived: z.boolean().optional() });

/** Rendimento automático só em conta de investimento/poupança e com taxa e início informados. */
function validateYield(type: string, data: { yieldIndex?: string | null; yieldRateBps?: number | null; yieldStartDate?: string | null; currency?: string }) {
  if (!data.yieldIndex) return;
  if (data.currency && data.currency !== "BRL") throw new ValidationError("Rendimento automático (CDI, Selic, IPCA) é só para contas em reais.", { field: "yieldIndex" });
  if (type !== "INVESTMENT" && type !== "SAVINGS") throw new ValidationError("Rendimento automático é só para contas de investimento ou poupança.", { field: "yieldIndex" });
  if (!data.yieldRateBps) throw new ValidationError(data.yieldIndex === "CDI" || data.yieldIndex === "SELIC" ? "Informe o percentual do indexador (ex.: 100% do CDI)." : "Informe a taxa anual.", { field: "yieldRateBps" });
  if (!data.yieldStartDate) throw new ValidationError("Informe a data de início do rendimento.", { field: "yieldStartDate" });
}

async function accrueAfterChange(accountId: string) {
  try {
    const { runYieldAccrual } = await import("../investments/service");
    await runYieldAccrual({ accountId });
  } catch {
    // A tarefa periódica do worker refaz a apuração.
  }
}

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
  yieldIndex: string | null;
  yieldRateBps: number | null;
  yieldStartDate: string | null;
  /** Moeda da conta; saldo e lançamentos ficam nela. */
  currency: string;
  /** Saldo em reais (contas em moeda estrangeira: pela última PTAX; sem cotação: null). */
  balanceBrlCents: number | null;
  /** Cotação usada (contas em moeda estrangeira). */
  fx: { rate: number; date: string } | null;
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
  // Contas em moeda estrangeira: saldo em reais pela PTAX (da data pedida ou a mais recente).
  const { isForeign, latestRates, rateOn } = await import("../fx/service");
  const foreign = [...new Set(accounts.map((a) => a.currency).filter(isForeign))];
  const rates = new Map<string, { rate: number; date: string }>();
  if (foreign.length) {
    if (opts.asOf) for (const c of foreign) {
      const r = await rateOn(c, opts.asOf);
      if (r) rates.set(c, r);
    }
    else for (const [c, r] of await latestRates(foreign)) rates.set(c, r);
  }
  return accounts.map((a) => {
    const balanceCents = a.initialBalanceCents + (sumMap.get(a.id) ?? 0);
    const fx = isForeign(a.currency) ? rates.get(a.currency) ?? null : null;
    return {
    id: a.id,
    name: a.name,
    institution: a.institution,
    type: a.type,
    visibility: a.visibility,
    ownerMemberId: a.ownerMemberId,
    ownerName: a.owner?.displayName ?? null,
    initialBalanceCents: a.initialBalanceCents,
    initialBalanceDate: dateToISO(a.initialBalanceDate),
    balanceCents,
    color: a.color,
    icon: a.icon,
    includeInTotals: a.includeInTotals,
    archivedAt: a.archivedAt?.toISOString() ?? null,
    transactionsCount: countMap.get(a.id) ?? 0,
    yieldIndex: a.yieldIndex,
    yieldRateBps: a.yieldRateBps,
    yieldStartDate: a.yieldStartDate ? dateToISO(a.yieldStartDate) : null,
    currency: a.currency,
    balanceBrlCents: !isForeign(a.currency) ? balanceCents : fx ? Math.round(balanceCents * fx.rate) : null,
    fx,
  };
  });
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
  validateYield(data.type, data);
  if (data.visibility === "PRIVATE" && !data.ownerMemberId) data.ownerMemberId = ctx.memberId;
  const exists = await prisma.account.findFirst({ where: { householdId: ctx.householdId, name: data.name } });
  if (exists) throw new ConflictError("Já existe uma conta com este nome.");
  const { yieldStartDate, ...rest } = data;
  const account = await prisma.account.create({
    data: {
      ...rest,
      householdId: ctx.householdId,
      initialBalanceDate: isoToDate(data.initialBalanceDate ?? todayISO(ctx.timezone)),
      yieldStartDate: data.yieldIndex && yieldStartDate ? isoToDate(yieldStartDate) : null,
      ...(data.yieldIndex ? {} : { yieldIndex: null, yieldRateBps: null }),
    },
  });
  await audit(ctx, { action: "CREATE", entityType: "Account", entityId: account.id, after: account });
  await publishEvent(ctx.householdId, "account.changed", account.id);
  if (account.yieldIndex) await accrueAfterChange(account.id);
  if (account.currency !== "BRL") void import("../fx/service").then((m) => m.refreshFxRates()).catch(() => undefined);
  return getAccount(ctx, account.id);
}

export async function updateAccount(ctx: ServiceContext, id: string, input: z.input<typeof accountUpdateSchema>) {
  assertCan(ctx, "accounts:write");
  const data = parsePatch(accountUpdateSchema, input);
  const current = await prisma.account.findFirst({ where: { id, ...visibleAccountWhere(ctx) } });
  if (!current) throw new NotFoundError("Conta");
  await validateOwner(ctx, data.ownerMemberId);
  if (data.name && data.name !== current.name) {
    const exists = await prisma.account.findFirst({ where: { householdId: ctx.householdId, name: data.name, id: { not: id } } });
    if (exists) throw new ConflictError("Já existe uma conta com este nome.");
  }
  const { archived, initialBalanceDate, yieldStartDate, ...rest } = data;
  const yieldIndex = data.yieldIndex !== undefined ? data.yieldIndex : current.yieldIndex;
  if (data.currency && data.currency !== current.currency) {
    const used = await prisma.transaction.count({ where: { OR: [{ accountId: id }, { destinationAccountId: id }] } });
    if (used) throw new ValidationError("A moeda não pode mudar depois que a conta tem lançamentos. Crie outra conta na nova moeda.", { field: "currency" });
  }
  validateYield(data.type ?? current.type, {
    currency: data.currency ?? current.currency,
    yieldIndex,
    yieldRateBps: data.yieldRateBps !== undefined ? data.yieldRateBps : current.yieldRateBps,
    yieldStartDate: yieldStartDate !== undefined ? yieldStartDate : current.yieldStartDate ? dateToISO(current.yieldStartDate) : null,
  });
  const updated = await prisma.account.update({
    where: { id },
    data: {
      ...rest,
      ...(initialBalanceDate ? { initialBalanceDate: isoToDate(initialBalanceDate) } : {}),
      ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
      ...(yieldStartDate !== undefined ? { yieldStartDate: yieldStartDate ? isoToDate(yieldStartDate) : null } : {}),
      ...(yieldIndex ? {} : { yieldIndex: null, yieldRateBps: null, yieldStartDate: null }),
    },
  });
  await audit(ctx, { action: "UPDATE", entityType: "Account", entityId: id, before: current, after: updated });
  await publishEvent(ctx.householdId, "account.changed", id);
  const yieldChanged = ["yieldIndex", "yieldRateBps", "yieldStartDate", "initialBalanceCents", "initialBalanceDate"].some((k) => JSON.stringify((current as Record<string, unknown>)[k]) !== JSON.stringify((updated as Record<string, unknown>)[k]));
  // Configuração alterada: reapura. Desligada: os rendimentos já lançados ficam (eram ganhos reais).
  if (yieldChanged && updated.yieldIndex) await accrueAfterChange(id);
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
  const all = (await listAccounts(ctx)).filter((a) => a.includeInTotals && (!params.accountIds?.length || params.accountIds.includes(a.id)));
  if (!all.length) return { points: [] as Array<{ date: string; balanceCents: number }> };
  // Contas em reais somam direto; as estrangeiras entram convertidas pela cotação de cada dia.
  const accounts = all.filter((a) => a.currency === "BRL");
  const foreign = all.filter((a) => a.currency !== "BRL");
  const foreignDaily = await foreignBalanceInBrl(foreign, params.start, params.end);
  if (!accounts.length) return { points: daysBetween(params.start, params.end).map((date) => ({ date, balanceCents: foreignDaily.get(date) ?? 0 })) };
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
    return { date, balanceCents: running + (foreignDaily.get(date) ?? 0) };
  });
  return { points };
}

/** Soma diária, em reais, do saldo das contas em moeda estrangeira (PTAX vigente em cada dia). */
async function foreignBalanceInBrl(accounts: AccountDTO[], start: ISODate, end: ISODate): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!accounts.length) return out;
  const days = daysBetween(start, end);
  for (const a of accounts) {
    const [before, daily, rates] = await Promise.all([
      prisma.ledgerEntry.aggregate({ where: { accountId: a.id, date: { lt: isoToDate(start) } }, _sum: { amountCents: true } }),
      prisma.ledgerEntry.groupBy({ by: ["date"], where: { accountId: a.id, date: { gte: isoToDate(start), lte: isoToDate(end) } }, _sum: { amountCents: true } }),
      prisma.exchangeRate.findMany({ where: { currency: a.currency, date: { lte: isoToDate(end) } }, orderBy: { date: "asc" }, select: { date: true, rateBrl: true } }),
    ]);
    const moves = new Map(daily.map((d) => [dateToISO(d.date), d._sum.amountCents ?? 0]));
    let running = a.initialBalanceCents + (before._sum.amountCents ?? 0);
    let ri = 0;
    let rate: number | null = null;
    for (const day of days) {
      running += moves.get(day) ?? 0;
      while (ri < rates.length && dateToISO(rates[ri]!.date) <= day) rate = Number(rates[ri++]!.rateBrl);
      if (rate !== null) out.set(day, (out.get(day) ?? 0) + Math.round(running * rate));
    }
  }
  return out;
}

/** Verificação de integridade: transferências somam zero e cada transação tem os lançamentos esperados. */
export async function verifyLedgerIntegrity(householdId: string) {
  const issues: string[] = [];
  const transfers = await prisma.ledgerEntry.groupBy({
    by: ["transactionId"],
    // Transferência entre moedas não soma zero (os dois lados estão em moedas diferentes).
    where: { householdId, kind: { in: ["TRANSFER_IN", "TRANSFER_OUT"] }, transaction: { destinationAmountCents: null } },
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


