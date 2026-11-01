import { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { isoToDate, monthRange } from "@/lib/dates";
import { enqueueOutboundMessage } from "../../whatsapp/outbound";
import { claimAlertMark } from "../notifications/marks";
import { notify } from "../notifications/service";
import { buildMonthlyReport, familyScopeContext, reportSummaryText } from "./service";

/**
 * Reenvio do resumo mensal programado com os valores corrigidos (ex.: outubro/2026, quando compras
 * parceladas no cartão entravam com o valor inteiro no regime de competência).
 *
 * Para as famílias com o resumo automático daquele mês: o relatório guardado é recalculado no
 * mesmo registro (o histórico continua com um relatório só, agora certo) e, se havia compra
 * parcelada que mudava o mês, o resumo novo vai ao grupo do WhatsApp e ao app, com uma linha
 * explicando o reenvio. Família sem diferença não recebe nada. Uma vez por família, mesmo rodando de novo.
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
  /** Foi para a fila do WhatsApp (sem WhatsApp conectado, fica só no app). */
  whatsapp?: boolean;
}

/**
 * Diferença que a regra antiga causava no mês: compras parceladas no cartão contavam o valor
 * inteiro no mês da compra (e nada nos meses seguintes); a regra nova conta uma parcela por mês.
 * Calculada direto dos lançamentos, sem depender do relatório guardado (que pode já ter sido
 * recalculado).
 */
async function installmentRuleChanged(householdId: string, month: string): Promise<boolean> {
  const start = isoToDate(`${month}-01`);
  const end = isoToDate(monthRange(month).end);
  const [row] = await prisma.$queryRaw<Array<{ whole: bigint | null; parcels: bigint | null }>>`
    WITH split AS (
      SELECT t.id, t."amountCents", t."competenceDate", t."installmentOffset" FROM "Transaction" t
      WHERE t."householdId" = ${householdId} AND t.type = 'EXPENSE' AND t.status = 'CONFIRMED' AND t."deletedAt" IS NULL
        AND t."excludedFromReports" = false AND t."creditCardId" IS NOT NULL AND t."installmentCount" > 1
    )
    SELECT
      (SELECT SUM("amountCents") FROM split WHERE "competenceDate" BETWEEN ${start} AND ${end}) AS whole,
      (SELECT SUM(i."amountCents") FROM "Installment" i JOIN split ON split.id = i."transactionId"
        WHERE (split."competenceDate" + (i.number - 1 - split."installmentOffset") * INTERVAL '1 month')::date BETWEEN ${start} AND ${end}) AS parcels`;
  return Number(row?.whole ?? 0) !== Number(row?.parcels ?? 0);
}

/** Família em que todos desligaram os avisos do sistema: não recebe no WhatsApp (mesma regra dos avisos). */
async function optedOutOfWhatsApp(householdId: string): Promise<boolean> {
  const members = await prisma.householdMember.findMany({ where: { householdId, isActive: true, userId: { not: null } }, select: { id: true } });
  if (!members.length) return false;
  const prefs = await prisma.notificationPreference.findMany({ where: { memberId: { in: members.map((m) => m.id) }, type: "SYSTEM" } });
  return members.every((m) => prefs.find((p) => p.memberId === m.id)?.frequency === "OFF");
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
    // Marca da 2ª versão (agora também no WhatsApp); a notificação no app tem a mesma chave de antes e não repete.
    const key = `report-correction:${plan.month}`;
    const mark = `${key}:whatsapp`;
    if (!(await claimAlertMark(report.householdId, mark))) {
      results.push({ householdId: report.householdId, status: "already_done" });
      continue;
    }
    try {
      const ctx = familyScopeContext(report.householdId, report.household.timezone);
      const fresh = await buildMonthlyReport(ctx, plan.month, { scope: "FAMILY", now });
      await prisma.report.update({ where: { id: report.id }, data: { data: JSON.parse(JSON.stringify(fresh)) as Prisma.InputJsonValue } });
      if (!(await installmentRuleChanged(report.householdId, plan.month))) {
        results.push({ householdId: report.householdId, status: "unchanged" });
        continue;
      }
      const text = `${plan.note}\n\n${reportSummaryText(fresh)}`;
      const s = report.schedule!;
      const whatsapp = !(await optedOutOfWhatsApp(report.householdId));
      if (s.notifyInApp) {
        await notify({
          householdId: report.householdId,
          type: "MONTHLY_REPORT",
          title: "Resumo de outubro corrigido",
          body: text,
          data: { reportId: report.id, periodStart: fresh.period.start, periodEnd: fresh.period.end, ...(whatsapp ? { inAppOnly: true } : {}) },
          dedupeKey: key,
        });
      }
      // Reenvio pedido pelo administrador: vai ao grupo autorizado da família mesmo quando o resumo
      // mensal automático é só no app (o padrão).
      const queued = whatsapp ? await enqueueOutboundMessage({ householdId: report.householdId, text, kind: "report", dedupeKey: mark }) : { queued: false };
      results.push({ householdId: report.householdId, status: "resent", whatsapp: queued.queued });
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: report.householdId, month: plan.month }, "reports: falha no reenvio do resumo corrigido");
      // Libera a marca para tentar de novo na próxima rodada.
      await prisma.alertMark.deleteMany({ where: { householdId: report.householdId, key: mark } });
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
