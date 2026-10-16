import { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../db";
import { systemContext, type ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError, ValidationError } from "../../errors";
import { errorInfo, logger } from "../../logger";
import { publishEvent } from "../../events";
import { env } from "../../env";
import { addDays, dateToISO, formatMonthBR, todayISO, type ISODate } from "@/lib/dates";
import { normalizeText } from "@/lib/utils";
import { visibleAccountWhere } from "../visibility/scope";
import { createTransaction, deleteTransaction, updateTransaction } from "../transactions/service";
import { computeYield, estimateNet, type Movement, type YieldConfig, type YieldIndexValue } from "./yield-calc";
import { loadRates, missingRange, refreshIndexRates, RatesUnavailableError } from "./rates";

/**
 * Rendimento automático das contas de investimento. A cada execução, o rendimento é recalculado
 * desde o início configurado (o cálculo é determinístico) e cada mês vira UMA receita em
 * "Investimentos > Rendimentos" — criada ou ajustada, nunca duplicada (único por conta e mês, com
 * trava por conta). Valores brutos; a estimativa líquida (IR/IOF) é só informativa.
 */

const INDEX_LABEL: Record<YieldIndexValue, string> = { CDI: "CDI", SELIC: "Selic", IPCA: "IPCA", PREFIXED: "prefixado" };

export function describeYield(index: YieldIndexValue, rateBps: number): string {
  const pct = (rateBps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (index === "CDI") return `${pct}% do CDI`;
  if (index === "SELIC") return `${pct}% da Selic`;
  if (index === "IPCA") return `IPCA + ${pct}% a.a.`;
  return `${pct}% a.a. (prefixado)`;
}

type YieldAccount = Prisma.AccountGetPayload<{ select: typeof accountSelect }>;
const accountSelect = {
  id: true,
  householdId: true,
  name: true,
  type: true,
  initialBalanceCents: true,
  initialBalanceDate: true,
  yieldIndex: true,
  yieldRateBps: true,
  yieldStartDate: true,
  archivedAt: true,
  household: { select: { timezone: true } },
} satisfies Prisma.AccountSelect;

function configOf(a: YieldAccount): YieldConfig | null {
  if (!a.yieldIndex || !a.yieldRateBps || !a.yieldStartDate || a.archivedAt) return null;
  return { index: a.yieldIndex, rateBps: a.yieldRateBps, startDate: dateToISO(a.yieldStartDate) };
}

/** Saldo inicial + movimentos do ledger, sem os rendimentos lançados por este módulo. */
async function movementsOf(a: YieldAccount): Promise<Movement[]> {
  const entries = await prisma.ledgerEntry.groupBy({
    by: ["date"],
    where: { accountId: a.id, transaction: { investmentYield: { is: null } } },
    _sum: { amountCents: true },
  });
  return [
    { date: dateToISO(a.initialBalanceDate), amountCents: a.initialBalanceCents },
    ...entries.map((e) => ({ date: dateToISO(e.date), amountCents: e._sum.amountCents ?? 0 })),
  ].filter((m) => m.amountCents !== 0);
}

async function incomeCategory(householdId: string) {
  const cats = await prisma.category.findMany({ where: { householdId, kind: "INCOME", archivedAt: null }, include: { subcategories: { where: { archivedAt: null } } } });
  const cat = cats.find((c) => normalizeText(c.name) === "investimentos") ?? null;
  const sub = cat?.subcategories.find((s) => normalizeText(s.name) === "rendimentos") ?? null;
  return { categoryId: cat?.id ?? null, subcategoryId: sub?.id ?? null };
}

export interface AccrualSummary {
  accounts: number;
  created: number;
  updated: number;
  removed: number;
  waiting: number;
}

/** Recalcula e lança o rendimento das contas configuradas (todas, de uma família ou uma conta). */
export async function runYieldAccrual(opts: { householdId?: string; accountId?: string; now?: Date } = {}): Promise<AccrualSummary> {
  const summary: AccrualSummary = { accounts: 0, created: 0, updated: 0, removed: 0, waiting: 0 };
  const accounts = await prisma.account.findMany({
    where: { yieldIndex: { not: null }, archivedAt: null, ...(opts.householdId ? { householdId: opts.householdId } : {}), ...(opts.accountId ? { id: opts.accountId } : {}) },
    select: accountSelect,
  });
  for (const account of accounts) {
    const cfg = configOf(account);
    if (!cfg) continue;
    summary.accounts++;
    try {
      const r = await accrueAccount(account, cfg, todayISO(account.household.timezone, opts.now));
      summary.created += r.created;
      summary.updated += r.updated;
      summary.removed += r.removed;
      if (r.waiting) summary.waiting++;
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: account.householdId, accountId: account.id }, "investimentos: falha ao apurar rendimento");
    }
  }
  return summary;
}

async function accrueAccount(account: YieldAccount, cfg: YieldConfig, today: ISODate) {
  const ctx = systemContext(account.householdId, account.household.timezone);
  // Rende até ontem (a taxa do dia só é publicada depois).
  const until = addDays(today, -1);
  const [movements, rates] = await Promise.all([movementsOf(account), loadRates(cfg.index, cfg.startDate, until)]);
  const result = computeYield(cfg, movements, rates, until);
  const category = await incomeCategory(account.householdId);
  const label = describeYield(cfg.index, cfg.rateBps);
  let created = 0;
  let updated = 0;
  let removed = 0;

  await withTransaction(async (db) => {
    // Uma apuração por conta por vez (execuções concorrentes do worker ou "atualizar agora").
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`yield:${account.id}`}))`;
    const existing = await db.investmentYield.findMany({ where: { accountId: account.id }, include: { transaction: { select: { id: true, deletedAt: true, amountCents: true, date: true } } } });
    const byMonth = new Map(existing.map((e) => [e.month, e]));
    const seen = new Set<string>();

    for (const m of result.months) {
      seen.add(m.month);
      const row = byMonth.get(m.month);
      if (row?.dismissed) continue;
      if (row?.transaction?.deletedAt) {
        // Alguém excluiu o rendimento do mês: respeita e não recria.
        await db.investmentYield.update({ where: { id: row.id }, data: { dismissed: true } });
        continue;
      }
      const description = `Rendimento ${account.name} — ${formatMonthBR(m.month, { capitalize: false })}`.slice(0, 200);
      const notes = `Calculado automaticamente: ${m.businessDays} dia(s) útil(eis) a ${label} (taxas do Banco Central). Valor bruto, antes de IR/IOF; confira com o extrato e use "Ajustar ao saldo do banco" se houver diferença.`;
      if (m.grossCents <= 0) {
        if (row?.transaction && !row.transaction.deletedAt) {
          await deleteTransaction(ctx, row.transaction.id, { db, reason: "Rendimento recalculado: sem rendimento no mês" });
          removed++;
        }
        if (row) await db.investmentYield.delete({ where: { id: row.id } });
        continue;
      }
      if (row?.transaction) {
        if (row.transaction.amountCents !== m.grossCents || dateToISO(row.transaction.date) !== m.accruedThrough) {
          await updateTransaction(ctx, row.transaction.id, { amountCents: m.grossCents, date: m.accruedThrough, description, notes }, { db, reason: "Rendimento recalculado" });
          updated++;
        }
        await db.investmentYield.update({ where: { id: row.id }, data: { grossCents: m.grossCents, businessDays: m.businessDays, accruedThrough: new Date(`${m.accruedThrough}T00:00:00Z`) } });
        continue;
      }
      const res = await createTransaction(
        ctx,
        { type: "INCOME", amountCents: m.grossCents, description, notes, date: m.accruedThrough, accountId: account.id, categoryId: category.categoryId, subcategoryId: category.subcategoryId },
        { source: "SYSTEM", checkDuplicates: false, applyRules: false, db },
      );
      const data = { grossCents: m.grossCents, businessDays: m.businessDays, accruedThrough: new Date(`${m.accruedThrough}T00:00:00Z`), transactionId: res.transaction.id };
      if (row) await db.investmentYield.update({ where: { id: row.id }, data });
      else await db.investmentYield.create({ data: { ...data, householdId: account.householdId, accountId: account.id, month: m.month } });
      created++;
    }
    // Meses que deixaram de ter rendimento (ex.: início alterado): remove o lançamento automático.
    for (const row of existing) {
      if (seen.has(row.month) || row.dismissed) continue;
      if (row.transaction && !row.transaction.deletedAt) {
        await deleteTransaction(ctx, row.transaction.id, { db, reason: "Rendimento recalculado: mês fora do período configurado" });
        removed++;
      }
      await db.investmentYield.delete({ where: { id: row.id } });
    }
  });
  if (created || updated || removed) {
    await publishEvent(account.householdId, "transaction.changed");
    await publishEvent(account.householdId, "account.changed", account.id);
  }
  return { created, updated, removed, waiting: result.waitingIpca.length > 0 || (rates.lastBusinessDay ?? "") < addDays(until, -4) };
}

/** Busca no BCB as taxas que faltam para as contas configuradas. Falhas são registradas e não param o resto. */
export async function refreshNeededRates(opts: { householdId?: string; accountId?: string; now?: Date; fetchImpl?: Parameters<typeof refreshIndexRates>[3] } = {}) {
  const accounts = await prisma.account.findMany({
    where: { yieldIndex: { not: null }, yieldStartDate: { not: null }, archivedAt: null, ...(opts.householdId ? { householdId: opts.householdId } : {}), ...(opts.accountId ? { id: opts.accountId } : {}) },
    select: { yieldIndex: true, yieldStartDate: true },
  });
  if (!accounts.length) return { fetched: 0, errors: [] as string[] };
  const today = todayISO("America/Sao_Paulo", opts.now);
  const needed = new Map<"CDI" | "SELIC" | "IPCA", ISODate>();
  for (const a of accounts) {
    const start = dateToISO(a.yieldStartDate!);
    // O CDI é sempre necessário: é o calendário de dias úteis.
    for (const idx of ["CDI", ...(a.yieldIndex === "SELIC" || a.yieldIndex === "IPCA" ? [a.yieldIndex] : [])] as Array<"CDI" | "SELIC" | "IPCA">) {
      const from = idx === "IPCA" ? (`${start.slice(0, 7)}-01` as ISODate) : start;
      if (!needed.has(idx) || from < needed.get(idx)!) needed.set(idx, from);
    }
  }
  let fetched = 0;
  const errors: string[] = [];
  for (const [index, from] of needed) {
    const range = await missingRange(index, from, today);
    if (!range) continue;
    try {
      fetched += await refreshIndexRates(index, range.from, range.to, opts.fetchImpl);
    } catch (err) {
      const msg = err instanceof RatesUnavailableError ? err.message : "Falha ao buscar taxas.";
      errors.push(`${index}: ${msg}`);
      logger.warn({ index, err: errorInfo(err).message }, "investimentos: taxas do BCB indisponíveis — nova tentativa na próxima execução");
    }
  }
  return { fetched, errors };
}

/** Tarefa periódica do worker: atualiza as taxas e apura o rendimento. */
export async function runInvestmentYieldJobs(now: Date = new Date()) {
  if (!env().INVESTMENT_YIELD_ENABLED) return { skipped: true };
  const rates = await refreshNeededRates({ now });
  const accrual = await runYieldAccrual({ now });
  return { ...accrual, ratesFetched: rates.fetched, rateErrors: rates.errors.length };
}

// -----------------------------------------------------------------------------
// Consulta para a tela da conta
// -----------------------------------------------------------------------------

export async function getAccountYield(ctx: ServiceContext, accountId: string) {
  const account = await prisma.account.findFirst({ where: { id: accountId, ...visibleAccountWhere(ctx) }, select: accountSelect });
  if (!account) throw new NotFoundError("Conta");
  const cfg = configOf(account);
  const today = todayISO(ctx.timezone);
  // Mês com o lançamento excluído conta como "excluído" já na consulta (a apuração registra depois).
  const months = (await prisma.investmentYield.findMany({ where: { accountId }, orderBy: { month: "asc" }, include: { transaction: { select: { deletedAt: true } } } })).map((m) => ({
    ...m,
    dismissed: m.dismissed || Boolean(m.transaction?.deletedAt),
  }));
  const lastCdi = await prisma.indexRate.findFirst({ where: { index: "CDI" }, orderBy: { date: "desc" }, select: { date: true } });
  if (!cfg) return { configured: false as const, accountId, months: [], ratesThrough: lastCdi ? dateToISO(lastCdi.date) : null };

  const movements = await movementsOf(account);
  const grossCents = months.filter((m) => !m.dismissed).reduce((s, m) => s + m.grossCents, 0);
  const exempt = account.type === "SAVINGS" || /\b(lci|lca|poupanca|cri|cra|debenture incentivada)\b/.test(normalizeText(account.name));
  const estimate = estimateNet(movements, grossCents, today, { exempt });
  const accruedThrough = months.length ? dateToISO(months[months.length - 1]!.accruedThrough) : null;
  const ratesThrough = lastCdi ? dateToISO(lastCdi.date) : null;
  const status = !ratesThrough ? "WAITING_RATES" : accruedThrough && accruedThrough < addDays(today, -6) ? "BEHIND" : "OK";
  return {
    configured: true as const,
    accountId,
    index: cfg.index,
    rateBps: cfg.rateBps,
    startDate: cfg.startDate,
    label: describeYield(cfg.index, cfg.rateBps),
    status,
    ratesThrough,
    accruedThrough,
    grossCents,
    estimate: {
      ...estimate,
      note: exempt
        ? "Isento de IR (poupança/LCI/LCA, pelo tipo ou nome da conta)."
        : "Estimativa se tudo fosse resgatado hoje: IR regressivo (22,5% até 180 dias, 20% até 360, 17,5% até 720 e 15% depois) e IOF nos primeiros 30 dias. O valor real depende das datas de cada aplicação no banco.",
    },
    months: months.map((m) => ({ month: m.month, grossCents: m.grossCents, businessDays: m.businessDays, accruedThrough: dateToISO(m.accruedThrough), transactionId: m.transactionId, dismissed: m.dismissed })),
  };
}

/** "Atualizar agora": busca as taxas da conta e reapura (usado na tela da conta). */
export async function refreshAccountYield(ctx: ServiceContext, accountId: string) {
  assertCan(ctx, "accounts:write");
  const account = await prisma.account.findFirst({ where: { id: accountId, ...visibleAccountWhere(ctx) }, select: { id: true, yieldIndex: true } });
  if (!account) throw new NotFoundError("Conta");
  if (!account.yieldIndex) throw new ValidationError("Configure o rendimento automático da conta primeiro.");
  const rates = await refreshNeededRates({ accountId });
  const accrual = await runYieldAccrual({ accountId });
  return { ...accrual, rateErrors: rates.errors, yield: await getAccountYield(ctx, accountId) };
}
