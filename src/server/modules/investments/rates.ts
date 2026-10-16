import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { env } from "../../env";
import { logger } from "../../logger";
import { addDays, dateToISO, isoToDate, type ISODate } from "@/lib/dates";
import type { YieldIndexValue } from "./yield-calc";

/**
 * Taxas do Banco Central (SGS, dado público e sem credencial): CDI (série 12) e Selic (11) ao dia
 * útil, IPCA (433) ao mês. Nada da família é enviado: só o código da série e o período.
 * Falha de rede não interrompe o resto: a apuração usa as taxas já guardadas e tenta de novo depois.
 */

export const SGS_SERIES: Record<Exclude<YieldIndexValue, "PREFIXED">, number> = { CDI: 12, SELIC: 11, IPCA: 433 };

const sgsRowSchema = z.object({ data: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/), valor: z.string().regex(/^-?\d+(\.\d+)?$/) });
const sgsSchema = z.array(sgsRowSchema).max(20_000);

const br = (iso: ISODate) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const fromBr = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}` as ISODate;

export class RatesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatesUnavailableError";
  }
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Busca e guarda as taxas do período (em blocos de até 5 anos). Retorna quantas datas novas. */
export async function refreshIndexRates(index: Exclude<YieldIndexValue, "PREFIXED">, from: ISODate, to: ISODate, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<number> {
  if (from > to) return 0;
  const base = env().BCB_SGS_URL.replace(/\/$/, "");
  let inserted = 0;
  let start = from;
  while (start <= to) {
    const end = [addDays(start, 365 * 5), to].sort()[0]!;
    const url = `${base}.${SGS_SERIES[index]}/dados?formato=json&dataInicial=${br(start)}&dataFinal=${br(end)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let rows: z.infer<typeof sgsSchema>;
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      // 404 = nenhum dado no período (ex.: fim de semana): não é erro.
      if (res.status === 404) rows = [];
      else if (!res.ok) throw new RatesUnavailableError(`Banco Central respondeu ${res.status}.`);
      else rows = sgsSchema.parse(await res.json());
    } catch (err) {
      if (err instanceof RatesUnavailableError) throw err;
      throw new RatesUnavailableError(err instanceof z.ZodError ? "Resposta inesperada do Banco Central." : "Banco Central indisponível.");
    } finally {
      clearTimeout(timer);
    }
    if (rows.length) {
      const res = await prisma.indexRate.createMany({
        data: rows.map((r) => ({ index, date: isoToDate(fromBr(r.data)), ratePct: new Prisma.Decimal(r.valor) })),
        skipDuplicates: true,
      });
      inserted += res.count;
    }
    start = addDays(end, 1);
  }
  if (inserted) logger.info({ index, from, to, inserted }, "investimentos: taxas do BCB atualizadas");
  return inserted;
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
