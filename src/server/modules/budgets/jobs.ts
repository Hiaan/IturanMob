import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { checkBudgetAlerts } from "./service";

/** Verifica limites de orçamento e emite alertas (uma vez por limiar/mês). Idempotente. */
export async function runBudgetAlertJobs(householdId?: string): Promise<{ households: number; alerts: number; notifications: number }> {
  const households = householdId
    ? [{ householdId }]
    : await prisma.budget.findMany({ distinct: ["householdId"], select: { householdId: true } });
  let alerts = 0;
  let notifications = 0;
  for (const h of households) {
    try {
      const res = await checkBudgetAlerts(h.householdId);
      alerts += res.alerts;
      notifications += res.notifications;
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: h.householdId }, "budgets: falha ao verificar alertas");
    }
  }
  return { households: households.length, alerts, notifications };
}
