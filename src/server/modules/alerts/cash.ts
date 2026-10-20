import { prisma } from "../../db";
import { errorInfo, logger } from "../../logger";
import { publishEvent } from "../../events";
import { formatDateBR, startOfWeek, todayISO, type ISODate } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { cashflowProjection, type CashflowEvent } from "../analytics/service";
import { familyScopeContext } from "../reports/service";
import { notify } from "../notifications/service";
import { claimAlertMark } from "../notifications/marks";

/**
 * "Vai faltar dinheiro": pela projeção de caixa (saldo das contas + contas a pagar e receber
 * cadastradas + faturas em aberto), o saldo fica negativo nos próximos dias. Usa só o que está
 * cadastrado — nada é estimado além disso — e no recorte da família (contas privadas fora), porque
 * o aviso vai para o grupo. No máximo um aviso por semana enquanto a falta continuar.
 */

export const CASH_HORIZON_DAYS = 30;

export interface CashShortfall {
  /** Primeiro dia com saldo negativo. */
  date: ISODate;
  balanceCents: number;
  lowest: { date: ISODate; balanceCents: number };
  /** Maiores saídas até o primeiro dia negativo. */
  drivers: CashflowEvent[];
}

/** Primeiro ponto negativo da projeção (função pura). */
export function findShortfall(projection: { startDate: ISODate; startBalanceCents: number; points: Array<{ date: ISODate; balanceCents: number }>; events: CashflowEvent[]; lowestPoint: { date: ISODate; balanceCents: number } }): CashShortfall | null {
  const first = projection.points.find((p) => p.balanceCents < 0);
  if (!first) return null;
  const drivers = projection.events
    .filter((e) => e.amountCents < 0 && e.date <= first.date)
    .sort((a, b) => a.amountCents - b.amountCents)
    .slice(0, 3);
  return { date: first.date, balanceCents: first.balanceCents, lowest: projection.lowestPoint, drivers };
}

export function shortfallText(s: CashShortfall, today: ISODate): { title: string; body: string } {
  const when = s.date <= today ? "já hoje" : `em ${formatDateBR(s.date)}`;
  const lines = [`Pela projeção, o saldo das contas fica negativo ${when} (${formatBRL(s.balanceCents)}).`];
  if (s.lowest.balanceCents < s.balanceCents) lines.push(`Pior momento: ${formatBRL(s.lowest.balanceCents)} em ${formatDateBR(s.lowest.date)}.`);
  if (s.drivers.length) lines.push(`Maiores saídas até lá: ${s.drivers.map((d) => `${d.description} ${formatBRL(-d.amountCents)}`).join("; ")}.`);
  lines.push("Conta só o que está cadastrado (saldos, contas a pagar e a receber, faturas).");
  return { title: "Vai faltar dinheiro", body: lines.join(" ") };
}

export async function runCashShortfallAlerts(now: Date = new Date(), opts: { householdId?: string } = {}): Promise<{ households: number; alerts: number }> {
  const summary = { households: 0, alerts: 0 };
  // Só famílias com conta corrente/carteira nos totais: sem saldo cadastrado não há projeção.
  const households = await prisma.household.findMany({
    where: { ...(opts.householdId ? { id: opts.householdId } : {}), accounts: { some: { archivedAt: null, includeInTotals: true, type: { not: "INVESTMENT" } } } },
    select: { id: true, timezone: true },
  });
  for (const h of households) {
    summary.households++;
    try {
      const today = todayISO(h.timezone, now);
      const projection = await cashflowProjection(familyScopeContext(h.id, h.timezone), CASH_HORIZON_DAYS);
      const shortfall = findShortfall(projection);
      if (!shortfall) continue;
      const key = `cash:${startOfWeek(today)}`;
      if (!(await claimAlertMark(h.id, key))) continue;
      const text = shortfallText(shortfall, today);
      const res = await notify({
        householdId: h.id,
        type: "CASH_SHORTFALL",
        title: text.title,
        body: text.body,
        dedupeKey: key,
        data: { date: shortfall.date, balanceCents: shortfall.balanceCents, lowestCents: shortfall.lowest.balanceCents, url: "/contas-a-pagar" },
      });
      if (res.created) {
        summary.alerts++;
        await publishEvent(h.id, "notification.created");
      }
    } catch (err) {
      logger.error({ err: errorInfo(err), householdId: h.id }, "caixa: falha no aviso de falta de dinheiro");
    }
  }
  return summary;
}
