import type { ReportSchedule } from "@prisma/client";
import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { isoToDate } from "@/lib/dates";
import { notify } from "../notifications/service";
import { enqueueOutboundMessage } from "../../whatsapp/outbound";
import { familyScopeContext, generateReport, reportSummaryText } from "./service";
import { latestOccurrence, nextOccurrence, reportPeriodForRun, type ScheduleConfig } from "./schedule";
import type { ReportData } from "./types";

export interface ScheduledReportResult {
  scheduleId: string;
  householdId: string;
  type: "WEEKLY" | "MONTHLY";
  status: "scheduled" | "not_due" | "generated" | "already_generated" | "skipped_concurrent" | "failed";
  reportId?: string;
  periodStart?: string;
  nextRunAt?: string;
}

function configOf(s: ReportSchedule): ScheduleConfig {
  return { type: s.type === "WEEKLY" ? "WEEKLY" : "MONTHLY", dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, hour: s.hour };
}

async function processSchedule(s: ReportSchedule & { household: { timezone: string } }, now: Date): Promise<ScheduledReportResult> {
  const type = s.type === "WEEKLY" ? "WEEKLY" : "MONTHLY";
  const tz = s.household.timezone;
  const cfg = configOf(s);
  const base: ScheduledReportResult = { scheduleId: s.id, householdId: s.householdId, type, status: "not_due" };

  if (!s.nextRunAt) {
    const next = nextOccurrence(cfg, tz, now);
    await prisma.reportSchedule.updateMany({ where: { id: s.id, nextRunAt: null }, data: { nextRunAt: next } });
    return { ...base, status: "scheduled", nextRunAt: next.toISOString() };
  }
  if (s.nextRunAt.getTime() > now.getTime()) return { ...base, nextRunAt: s.nextRunAt.toISOString() };

  // Execução devida: gera o relatório do período da ocorrência mais recente (recupera atrasos sem duplicar).
  const occurrence = latestOccurrence(cfg, tz, now);
  const next = nextOccurrence(cfg, tz, now);
  const claimed = await prisma.reportSchedule.updateMany({ where: { id: s.id, nextRunAt: s.nextRunAt }, data: { nextRunAt: next, lastRunAt: now } });
  if (!claimed.count) return { ...base, status: "skipped_concurrent" };

  const period = reportPeriodForRun(type, occurrence, tz);
  try {
    let report = await prisma.report.findFirst({
      where: { householdId: s.householdId, type, periodStart: isoToDate(period.start), generatedById: null, scheduleId: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    const alreadyGenerated = Boolean(report);
    let data: ReportData;
    if (report) {
      data = report.data as unknown as ReportData;
    } else {
      const ctx = familyScopeContext(s.householdId, tz);
      const view = await generateReport(ctx, type === "WEEKLY" ? { type, periodStart: period.start, scope: "FAMILY" } : { type, month: period.start.slice(0, 7), scope: "FAMILY" }, { scheduleId: s.id, now });
      report = await prisma.report.findUniqueOrThrow({ where: { id: view.id } });
      data = view.data;
    }

    const summary = reportSummaryText(data);
    const dedupe = `report:${type}:${period.start}`;
    if (s.notifyInApp) {
      await notify({
        householdId: s.householdId,
        type: type === "WEEKLY" ? "WEEKLY_REPORT" : "MONTHLY_REPORT",
        title: type === "WEEKLY" ? "Relatório semanal disponível" : "Relatório mensal disponível",
        body: summary,
        data: { reportId: report.id, periodStart: period.start, periodEnd: period.end },
        dedupeKey: dedupe,
      });
    }
    if (s.sendWhatsApp) {
      await enqueueOutboundMessage({ householdId: s.householdId, text: summary, kind: "report", dedupeKey: `${dedupe}:whatsapp` });
    }
    logger.info({ householdId: s.householdId, scheduleId: s.id, type, periodStart: period.start, alreadyGenerated }, "reports: relatório programado processado");
    return { ...base, status: alreadyGenerated ? "already_generated" : "generated", reportId: report.id, periodStart: period.start, nextRunAt: next.toISOString() };
  } catch (err) {
    // Devolve o agendamento para nova tentativa na próxima rodada.
    await prisma.reportSchedule.updateMany({ where: { id: s.id, nextRunAt: next }, data: { nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt } });
    throw err;
  }
}

/** Processa todos os agendamentos e devolve o resultado de cada um (usado em testes e diagnósticos). */
export async function processScheduledReports(now: Date = new Date()): Promise<ScheduledReportResult[]> {
  const schedules = await prisma.reportSchedule.findMany({
    where: { enabled: true, type: { in: ["WEEKLY", "MONTHLY"] } },
    include: { household: { select: { timezone: true } } },
    orderBy: { createdAt: "asc" },
  });
  const results: ScheduledReportResult[] = [];
  for (const s of schedules) {
    try {
      results.push(await processSchedule(s, now));
    } catch (err) {
      logger.error({ err: errorInfo(err), scheduleId: s.id, householdId: s.householdId }, "reports: falha ao gerar relatório programado");
      results.push({ scheduleId: s.id, householdId: s.householdId, type: s.type === "WEEKLY" ? "WEEKLY" : "MONTHLY", status: "failed" });
    }
  }
  return results;
}

/** Gera relatórios programados (semanal/mensal). Idempotente por período. */
export async function runScheduledReports(now: Date = new Date()): Promise<void> {
  await processScheduledReports(now);
}
