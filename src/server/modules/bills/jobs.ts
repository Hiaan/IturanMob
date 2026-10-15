import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { addDays, diffDays, dateToISO, formatDateBR, formatMonthBR, isoToDate, todayISO } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { statementTotals } from "../cards/statements";
import { notify } from "../notifications/service";

/** Antecedência padrão do lembrete quando a conta não vem de uma recorrência. */
export const DEFAULT_REMINDER_DAYS = 3;

export interface BillReminderSummary {
  households: number;
  billReminders: number;
  statementNotices: number;
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
      data: { scheduledPaymentId: sp.id, dueDate: due, amountCents: sp.amountCents, isEstimate: sp.isEstimate, ...(privacy.inAppOnly ? { inAppOnly: true } : {}) },
    });
    if (res.created) count++;
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
 * Lembretes de contas próximas do vencimento (antecedência da recorrência; padrão 3 dias) e avisos
 * de fatura fechada. Idempotente: cada conta/vencimento e cada fatura notificam uma única vez.
 */
export async function runBillReminderJobs(now: Date = new Date(), opts: { householdId?: string } = {}): Promise<BillReminderSummary> {
  const summary: BillReminderSummary = { households: 0, billReminders: 0, statementNotices: 0 };
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
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: h.id }, "bills: falha nos lembretes");
    }
  }
  return summary;
}
