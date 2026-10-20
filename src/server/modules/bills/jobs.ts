import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { addDays, diffDays, dateToISO, formatDateBR, formatDayMonthBR, formatMonthBR, isoToDate, todayISO } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { statementTotals } from "../cards/statements";
import { notify } from "../notifications/service";

/** Antecedência padrão do lembrete quando a conta não vem de uma recorrência. */
export const DEFAULT_REMINDER_DAYS = 3;
/** Conta vencida e não paga: lembra no dia seguinte e a cada 3 dias, até 15 dias depois do vencimento. */
export const OVERDUE_REPEAT_DAYS = 3;
export const OVERDUE_MAX_DAYS = 15;
/** Fatura vencida sem pagamento: avisa uma vez, se venceu há até 15 dias. */
export const STATEMENT_OVERDUE_MAX_DAYS = 15;

export interface BillReminderSummary {
  households: number;
  billReminders: number;
  statementNotices: number;
  overdueReminders: number;
  statementDueReminders: number;
}

/** "vence hoje", "vence amanhã (16/10)", "vence em 3 dias (18/10)". */
export function dueText(days: number, dueISO: string): string {
  if (days <= 0) return "vence hoje";
  if (days === 1) return `vence amanhã (${formatDateBR(dueISO)})`;
  return `vence em ${days} dias (${formatDateBR(dueISO)})`;
}

interface Privacy {
  recipientMemberIds?: string[];
  inAppOnly: boolean;
}

/** Itens de contas/cartões privados vão somente ao titular e nunca ao grupo do WhatsApp. */
function privacyFor(owner: { visibility: string; memberId: string | null } | null): Privacy {
  if (!owner || owner.visibility !== "PRIVATE") return { inAppOnly: false };
  return { recipientMemberIds: owner.memberId ? [owner.memberId] : [], inAppOnly: true };
}

async function remindBills(householdId: string, today: string): Promise<number> {
  const upcoming = await prisma.scheduledPayment.findMany({
    where: { householdId, type: "EXPENSE", status: "PENDING", transactionId: null, dueDate: { gte: isoToDate(today), lte: isoToDate(addDays(today, 30)) } },
    include: {
      recurring: { select: { reminderDaysBefore: true, autoPost: true } },
      account: { select: { visibility: true, ownerMemberId: true } },
      creditCard: { select: { visibility: true, holderMemberId: true } },
    },
    orderBy: { dueDate: "asc" },
  });
  let count = 0;
  for (const sp of upcoming) {
    const due = dateToISO(sp.dueDate);
    const days = diffDays(due, today);
    if (days > (sp.recurring?.reminderDaysBefore ?? DEFAULT_REMINDER_DAYS)) continue;
    const privacy = sp.creditCard
      ? privacyFor({ visibility: sp.creditCard.visibility, memberId: sp.creditCard.holderMemberId })
      : privacyFor(sp.account ? { visibility: sp.account.visibility, memberId: sp.account.ownerMemberId } : null);
    if (privacy.recipientMemberIds && !privacy.recipientMemberIds.length) continue;
    const value = `${formatBRL(sp.amountCents)}${sp.isEstimate ? ", valor estimado" : ""}`;
    const auto = sp.recurring?.autoPost ? " O lançamento será feito automaticamente." : "";
    const res = await notify({
      householdId,
      type: "BILL_DUE",
      title: `Conta a vencer: ${sp.description}`,
      body: `${sp.description} ${dueText(days, due)}: ${value}.${auto}`,
      dedupeKey: `bill:${sp.id}:${due}`,
      recipientMemberIds: privacy.recipientMemberIds,
      data: {
        scheduledPaymentId: sp.id,
        dueDate: due,
        amountCents: sp.amountCents,
        isEstimate: sp.isEstimate,
        stage: days <= 0 ? "TODAY" : "SOON",
        url: "/contas-a-pagar",
        ...(privacy.inAppOnly ? { inAppOnly: true } : {}),
      },
    });
    if (res.created) count++;
  }
  return count;
}

/** "venceu ontem (10/11)", "venceu há 4 dias (10/11)". */
export function lateText(daysLate: number, dueISO: string): string {
  return daysLate <= 1 ? `venceu ontem (${formatDayMonthBR(dueISO)})` : `venceu há ${daysLate} dias (${formatDayMonthBR(dueISO)})`;
}

/**
 * Conta vencida e não marcada como paga: no dia seguinte ao vencimento e depois a cada 3 dias, até 15
 * dias (cada etapa uma vez). Para quando a conta é paga/conciliada (transactionId) e respeita o
 * "pagar depois" (reminderSnoozedUntil).
 */
async function remindOverdueBills(householdId: string, today: string): Promise<number> {
  const overdue = await prisma.scheduledPayment.findMany({
    where: {
      householdId,
      type: "EXPENSE",
      status: "PENDING",
      transactionId: null,
      dueDate: { lt: isoToDate(today), gte: isoToDate(addDays(today, -OVERDUE_MAX_DAYS)) },
      OR: [{ reminderSnoozedUntil: null }, { reminderSnoozedUntil: { lte: isoToDate(today) } }],
    },
    include: {
      account: { select: { visibility: true, ownerMemberId: true } },
      creditCard: { select: { visibility: true, holderMemberId: true } },
    },
    orderBy: { dueDate: "asc" },
  });
  let count = 0;
  for (const sp of overdue) {
    const due = dateToISO(sp.dueDate);
    const late = diffDays(today, due);
    const stage = Math.floor((late - 1) / OVERDUE_REPEAT_DAYS);
    const privacy = sp.creditCard
      ? privacyFor({ visibility: sp.creditCard.visibility, memberId: sp.creditCard.holderMemberId })
      : privacyFor(sp.account ? { visibility: sp.account.visibility, memberId: sp.account.ownerMemberId } : null);
    if (privacy.recipientMemberIds && !privacy.recipientMemberIds.length) continue;
    const value = `${formatBRL(sp.amountCents)}${sp.isEstimate ? ", valor estimado" : ""}`;
    const res = await notify({
      householdId,
      type: "BILL_OVERDUE",
      title: `Conta vencida: ${sp.description}`,
      body: `⚠️ ${sp.description} ${lateText(late, due)} e não foi marcada como paga (${value}). Já pagou? Marque como paga em Contas a pagar — ou escolha "pagar depois" para lembrar em ${OVERDUE_REPEAT_DAYS} dias.`,
      dedupeKey: `bill-overdue:${sp.id}:${due}:${stage}`,
      recipientMemberIds: privacy.recipientMemberIds,
      data: {
        scheduledPaymentId: sp.id,
        dueDate: due,
        amountCents: sp.amountCents,
        daysLate: late,
        stage: "OVERDUE",
        url: "/contas-a-pagar",
        ...(privacy.inAppOnly ? { inAppOnly: true } : {}),
      },
    });
    if (res.created) count++;
  }
  return count;
}

/**
 * Fatura com saldo em aberto: N dias antes do vencimento (por cartão; padrão 3), no dia e, se venceu
 * sem pagamento, uma vez (até 15 dias depois). Cada etapa uma vez por fatura.
 */
async function remindStatementsDue(householdId: string, today: string): Promise<number> {
  const cards = await prisma.creditCard.findMany({
    where: { householdId, archivedAt: null },
    select: { id: true, name: true, visibility: true, holderMemberId: true, dueReminderDays: true },
  });
  let count = 0;
  for (const card of cards) {
    const privacy = privacyFor({ visibility: card.visibility, memberId: card.holderMemberId });
    if (privacy.recipientMemberIds && !privacy.recipientMemberIds.length) continue;
    const totals = await statementTotals(prisma, householdId, { creditCardId: card.id });
    for (const st of totals) {
      if (st.remainingCents <= 0) continue;
      const days = diffDays(st.dueDate, today);
      // Antes do vencimento, só fatura já fechada (o total não muda mais).
      const stage =
        days > 0 && days <= card.dueReminderDays && st.closingDate <= today ? "SOON" : days === 0 ? "TODAY" : days < 0 && -days <= STATEMENT_OVERDUE_MAX_DAYS ? "OVERDUE" : null;
      if (!stage) continue;
      const what = `A fatura de ${formatMonthBR(st.referenceMonth)} do ${card.name}`;
      const open = `${formatBRL(st.remainingCents)} em aberto`;
      const res = await notify({
        householdId,
        type: "STATEMENT_DUE",
        title: stage === "OVERDUE" ? `Fatura vencida: ${card.name}` : `Fatura a vencer: ${card.name}`,
        body:
          stage === "SOON"
            ? `${what} ${days === 1 ? "vence amanhã" : `vence em ${days} dias`} (${formatDayMonthBR(st.dueDate)}): ${open}.`
            : stage === "TODAY"
              ? `${what} vence hoje: ${open}.`
              : `⚠️ ${what} ${-days === 1 ? "venceu ontem" : `venceu há ${-days} dias`} (${formatDayMonthBR(st.dueDate)}) e não foi paga: ${open}. Se já pagou, registre o pagamento da fatura.`,
        dedupeKey: `statement-due:${st.id}:${stage}`,
        recipientMemberIds: privacy.recipientMemberIds,
        data: {
          statementId: st.id,
          creditCardId: card.id,
          referenceMonth: st.referenceMonth,
          dueDate: st.dueDate,
          remainingCents: st.remainingCents,
          stage,
          url: "/cartoes",
          ...(privacy.inAppOnly ? { inAppOnly: true } : {}),
        },
      });
      if (res.created) count++;
    }
  }
  return count;
}

async function noticeStatements(householdId: string, today: string): Promise<number> {
  const cards = await prisma.creditCard.findMany({
    where: { householdId, archivedAt: null },
    select: { id: true, name: true, visibility: true, holderMemberId: true },
  });
  let count = 0;
  for (const card of cards) {
    const totals = await statementTotals(prisma, householdId, { creditCardId: card.id });
    for (const st of totals) {
      // Fatura fechada, ainda a vencer, com saldo em aberto (faturas antigas não geram aviso).
      if (st.closingDate > today || st.dueDate < today || st.remainingCents <= 0) continue;
      const privacy = privacyFor({ visibility: card.visibility, memberId: card.holderMemberId });
      if (privacy.recipientMemberIds && !privacy.recipientMemberIds.length) continue;
      const res = await notify({
        householdId,
        type: "STATEMENT_AVAILABLE",
        title: `Fatura fechada: ${card.name}`,
        body: `A fatura de ${formatMonthBR(st.referenceMonth)} do ${card.name} fechou em ${formatBRL(st.remainingCents)}, com vencimento em ${formatDateBR(st.dueDate)}.`,
        dedupeKey: `statement:${st.id}`,
        recipientMemberIds: privacy.recipientMemberIds,
        data: {
          statementId: st.id,
          creditCardId: card.id,
          referenceMonth: st.referenceMonth,
          dueDate: st.dueDate,
          remainingCents: st.remainingCents,
          ...(privacy.inAppOnly ? { inAppOnly: true } : {}),
        },
      });
      if (res.created) count++;
    }
  }
  return count;
}

/**
 * Lembretes de contas próximas do vencimento (antecedência da recorrência; padrão 3 dias), contas
 * vencidas não pagas, avisos de fatura fechada e de fatura perto de vencer/vencida. Idempotente:
 * cada conta/vencimento/etapa e cada fatura/etapa notificam uma única vez.
 */
export async function runBillReminderJobs(now: Date = new Date(), opts: { householdId?: string } = {}): Promise<BillReminderSummary> {
  const summary: BillReminderSummary = { households: 0, billReminders: 0, statementNotices: 0, overdueReminders: 0, statementDueReminders: 0 };
  const households = await prisma.household.findMany({
    where: {
      ...(opts.householdId ? { id: opts.householdId } : {}),
      OR: [{ scheduledPayments: { some: { status: "PENDING", type: "EXPENSE" } } }, { creditCards: { some: { archivedAt: null } } }],
    },
    select: { id: true, timezone: true },
  });
  for (const h of households) {
    summary.households++;
    const today = todayISO(h.timezone, now);
    try {
      summary.billReminders += await remindBills(h.id, today);
      summary.statementNotices += await noticeStatements(h.id, today);
      summary.overdueReminders += await remindOverdueBills(h.id, today);
      summary.statementDueReminders += await remindStatementsDue(h.id, today);
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: h.id }, "bills: falha nos lembretes");
    }
  }
  return summary;
}
