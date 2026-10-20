import { prisma } from "../../db";
import { systemContext } from "../../auth/context";
import { errorInfo, logger } from "../../logger";
import { publishEvent } from "../../events";
import { audit } from "../audit/service";
import { dateToISO, diffDays, monthKey, todayISO } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { getSettings } from "../households/service";
import { notify } from "../notifications/service";
import { claimAlertMark } from "../notifications/marks";
import { computeIncomeProgress, effectiveThresholds, INCOME_GOAL_SCOPE_LABELS, incomeForGoal, monthName } from "../income-goals/service";

/**
 * Avisos de metas (idempotentes, cada faixa/aviso uma vez por período):
 * - Meta de ganho: faixas do mês (as da meta ou as do orçamento), "🎉 meta batida" e, a partir do
 *   dia 25, um único aviso de ritmo quando a receita está abaixo de 75%.
 * - Metas de economia: 50/75/90/100% do valor-alvo, prazo (30 e 7 dias) abaixo do esperado e conclusão.
 */

/** A partir deste dia do mês, avisa uma vez se a meta de ganho estiver abaixo de PACE_PERCENT. */
export const PACE_DAY = 25;
export const PACE_PERCENT = 75;
export const SAVINGS_BANDS = [50, 75, 90, 100];

export interface GoalAlertSummary {
  households: number;
  incomeNotices: number;
  savingsNotices: number;
}

const scopeSuffix = (scope: keyof typeof INCOME_GOAL_SCOPE_LABELS, categoryName: string | null) => {
  const parts = [categoryName, scope === "ALL" ? null : INCOME_GOAL_SCOPE_LABELS[scope]].filter(Boolean);
  return parts.length ? ` (${parts.join(" · ")})` : "";
};

async function incomeGoalAlerts(householdId: string, timezone: string, today: string): Promise<number> {
  const goals = await prisma.incomeGoal.findMany({ where: { householdId, active: true }, include: { category: { select: { name: true } } } });
  if (!goals.length) return 0;
  const ctx = systemContext(householdId, timezone);
  const settings = await getSettings(householdId);
  const month = monthKey(today);
  const name = monthName(month);
  let sent = 0;
  for (const g of goals) {
    const incomeCents = await incomeForGoal(ctx, g, month);
    const p = computeIncomeProgress(g.targetCents, incomeCents, month, today);
    const suffix = scopeSuffix(g.scope, g.category?.name ?? null);
    const base = { incomeGoalId: g.id, month, incomeCents, targetCents: g.targetCents, url: "/metas" };

    const reached = effectiveThresholds(g.alertThresholds, settings.budgetAlertThresholds).filter((t) => incomeCents * 100 >= t * g.targetCents);
    const fresh: number[] = [];
    for (const t of reached) if (await claimAlertMark(householdId, `income:${g.id}:${month}:${t}`)) fresh.push(t);
    const top = fresh[fresh.length - 1];
    if (top !== undefined) {
      const done = top >= 100;
      const res = await notify({
        householdId,
        type: "INCOME_GOAL",
        title: done ? "🎉 Meta de ganho batida" : `Meta de ganho: ${top}%`,
        body: done
          ? `🎉 Meta de ganho de ${name}${suffix} batida: ${formatBRL(incomeCents)} de ${formatBRL(g.targetCents)}.`
          : `Meta de ganho de ${name}${suffix}: ${top}% — ${formatBRL(incomeCents)} de ${formatBRL(g.targetCents)}. Faltam ${formatBRL(p.remainingCents)}.`,
        dedupeKey: `income-goal:${g.id}:${month}:${top}`,
        data: { ...base, threshold: top },
      });
      if (res.created) sent++;
    }

    // Perto do fim do mês e abaixo do ritmo: um único aviso.
    const day = Number(today.slice(8, 10));
    if (day >= PACE_DAY && p.percent < PACE_PERCENT && !p.reached && (await claimAlertMark(householdId, `income-pace:${g.id}:${month}`))) {
      const res = await notify({
        householdId,
        type: "INCOME_GOAL",
        title: "Meta de ganho: reta final",
        body: `Faltam ${formatBRL(p.remainingCents)} em ${p.daysLeft} dia${p.daysLeft === 1 ? "" : "s"} para a meta de ganho de ${name}${suffix}: ${formatBRL(incomeCents)} de ${formatBRL(g.targetCents)} (${p.percent}%).`,
        dedupeKey: `income-pace:${g.id}:${month}`,
        data: { ...base, pace: true },
      });
      if (res.created) sent++;
    }
  }
  return sent;
}

/** Meta concluída há mais tempo que isso (ex.: antes desta versão): as faixas são registradas sem aviso. */
const COMPLETED_NOTICE_WINDOW_MS = 7 * 86_400_000;

async function savingsGoalAlerts(householdId: string, timezone: string, today: string, now: Date): Promise<number> {
  const goals = await prisma.financialGoal.findMany({ where: { householdId, status: { in: ["ACTIVE", "COMPLETED"] } } });
  if (!goals.length) return 0;
  const sums = await prisma.goalContribution.groupBy({ by: ["goalId"], where: { goalId: { in: goals.map((g) => g.id) }, deletedAt: null }, _sum: { amountCents: true } });
  const savedOf = new Map(sums.map((s) => [s.goalId, s._sum.amountCents ?? 0]));
  const ctx = systemContext(householdId, timezone);
  let sent = 0;
  for (const g of goals) {
    if (g.targetCents <= 0) continue;
    const saved = Math.max(0, savedOf.get(g.id) ?? 0);
    const remaining = Math.max(0, g.targetCents - saved);
    const percent = Math.floor((saved * 100) / g.targetCents);
    const base = { goalId: g.id, savedCents: saved, targetCents: g.targetCents, url: "/metas" };

    const fresh: number[] = [];
    for (const band of SAVINGS_BANDS.filter((b) => saved * 100 >= b * g.targetCents)) if (await claimAlertMark(householdId, `goal:${g.id}:${band}`)) fresh.push(band);
    const top = fresh[fresh.length - 1];
    const stale = g.status === "COMPLETED" && now.getTime() - g.updatedAt.getTime() > COMPLETED_NOTICE_WINDOW_MS;
    if (top !== undefined && !stale) {
      const done = top >= 100;
      if (done && g.status === "ACTIVE") {
        // Concluída: marca a meta (como ao registrar o aporte que atingiu o valor).
        const updated = await prisma.financialGoal.updateMany({ where: { id: g.id, status: "ACTIVE" }, data: { status: "COMPLETED" } });
        if (updated.count) {
          await audit(ctx, { action: "UPDATE", entityType: "FinancialGoal", entityId: g.id, before: { status: "ACTIVE" }, after: { status: "COMPLETED" }, source: "auto", metadata: { reason: "Valor desejado atingido", savedCents: saved } });
          await publishEvent(householdId, "goal.changed", g.id);
        }
      }
      const res = await notify({
        householdId,
        type: "GOAL_PROGRESS",
        title: done ? `🎉 Meta "${g.name}" concluída` : `Meta "${g.name}": ${top}%`,
        body: done
          ? `🎉 Parabéns! A meta "${g.name}" foi concluída: ${formatBRL(saved)} de ${formatBRL(g.targetCents)}.`
          : `A meta "${g.name}" chegou a ${top}%: ${formatBRL(saved)} de ${formatBRL(g.targetCents)}. Faltam ${formatBRL(remaining)}.`,
        dedupeKey: `goal:${g.id}:${top}`,
        data: { ...base, threshold: top },
      });
      if (res.created) sent++;
    }

    // Prazo: 30 e 7 dias antes, se abaixo do esperado (ritmo linear desde a criação da meta).
    if (g.status !== "ACTIVE" || !g.deadline || remaining <= 0) continue;
    const deadline = dateToISO(g.deadline);
    const daysLeft = diffDays(deadline, today);
    if (daysLeft < 0 || daysLeft > 30) continue;
    const stage = daysLeft <= 7 ? 7 : 30;
    const span = Math.max(1, diffDays(deadline, dateToISO(g.createdAt)));
    const expected = Math.min(100, Math.max(0, (diffDays(today, dateToISO(g.createdAt)) * 100) / span));
    if (percent >= expected) continue;
    if (!(await claimAlertMark(householdId, `goal-deadline:${g.id}:${stage}`))) continue;
    const perDay = Math.ceil(remaining / Math.max(1, daysLeft));
    const days = daysLeft === 0 ? "o prazo termina hoje" : `${daysLeft} dia${daysLeft === 1 ? "" : "s"}`;
    const res = await notify({
      householdId,
      type: "GOAL_PROGRESS",
      title: `Prazo da meta "${g.name}"`,
      body:
        daysLeft === 0
          ? `Faltam ${formatBRL(remaining)} para "${g.name}" e ${days} (${percent}% guardado).`
          : `Faltam ${formatBRL(remaining)} e ${days} para "${g.name}"; precisaria guardar ${formatBRL(perDay)}/dia.`,
      dedupeKey: `goal-deadline:${g.id}:${stage}`,
      data: { ...base, deadline, daysLeft, perDayCents: perDay },
    });
    if (res.created) sent++;
  }
  return sent;
}

export async function runGoalAlertJobs(now: Date = new Date(), opts: { householdId?: string } = {}): Promise<GoalAlertSummary> {
  const summary: GoalAlertSummary = { households: 0, incomeNotices: 0, savingsNotices: 0 };
  const households = await prisma.household.findMany({
    where: { ...(opts.householdId ? { id: opts.householdId } : {}), OR: [{ incomeGoals: { some: { active: true } } }, { goals: { some: { status: { in: ["ACTIVE", "COMPLETED"] } } } }] },
    select: { id: true, timezone: true },
  });
  for (const h of households) {
    summary.households++;
    const today = todayISO(h.timezone, now);
    try {
      summary.incomeNotices += await incomeGoalAlerts(h.id, h.timezone, today);
      summary.savingsNotices += await savingsGoalAlerts(h.id, h.timezone, today, now);
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: h.id }, "goals: falha nos avisos de metas");
    }
  }
  return summary;
}
