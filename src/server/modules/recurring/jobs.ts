import { prisma } from "../../db";
import { systemContext } from "../../auth/context";
import { errorInfo, logger } from "../../logger";
import { isoToDate, todayISO } from "@/lib/dates";
import { autoPostOccurrence, generateOccurrences, reportAutoPostFailure } from "./service";

export interface RecurringJobSummary {
  households: number;
  generated: number;
  posted: number;
  failed: number;
}

/**
 * Gera ocorrências previstas (contas a pagar) para os próximos 60 dias e lança as recorrências
 * automáticas cujo vencimento chegou (hoje no fuso da família). Idempotente: o índice único
 * (recorrência, vencimento) e o bloqueio da ocorrência impedem duplicatas.
 */
export async function runRecurringJobs(now: Date = new Date(), opts: { householdId?: string } = {}): Promise<RecurringJobSummary> {
  const summary: RecurringJobSummary = { households: 0, generated: 0, posted: 0, failed: 0 };
  const recs = await prisma.recurringTransaction.findMany({
    where: { active: true, ...(opts.householdId ? { householdId: opts.householdId } : {}) },
    include: { household: { select: { timezone: true } } },
    orderBy: { createdAt: "asc" },
  });
  const byHousehold = new Map<string, typeof recs>();
  for (const rec of recs) byHousehold.set(rec.householdId, [...(byHousehold.get(rec.householdId) ?? []), rec]);

  for (const [householdId, list] of byHousehold) {
    summary.households++;
    const timezone = list[0]!.household.timezone;
    const today = todayISO(timezone, now);

    for (const rec of list) {
      try {
        summary.generated += await generateOccurrences(prisma, rec, today);
      } catch (err) {
        logger.error({ err: errorInfo(err), householdId, recurringId: rec.id }, "recurring: falha ao gerar ocorrências");
      }
    }

    const due = await prisma.scheduledPayment.findMany({
      where: { householdId, status: "PENDING", transactionId: null, dueDate: { lte: isoToDate(today) }, recurring: { active: true, autoPost: true } },
      orderBy: { dueDate: "asc" },
      select: { id: true, description: true },
    });
    if (!due.length) continue;
    const ctx = systemContext(householdId, timezone);
    for (const sp of due) {
      try {
        const res = await autoPostOccurrence(ctx, sp.id);
        if (res.posted) summary.posted++;
      } catch (err) {
        summary.failed++;
        logger.warn({ err: errorInfo(err), householdId, scheduledPaymentId: sp.id }, "recurring: falha no lançamento automático");
        await reportAutoPostFailure(householdId, sp.id, sp.description, err).catch((e) =>
          logger.error({ err: errorInfo(e), householdId }, "recurring: falha ao registrar pendência"),
        );
      }
    }
  }
  return summary;
}
