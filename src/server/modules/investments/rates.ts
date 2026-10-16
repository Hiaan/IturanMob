import { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { fetchSgsSeries, type FetchLike } from "../bcb/sgs";
import { logger } from "../../logger";
import { addDays, dateToISO, isoToDate, type ISODate } from "@/lib/dates";
import type { YieldIndexValue } from "./yield-calc";

/**
 * Taxas do Banco Central (SGS, dado público e sem credencial): CDI (série 12) e Selic (11) ao dia
 * útil, IPCA (433) ao mês. Nada da família é enviado: só o código da série e o período.
 * Falha de rede não interrompe o resto: a apuração usa as taxas já guardadas e tenta de novo depois.
 */

export const SGS_SERIES: Record<Exclude<YieldIndexValue, "PREFIXED">, number> = { CDI: 12, SELIC: 11, IPCA: 433 };

export { BcbUnavailableError as RatesUnavailableError } from "../bcb/sgs";

/** Busca e guarda as taxas do período. Retorna quantas datas novas. */
export async function refreshIndexRates(index: Exclude<YieldIndexValue, "PREFIXED">, from: ISODate, to: ISODate, fetchImpl?: FetchLike): Promise<number> {
  if (from > to) return 0;
  const rows = await fetchSgsSeries(SGS_SERIES[index], from, to, fetchImpl);
  if (!rows.length) return 0;
  const res = await prisma.indexRate.createMany({
    data: rows.map((r) => ({ index, date: isoToDate(r.date), ratePct: new Prisma.Decimal(r.value) })),
    skipDuplicates: true,
  });
  if (res.count) logger.info({ index, from, to, inserted: res.count }, "investimentos: taxas do BCB atualizadas");
  return res.count;
}

/** Período que falta guardar para cobrir [from, to]. */
export async function missingRange(index: Exclude<YieldIndexValue, "PREFIXED">, from: ISODate, to: ISODate): Promise<{ from: ISODate; to: ISODate } | null> {
  const agg = await prisma.indexRate.aggregate({ where: { index }, _min: { date: true }, _max: { date: true } });
  if (!agg._min.date || !agg._max.date) return { from, to };
  const first = dateToISO(agg._min.date);
  const last = dateToISO(agg._max.date);
  if (from < first) return { from, to };
  const next = addDays(last, 1);
  return next <= to ? { from: next, to } : null;
}

export async function loadRates(index: YieldIndexValue, from: ISODate, to: ISODate) {
  const [cdi, own] = await Promise.all([
    prisma.indexRate.findMany({ where: { index: "CDI", date: { gte: isoToDate(from), lte: isoToDate(to) } }, orderBy: { date: "asc" }, select: { date: true, ratePct: true } }),
    index === "SELIC" || index === "IPCA"
      ? prisma.indexRate.findMany({
          where: { index, date: { gte: isoToDate(index === "IPCA" ? `${from.slice(0, 7)}-01` : from), lte: isoToDate(to) } },
          orderBy: { date: "asc" },
          select: { date: true, ratePct: true },
        })
      : Promise.resolve([]),
  ]);
  const businessDays = cdi.map((r) => dateToISO(r.date));
  const daily = new Map<ISODate, number>();
  const monthlyIpca = new Map<string, number>();
  if (index === "CDI") for (const r of cdi) daily.set(dateToISO(r.date), Number(r.ratePct));
  if (index === "SELIC") for (const r of own) daily.set(dateToISO(r.date), Number(r.ratePct));
  if (index === "IPCA") for (const r of own) monthlyIpca.set(dateToISO(r.date).slice(0, 7), Number(r.ratePct));
  return { businessDays, daily, monthlyIpca, lastBusinessDay: businessDays[businessDays.length - 1] ?? null };
}
