import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { publishEvent } from "../../events";
import { addDays, formatDateBR, hourInTimezone, timeInTimezone, todayISO, weekday, type ISODate } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { notify } from "../notifications/service";
import { claimAlertMark } from "../notifications/marks";
import { getSettings } from "../households/service";
import { familyScopeContext } from "../reports/service";
import { listBills } from "../bills/service";
import { expensesByCategory } from "../analytics/service";
import { appointmentLine, appointmentsOfDay, sharedAppointmentsWhere } from "./service";

/**
 * Lembretes de compromissos e o resumo do dia toda manhã. Compromissos PRIVADOS só vão para a
 * pessoa dona, no app (nunca para o grupo). O resumo usa o recorte da família (contas e cartões
 * privados fora) e só fatos cadastrados: compromissos, contas do dia/vencidas e gastos de ontem.
 */

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
/** O resumo sai na hora escolhida, ou até 3 horas depois se o servidor estava fora. */
const MORNING_WINDOW_HOURS = 3;

export async function runAppointmentReminders(now: Date = new Date()): Promise<{ reminders: number }> {
  let reminders = 0;
  const due = await prisma.appointment.findMany({
    where: { deletedAt: null, allDay: false, reminderMinutes: { not: null }, startsAt: { gt: now, lte: new Date(now.getTime() + 7 * 86_400_000) } },
    include: { household: { select: { timezone: true } } },
  });
  for (const a of due) {
    if (a.startsAt.getTime() - a.reminderMinutes! * 60_000 > now.getTime()) continue;
    const key = `appt:${a.id}:${a.startsAt.toISOString()}`;
    try {
      if (!(await claimAlertMark(a.householdId, key))) continue;
      const tz = a.household.timezone;
      const isPrivate = a.visibility === "PRIVATE";
      if (isPrivate && !a.ownerMemberId) continue;
      const minutes = Math.max(1, Math.round((a.startsAt.getTime() - now.getTime()) / 60_000));
      const when = minutes < 60 ? `em ${minutes} min` : todayISO(tz, a.startsAt) === todayISO(tz, now) ? `hoje às ${timeInTimezone(a.startsAt, tz)}` : `${formatDateBR(todayISO(tz, a.startsAt))} às ${timeInTimezone(a.startsAt, tz)}`;
      const res = await notify({
        householdId: a.householdId,
        type: "APPOINTMENT_REMINDER",
        title: `Compromisso ${when}: ${a.title}`,
        body: `${a.title} — ${when}${a.location ? ` (${a.location})` : ""}.`,
        dedupeKey: key,
        recipientMemberIds: isPrivate ? [a.ownerMemberId!] : undefined,
        data: { appointmentId: a.id, url: "/agenda", ...(isPrivate ? { inAppOnly: true } : {}) },
      });
      if (res.created) {
        reminders++;
        await publishEvent(a.householdId, "notification.created");
      }
    } catch (err) {
      logger.error({ err: errorInfo(err), appointmentId: a.id }, "agenda: falha no lembrete");
    }
  }
  return { reminders };
}

export interface MorningSummary {
  title: string;
  body: string;
  hasContent: boolean;
}

/** Texto do resumo do dia no recorte da família (função usada também nos testes). */
export async function buildMorningSummary(householdId: string, timezone: string, today: ISODate): Promise<MorningSummary> {
  const ctx = familyScopeContext(householdId, timezone);
  const [appointments, bills, yesterday] = await Promise.all([
    appointmentsOfDay(householdId, timezone, today, sharedAppointmentsWhere(householdId)),
    listBills(ctx, { start: today, end: today, includeOverdue: true, type: "EXPENSE" }),
    expensesByCategory(ctx, { period: { start: addDays(today, -1), end: addDays(today, -1) }, regime: "CASH" }),
  ]);
  const lines: string[] = [];
  let content = false;
  if (appointments.length) {
    content = true;
    lines.push(`📅 *Agenda de hoje*`);
    for (const a of appointments.slice(0, 10)) lines.push(`• ${appointmentLine(a)}`);
    if (appointments.length > 10) lines.push(`• e mais ${appointments.length - 10}`);
  } else {
    lines.push("📅 Nenhum compromisso na agenda hoje.");
  }
  const dueToday = bills.items.filter((b) => b.status === "PENDING" && b.dueDate === today);
  const overdue = bills.items.filter((b) => b.status === "OVERDUE");
  if (dueToday.length) {
    content = true;
    lines.push(`\n💸 *Vence hoje*`);
    for (const b of dueToday.slice(0, 8)) lines.push(`• ${b.description}: ${formatBRL(b.amountCents)}${b.isEstimate ? " (estimado)" : ""}`);
  }
  if (overdue.length) {
    content = true;
    const total = overdue.reduce((s, b) => s + b.amountCents, 0);
    lines.push(`\n⚠️ ${overdue.length} conta(s) vencida(s) sem pagamento: ${formatBRL(total)}.`);
  }
  if (yesterday.totalCents > 0) {
    content = true;
    const top = yesterday.items[0];
    lines.push(`\n🧾 Ontem: ${formatBRL(yesterday.totalCents)} em gastos${top ? ` (mais em ${top.name}: ${formatBRL(top.amountCents)})` : ""}.`);
  }
  const [, m, d] = today.split("-");
  return { title: `Bom dia! Resumo de ${WEEKDAYS[weekday(today)]}, ${d}/${m}`, body: lines.join("\n"), hasContent: content };
}

export async function runMorningSummaries(now: Date = new Date(), opts: { householdId?: string } = {}): Promise<{ households: number; sent: number }> {
  const summary = { households: 0, sent: 0 };
  const households = await prisma.household.findMany({ where: opts.householdId ? { id: opts.householdId } : {}, select: { id: true, timezone: true } });
  for (const h of households) {
    try {
      const settings = await getSettings(h.id);
      if (!settings.morningSummaryEnabled) continue;
      const hour = hourInTimezone(h.timezone, now);
      if (hour < settings.morningSummaryHour || hour >= settings.morningSummaryHour + MORNING_WINDOW_HOURS) continue;
      summary.households++;
      const today = todayISO(h.timezone, now);
      const key = `morning:${today}`;
      if (!(await claimAlertMark(h.id, key))) continue;
      const text = await buildMorningSummary(h.id, h.timezone, today);
      if (text.hasContent) {
        const res = await notify({ householdId: h.id, type: "MORNING_SUMMARY", title: text.title, body: text.body, dedupeKey: key, data: { url: "/agenda", date: today } });
        if (res.created) summary.sent++;
      }
      // Compromissos privados de cada pessoa: só para ela, no app.
      const privates = await prisma.appointment.groupBy({
        by: ["ownerMemberId"],
        where: { householdId: h.id, deletedAt: null, visibility: "PRIVATE", ownerMemberId: { not: null }, startsAt: { gte: new Date(now.getTime() - 86_400_000), lte: new Date(now.getTime() + 2 * 86_400_000) } },
      });
      for (const p of privates) {
        const mine = await appointmentsOfDay(h.id, h.timezone, today, { householdId: h.id, deletedAt: null, visibility: "PRIVATE", ownerMemberId: p.ownerMemberId! });
        if (!mine.length) continue;
        await notify({
          householdId: h.id,
          type: "MORNING_SUMMARY",
          title: "Seus compromissos privados hoje",
          body: mine.map((a) => `• ${appointmentLine(a)}`).join("\n"),
          dedupeKey: `${key}:private:${p.ownerMemberId}`,
          recipientMemberIds: [p.ownerMemberId!],
          data: { url: "/agenda", date: today, inAppOnly: true },
        });
      }
      await publishEvent(h.id, "notification.created");
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: h.id }, "agenda: falha no resumo da manhã");
    }
  }
  return summary;
}
