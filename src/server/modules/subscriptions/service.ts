import { z } from "zod";
import type { SubscriptionCandidate } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError, ValidationError } from "../../errors";
import { errorInfo, logger } from "../../logger";
import { publishEvent } from "../../events";
import { addDays, addMonths, dateToISO, diffDays, formatDateBR, isoToDate, todayISO, type ISODate } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { normalizeText, tokenSimilarity } from "@/lib/utils";
import { audit } from "../audit/service";
import { notify } from "../notifications/service";
import { claimAlertMark } from "../notifications/marks";
import { createRecurring } from "../recurring/service";
import { getVisibilityScope } from "../visibility/scope";

/**
 * Assinaturas e cobranças mensais esquecidas: a mesma cobrança (mesmo estabelecimento, valor
 * parecido) em 3 meses seguidos, com ~30 dias entre elas, que não está nos gastos fixos. Só sugere:
 * nada vira gasto fixo sem a pessoa tocar em "Cadastrar". Também avisa quando o valor sobe.
 */

export const MIN_OCCURRENCES = 3;
const GAP_MIN = 24;
const GAP_MAX = 38;
/** Variação aceita entre cobranças seguidas (reajuste de preço continua sendo a mesma assinatura). */
const STEP_TOLERANCE = 0.3;
/** Cobrança mais recente até 40 dias atrás: assinatura ainda ativa. */
const ACTIVE_DAYS = 40;
/** Aumento que vale aviso: 5% e pelo menos R$ 1,00. */
const RAISE_PERCENT = 0.05;
const RAISE_MIN_CENTS = 100;
const LOOKBACK_DAYS = 200;

const NOISE = new Set(["pg", "pag", "pagto", "pagamento", "compra", "debito", "credito", "pix", "parc", "parcela", "br", "com", "www", "ltda", "sa", "me", "eireli", "int", "intl", "assinatura", "mensalidade", "de", "do", "da"]);

/** "PG *NETFLIX.COM 10/10" → "netflix" (chave da detecção). */
export function chargeKey(description: string): string {
  const tokens = normalizeText(description)
    .split(" ")
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !NOISE.has(t));
  return tokens.slice(0, 3).join(" ");
}

export interface ChargeTx {
  id: string;
  date: ISODate;
  amountCents: number;
  description: string;
  merchantId: string | null;
  merchantName: string | null;
  categoryId: string | null;
  accountId: string | null;
  creditCardId: string | null;
}

export interface DetectedCharge {
  key: string;
  name: string;
  occurrences: number;
  amountCents: number;
  previousAmountCents: number | null;
  firstChargeDate: ISODate;
  lastChargeDate: ISODate;
  last: ChargeTx;
}

/** Cobranças mensais nos lançamentos (função pura: testável sem banco). */
export function detectMonthlyCharges(txs: ChargeTx[], today: ISODate): DetectedCharge[] {
  const groups = new Map<string, ChargeTx[]>();
  for (const tx of txs) {
    const key = tx.merchantId ? `m:${tx.merchantId}` : chargeKey(tx.merchantName ?? tx.description);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(tx);
    groups.set(key, list);
  }
  const found: DetectedCharge[] = [];
  for (const [key, list] of groups) {
    if (list.length < MIN_OCCURRENCES) continue;
    list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    // Mais de uma cobrança no mesmo mês (mercado, farmácia, app de transporte): não é assinatura.
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    if (months.size !== list.length) continue;
    // Corrente de cobranças seguidas, de trás para a frente.
    const chain = [list[list.length - 1]!];
    for (let i = list.length - 2; i >= 0; i--) {
      const cur = list[i]!;
      const next = chain[0]!;
      const gap = diffDays(next.date, cur.date);
      const step = Math.abs(next.amountCents - cur.amountCents) / Math.max(cur.amountCents, 1);
      if (gap < GAP_MIN || gap > GAP_MAX || step > STEP_TOLERANCE) break;
      chain.unshift(cur);
    }
    if (chain.length < MIN_OCCURRENCES) continue;
    const last = chain[chain.length - 1]!;
    if (diffDays(today, last.date) > ACTIVE_DAYS) continue;
    const prev = chain[chain.length - 2]!;
    found.push({
      key: key.startsWith("m:") ? key : `d:${key}`,
      name: (last.merchantName ?? last.description).trim().slice(0, 120),
      occurrences: chain.length,
      amountCents: last.amountCents,
      previousAmountCents: prev.amountCents,
      firstChargeDate: chain[0]!.date,
      lastChargeDate: last.date,
      last,
    });
  }
  return found;
}

export function isPriceRaise(previousCents: number | null | undefined, currentCents: number): boolean {
  if (!previousCents) return false;
  return currentCents - previousCents >= RAISE_MIN_CENTS && currentCents >= previousCents * (1 + RAISE_PERCENT);
}

function raiseText(prev: number, cur: number): string {
  const pct = Math.round(((cur - prev) / prev) * 100);
  return `${formatBRL(cur)} (antes ${formatBRL(prev)}, +${pct}%)`;
}

interface Privacy {
  recipientMemberIds?: string[];
  inAppOnly: boolean;
}

async function privacyOf(householdId: string, accountId: string | null, creditCardId: string | null): Promise<Privacy> {
  if (creditCardId) {
    const card = await prisma.creditCard.findFirst({ where: { id: creditCardId, householdId }, select: { visibility: true, holderMemberId: true } });
    if (card?.visibility === "PRIVATE") return { recipientMemberIds: card.holderMemberId ? [card.holderMemberId] : [], inAppOnly: true };
  } else if (accountId) {
    const acc = await prisma.account.findFirst({ where: { id: accountId, householdId }, select: { visibility: true, ownerMemberId: true } });
    if (acc?.visibility === "PRIVATE") return { recipientMemberIds: acc.ownerMemberId ? [acc.ownerMemberId] : [], inAppOnly: true };
  }
  return { inAppOnly: false };
}

async function notifyCharge(householdId: string, privacy: Privacy, input: { title: string; body: string; dedupeKey: string; data: Record<string, unknown> }): Promise<boolean> {
  if (privacy.recipientMemberIds && !privacy.recipientMemberIds.length) return false;
  const res = await notify({
    householdId,
    type: "SUBSCRIPTION_FOUND",
    title: input.title,
    body: input.body,
    dedupeKey: input.dedupeKey,
    recipientMemberIds: privacy.recipientMemberIds,
    data: { ...input.data, url: "/gastos-fixos", ...(privacy.inAppOnly ? { inAppOnly: true } : {}) },
  });
  return res.created > 0;
}

export interface SubscriptionJobSummary {
  households: number;
  found: number;
  raises: number;
}

async function detectForHousehold(householdId: string, today: ISODate): Promise<{ found: number; raises: number }> {
  let found = 0;
  let raises = 0;
  const txs = await prisma.transaction.findMany({
    where: {
      householdId,
      type: "EXPENSE",
      status: "CONFIRMED",
      deletedAt: null,
      excludedFromReports: false,
      installmentCount: 1,
      recurringTransactionId: null,
      date: { gte: isoToDate(addDays(today, -LOOKBACK_DAYS)), lte: isoToDate(today) },
    },
    select: { id: true, date: true, amountCents: true, description: true, merchantId: true, categoryId: true, accountId: true, creditCardId: true, merchant: { select: { name: true } } },
  });
  const recurring = await prisma.recurringTransaction.findMany({
    where: { householdId, active: true, type: "EXPENSE" },
    select: { id: true, description: true, merchantId: true, amountCents: true, isVariableAmount: true, accountId: true, creditCardId: true, merchant: { select: { name: true } } },
  });
  const charges = detectMonthlyCharges(
    txs.map((t) => ({
      id: t.id,
      date: dateToISO(t.date),
      amountCents: t.amountCents,
      description: t.description,
      merchantId: t.merchantId,
      merchantName: t.merchant?.name ?? null,
      categoryId: t.categoryId,
      accountId: t.accountId,
      creditCardId: t.creditCardId,
    })),
    today,
  );
  for (const c of charges) {
    // Já está nos gastos fixos (mesmo estabelecimento ou descrição parecida)?
    const known = recurring.some(
      (r) =>
        (c.last.merchantId && r.merchantId === c.last.merchantId) ||
        tokenSimilarity(normalizeText(r.merchant?.name ?? r.description), normalizeText(c.name)) >= 0.8 ||
        (chargeKey(r.description) !== "" && chargeKey(r.description) === chargeKey(c.name)),
    );
    if (known) continue;
    const existing = await prisma.subscriptionCandidate.findUnique({ where: { householdId_merchantKey: { householdId, merchantKey: c.key } } });
    const fields = {
      merchantName: c.name,
      amountCents: c.amountCents,
      previousAmountCents: c.previousAmountCents,
      occurrences: c.occurrences,
      firstChargeDate: isoToDate(c.firstChargeDate),
      lastChargeDate: isoToDate(c.lastChargeDate),
      lastTransactionId: c.last.id,
      categoryId: c.last.categoryId,
      accountId: c.last.accountId,
      creditCardId: c.last.creditCardId,
    };
    if (existing?.status === "ACCEPTED") continue;
    const cand = existing
      ? await prisma.subscriptionCandidate.update({ where: { id: existing.id }, data: fields })
      : await prisma.subscriptionCandidate.create({ data: { householdId, merchantKey: c.key, ...fields } });
    if (cand.status === "IGNORED") continue;
    const privacy = await privacyOf(householdId, cand.accountId, cand.creditCardId);
    if (!existing) {
      if (await claimAlertMark(householdId, `sub:${cand.id}:found`)) {
        const sent = await notifyCharge(householdId, privacy, {
          title: `Cobrança todo mês: ${c.name}`,
          body: `${c.name} cobrou ${formatBRL(c.amountCents)} em ${c.occurrences} meses seguidos (última em ${formatDateBR(c.lastChargeDate)}) e não está nos gastos fixos. Se ainda usa, cadastre como gasto fixo; se não usa mais, vale cancelar.`,
          dedupeKey: `sub:${cand.id}:found`,
          data: { subscriptionCandidateId: cand.id, amountCents: c.amountCents, stage: "FOUND" },
        });
        if (sent) found++;
      }
    } else if (existing.lastTransactionId !== c.last.id && isPriceRaise(c.previousAmountCents, c.amountCents)) {
      if (await claimAlertMark(householdId, `sub:${cand.id}:raise:${c.last.id}`)) {
        const sent = await notifyCharge(householdId, privacy, {
          title: `${c.name} ficou mais cara`,
          body: `A cobrança de ${c.name} veio ${raiseText(c.previousAmountCents!, c.amountCents)} em ${formatDateBR(c.lastChargeDate)}.`,
          dedupeKey: `sub:${cand.id}:raise:${c.last.id}`,
          data: { subscriptionCandidateId: cand.id, amountCents: c.amountCents, previousAmountCents: c.previousAmountCents, stage: "RAISE" },
        });
        if (sent) raises++;
      }
    }
  }

  // Gastos fixos (valor fixo) cuja última cobrança veio mais cara que o cadastrado.
  for (const r of recurring) {
    if (r.isVariableAmount) continue;
    const last = await prisma.transaction.findFirst({
      where: { householdId, recurringTransactionId: r.id, deletedAt: null, status: "CONFIRMED", date: { gte: isoToDate(addDays(today, -ACTIVE_DAYS)) } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      select: { id: true, amountCents: true, date: true },
    });
    if (!last || !isPriceRaise(r.amountCents, last.amountCents)) continue;
    if (!(await claimAlertMark(householdId, `price:rec:${r.id}:${last.id}`))) continue;
    const name = r.merchant?.name ?? r.description;
    const sent = await notifyCharge(householdId, await privacyOf(householdId, r.accountId, r.creditCardId), {
      title: `${name} ficou mais cara`,
      body: `A cobrança de ${name} veio ${raiseText(r.amountCents, last.amountCents)} em ${formatDateBR(dateToISO(last.date))}. Se o novo valor ficar, atualize o gasto fixo.`,
      dedupeKey: `price:rec:${r.id}:${last.id}`,
      data: { recurringTransactionId: r.id, amountCents: last.amountCents, previousAmountCents: r.amountCents, stage: "RAISE" },
    });
    if (sent) raises++;
  }
  return { found, raises };
}

/** Tarefa periódica (1x por dia é o bastante; idempotente pelas marcas de aviso). */
export async function runSubscriptionJobs(now: Date = new Date(), opts: { householdId?: string } = {}): Promise<SubscriptionJobSummary> {
  const summary: SubscriptionJobSummary = { households: 0, found: 0, raises: 0 };
  const households = await prisma.household.findMany({ where: opts.householdId ? { id: opts.householdId } : {}, select: { id: true, timezone: true } });
  for (const h of households) {
    summary.households++;
    try {
      const res = await detectForHousehold(h.id, todayISO(h.timezone, now));
      summary.found += res.found;
      summary.raises += res.raises;
      if (res.found || res.raises) await publishEvent(h.id, "notification.created");
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: h.id }, "assinaturas: falha na detecção");
    }
  }
  return summary;
}

// -----------------------------------------------------------------------------
// Tela "Gastos fixos": assinaturas encontradas
// -----------------------------------------------------------------------------

export interface SubscriptionCandidateDTO {
  id: string;
  merchantName: string;
  amountCents: number;
  previousAmountCents: number | null;
  priceRaised: boolean;
  occurrences: number;
  firstChargeDate: string;
  lastChargeDate: string;
  categoryId: string | null;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string } | null;
  status: SubscriptionCandidate["status"];
}

async function visibleWhere(ctx: ServiceContext) {
  const scope = await getVisibilityScope(ctx);
  const and = [];
  if (scope.hiddenAccountIds.length) and.push({ OR: [{ accountId: null }, { accountId: { notIn: scope.hiddenAccountIds } }] });
  if (scope.hiddenCardIds.length) and.push({ OR: [{ creditCardId: null }, { creditCardId: { notIn: scope.hiddenCardIds } }] });
  return and.length ? { AND: and } : {};
}

export async function listSubscriptionCandidates(ctx: ServiceContext, opts: { status?: "OPEN" | "IGNORED" } = {}): Promise<SubscriptionCandidateDTO[]> {
  assertCan(ctx, "transactions:read");
  const rows = await prisma.subscriptionCandidate.findMany({
    where: { householdId: ctx.householdId, status: opts.status ?? "OPEN", ...(await visibleWhere(ctx)) },
    orderBy: [{ lastChargeDate: "desc" }],
  });
  const [accounts, cards] = await Promise.all([
    prisma.account.findMany({ where: { householdId: ctx.householdId, id: { in: rows.map((r) => r.accountId).filter((v): v is string => Boolean(v)) } }, select: { id: true, name: true } }),
    prisma.creditCard.findMany({ where: { householdId: ctx.householdId, id: { in: rows.map((r) => r.creditCardId).filter((v): v is string => Boolean(v)) } }, select: { id: true, name: true } }),
  ]);
  return rows.map((r) => ({
    id: r.id,
    merchantName: r.merchantName,
    amountCents: r.amountCents,
    previousAmountCents: r.previousAmountCents,
    priceRaised: isPriceRaise(r.previousAmountCents, r.amountCents),
    occurrences: r.occurrences,
    firstChargeDate: dateToISO(r.firstChargeDate),
    lastChargeDate: dateToISO(r.lastChargeDate),
    categoryId: r.categoryId,
    account: accounts.find((a) => a.id === r.accountId) ?? null,
    creditCard: cards.find((c) => c.id === r.creditCardId) ?? null,
    status: r.status,
  }));
}

async function loadCandidate(ctx: ServiceContext, id: string) {
  const cand = await prisma.subscriptionCandidate.findFirst({ where: { id, householdId: ctx.householdId, ...(await visibleWhere(ctx)) } });
  if (!cand) throw new NotFoundError("Assinatura");
  return cand;
}

export const acceptSubscriptionSchema = z.object({
  description: z.string().trim().min(1).max(200).optional(),
  categoryId: z.string().min(1).nullish(),
});

/**
 * "Cadastrar": vira gasto fixo mensal (sem lançamento automático, para não duplicar com a fatura
 * ou o extrato) e as cobranças já registradas passam a apontar para ele.
 */
export async function acceptSubscriptionCandidate(ctx: ServiceContext, id: string, input: z.input<typeof acceptSubscriptionSchema> = {}) {
  assertCan(ctx, "bills:write");
  const body = acceptSubscriptionSchema.parse(input);
  const cand = await loadCandidate(ctx, id);
  if (cand.status === "ACCEPTED") throw new ValidationError("Esta assinatura já está nos gastos fixos.");
  const last = dateToISO(cand.lastChargeDate);
  const day = Number(last.slice(8, 10));
  let start = addMonths(last, 1, day);
  const today = todayISO(ctx.timezone);
  while (start < today) start = addMonths(start, 1, day);
  const rec = await createRecurring(ctx, {
    type: "EXPENSE",
    description: body.description ?? cand.merchantName,
    amountCents: cand.amountCents,
    isVariableAmount: false,
    categoryId: body.categoryId !== undefined ? body.categoryId : cand.categoryId,
    merchantName: cand.merchantName,
    accountId: cand.creditCardId ? null : cand.accountId,
    creditCardId: cand.creditCardId,
    frequency: "MONTHLY",
    dayOfMonth: day,
    startDate: start,
    autoPost: false,
  });
  // Liga as cobranças já registradas desta assinatura (mesma chave, últimos meses) ao gasto fixo.
  const since = addDays(dateToISO(cand.firstChargeDate), -1);
  const txs = await prisma.transaction.findMany({
    where: { householdId: ctx.householdId, type: "EXPENSE", deletedAt: null, recurringTransactionId: null, date: { gte: isoToDate(since) } },
    select: { id: true, description: true, merchantId: true, merchant: { select: { name: true } } },
  });
  const linked = txs
    .filter((t) => (cand.merchantKey.startsWith("m:") ? `m:${t.merchantId}` === cand.merchantKey : `d:${chargeKey(t.merchant?.name ?? t.description)}` === cand.merchantKey))
    .map((t) => t.id);
  if (linked.length) await prisma.transaction.updateMany({ where: { id: { in: linked }, householdId: ctx.householdId }, data: { recurringTransactionId: rec.id } });
  await prisma.subscriptionCandidate.update({ where: { id: cand.id }, data: { status: "ACCEPTED", recurringTransactionId: rec.id } });
  await audit(ctx, { action: "UPDATE", entityType: "SubscriptionCandidate", entityId: cand.id, before: { status: cand.status }, after: { status: "ACCEPTED", recurringTransactionId: rec.id, linkedTransactions: linked.length } });
  return { recurring: rec, linkedTransactions: linked.length };
}

/** "Ignorar": não aparece mais nem gera avisos (pode ser reaberta). */
export async function setSubscriptionCandidateStatus(ctx: ServiceContext, id: string, status: "IGNORED" | "OPEN") {
  assertCan(ctx, "bills:write");
  const cand = await loadCandidate(ctx, id);
  if (cand.status === "ACCEPTED") throw new ValidationError("Esta assinatura já está nos gastos fixos.");
  await prisma.subscriptionCandidate.update({ where: { id }, data: { status } });
  await audit(ctx, { action: "UPDATE", entityType: "SubscriptionCandidate", entityId: id, before: { status: cand.status }, after: { status } });
  return { id, status };
}
