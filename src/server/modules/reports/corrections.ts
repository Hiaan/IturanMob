import { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { isoToDate } from "@/lib/dates";
import { enqueueOutboundMessage } from "../../whatsapp/outbound";
import { claimAlertMark } from "../notifications/marks";
import { notify } from "../notifications/service";
import { buildMonthlyReport, familyScopeContext, reportSummaryText } from "./service";
import type { ReportData } from "./types";

/**
 * Reenvio do resumo mensal programado com os valores corrigidos (ex.: outubro/2026, quando compras
 * parceladas no cartão entravam com o valor inteiro no regime de competência).
 *
 * Só para quem recebeu o resumo automático daquele mês: o relatório guardado é recalculado no
 * mesmo registro (o histórico continua com um relatório só, agora certo) e, se os totais mudaram,
 * o resumo novo vai pelos mesmos canais do agendamento, com uma linha explicando o reenvio.
 * Família sem diferença não recebe nada. Uma vez por família (marca), mesmo rodando de novo.
 */

export interface CorrectionPlan {
  month: string;
  /** Depois desta data a tarefa não faz mais nada (resumo antigo demais para reenviar). */
  until: string;
  note: string;
}

export const MONTHLY_CORRECTIONS: CorrectionPlan[] = [
  {
    month: "2026-10",
    until: "2026-11-20",
    note: "⚠️ *Resumo de outubro corrigido*\nPor um erro interno, compras parceladas no cartão entraram com o valor inteiro no resumo que enviamos. Seguem os valores corrigidos, contando só a parcela do mês:",
  },
];

export interface CorrectionResult {
  householdId: string;
  status: "resent" | "unchanged" | "already_done" | "failed";
}

export async function resendCorrectedMonthlyReport(plan: CorrectionPlan, now: Date = new Date()): Promise<CorrectionResult[]> {
  if (now.toISOString().slice(0, 10) > plan.until) return [];
  const reports = await prisma.report.findMany({
    where: { type: "MONTHLY", periodStart: isoToDate(`${plan.month}-01`), generatedById: null, scheduleId: { not: null }, schedule: { enabled: true } },
    include: { schedule: true, household: { select: { timezone: true } } },
    orderBy: { createdAt: "asc" },
  });
  const results: CorrectionResult[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    if (seen.has(report.householdId)) continue; // um resumo por família
    seen.add(report.householdId);
    const key = `report-correction:${plan.month}`;
    if (!(await claimAlertMark(report.householdId, key))) {
      results.push({ householdId: report.householdId, status: "already_done" });
      continue;
    }
    try {
      const old = report.data as unknown as ReportData;
      const ctx = familyScopeContext(report.householdId, report.household.timezone);
      const fresh = await buildMonthlyReport(ctx, plan.month, { scope: "FAMILY", now });
      await prisma.report.update({ where: { id: report.id }, data: { data: JSON.parse(JSON.stringify(fresh)) as Prisma.InputJsonValue } });
      const changed = old.totals.expenseCents !== fresh.totals.expenseCents || old.totals.incomeCents !== fresh.totals.incomeCents;
      if (!changed) {
        results.push({ householdId: report.householdId, status: "unchanged" });
        continue;
      }
      const text = `${plan.note}\n\n${reportSummaryText(fresh)}`;
      const s = report.schedule!;
      if (s.notifyInApp) {
        await notify({
          householdId: report.householdId,
          type: "MONTHLY_REPORT",
          title: "Resumo de outubro corrigido",
          body: text,
          data: { reportId: report.id, periodStart: fresh.period.start, periodEnd: fresh.period.end, ...(s.sendWhatsApp ? { inAppOnly: true } : {}) },
          dedupeKey: key,
        });
      }
      if (s.sendWhatsApp) await enqueueOutboundMessage({ householdId: report.householdId, text, kind: "report", dedupeKey: `${key}:whatsapp` });
      results.push({ householdId: report.householdId, status: "resent" });
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: report.householdId, month: plan.month }, "reports: falha no reenvio do resumo corrigido");
      // Libera a marca para tentar de novo na próxima rodada.
      await prisma.alertMark.deleteMany({ where: { householdId: report.householdId, key } });
      results.push({ householdId: report.householdId, status: "failed" });
    }
  }
  if (results.some((r) => r.status !== "already_done")) {
    logger.info({ month: plan.month, resent: results.filter((r) => r.status === "resent").length, unchanged: results.filter((r) => r.status === "unchanged").length }, "reports: reenvio do resumo corrigido");
  }
  return results;
}

export async function runReportCorrections(now: Date = new Date()): Promise<void> {
  for (const plan of MONTHLY_CORRECTIONS) await resendCorrectedMonthlyReport(plan, now);
}
