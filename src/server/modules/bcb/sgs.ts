import { z } from "zod";
import { env } from "../../env";
import { addDays, type ISODate } from "@/lib/dates";

/**
 * API pública do Banco Central (SGS): séries de taxas e cotações, sem credencial. Só o código da
 * série e o período saem do servidor — nenhum dado da família.
 */

const rowSchema = z.object({ data: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/), valor: z.string().regex(/^-?\d+(\.\d+)?$/) });
const seriesSchema = z.array(rowSchema).max(20_000);

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class BcbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BcbUnavailableError";
  }
}

const br = (iso: ISODate) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const fromBr = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}` as ISODate;

/** Lê a série no período (em blocos de até 5 anos, limite da API para séries diárias). */
export async function fetchSgsSeries(code: number, from: ISODate, to: ISODate, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<Array<{ date: ISODate; value: string }>> {
  const base = env().BCB_SGS_URL.replace(/\/$/, "");
  const out: Array<{ date: ISODate; value: string }> = [];
  let start = from;
  while (start <= to) {
    const end = [addDays(start, 365 * 5), to].sort()[0]!;
    const url = `${base}.${code}/dados?formato=json&dataInicial=${br(start)}&dataFinal=${br(end)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      // 404 = nenhum dado no período (ex.: fim de semana): não é erro.
      if (res.status !== 404) {
        if (!res.ok) throw new BcbUnavailableError(`Banco Central respondeu ${res.status}.`);
        for (const r of seriesSchema.parse(await res.json())) out.push({ date: fromBr(r.data), value: r.valor });
      }
    } catch (err) {
      if (err instanceof BcbUnavailableError) throw err;
      throw new BcbUnavailableError(err instanceof z.ZodError ? "Resposta inesperada do Banco Central." : "Banco Central indisponível.");
    } finally {
      clearTimeout(timer);
    }
    start = addDays(end, 1);
  }
  return out;
}
