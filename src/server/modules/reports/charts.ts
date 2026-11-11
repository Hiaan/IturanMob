import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { addMonthsToKey, formatDateBR, formatMonthBR, monthKey, monthRange, todayISO } from "@/lib/dates";
import { recognizedRows, resolveRegime, type AnalyticsFilters } from "../analytics/service";
import { categoryBarsSvg, monthlyBarsSvg, svgToPng } from "./chart-image";

/**
 * Gráficos pedidos à Isa ("compara delivery e transporte nos últimos 6 meses", "gráfico dos meus
 * gastos por categoria"), com os mesmos números do painel. Devolve a imagem PNG.
 */

const SHORT_MONTH = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

export async function monthlyChart(
  ctx: ServiceContext,
  input: { months: number; kind: "EXPENSE" | "INCOME"; categories: Array<{ id: string; name: string }>; filters?: AnalyticsFilters },
): Promise<{ png: Buffer; title: string; totals: Array<{ name: string; values: number[] }>; monthKeys: string[] }> {
  assertCan(ctx, "reports:read");
  const months = Math.min(12, Math.max(1, input.months));
  const current = monthKey(todayISO(ctx.timezone));
  const keys = Array.from({ length: months }, (_, i) => addMonthsToKey(current, i - months + 1));
  const regime = await resolveRegime(ctx);
  const period = { start: monthRange(keys[0]!).start, end: todayISO(ctx.timezone) };
  const rows = (await recognizedRows(ctx, period, regime, { ...input.filters, categoryIds: input.categories.length ? input.categories.map((c) => c.id) : input.filters?.categoryIds ?? null })).filter((r) => r.type === input.kind);
  const series = (input.categories.length ? input.categories : [{ id: "", name: input.kind === "INCOME" ? "Receitas" : "Gastos" }]).map((c) => ({
    name: c.name,
    values: keys.map((k) => rows.filter((r) => r.date.startsWith(k) && (!c.id || r.categoryId === c.id)).reduce((s, r) => s + r.amountCents, 0)),
  }));
  const what = input.categories.length ? input.categories.map((c) => c.name).join(" e ") : input.kind === "INCOME" ? "Receitas por mês" : "Gastos por mês";
  const title = what.length > 48 ? (input.kind === "INCOME" ? "Receitas por mês" : "Gastos por mês") : what;
  const subtitle = `${months === 1 ? formatMonthBR(keys[0]!) : `Últimos ${months} meses`} · ${keys[keys.length - 1] === current ? "mês atual até hoje · " : ""}regime de ${regime === "CASH" ? "caixa" : "competência"}`;
  const svg = monthlyBarsSvg({ title, subtitle, months: keys.map((k) => SHORT_MONTH[Number(k.slice(5, 7)) - 1]!), series });
  return { png: await svgToPng(svg), title, totals: series, monthKeys: keys };
}

export async function categoryChart(
  ctx: ServiceContext,
  input: { start: string; end: string; kind: "EXPENSE" | "INCOME"; filters?: AnalyticsFilters },
): Promise<{ png: Buffer; title: string; items: Array<{ name: string; cents: number }> }> {
  assertCan(ctx, "reports:read");
  const regime = await resolveRegime(ctx);
  const rows = (await recognizedRows(ctx, { start: input.start, end: input.end }, regime, input.filters ?? {})).filter((r) => r.type === input.kind);
  const cats = await prisma.category.findMany({ where: { householdId: ctx.householdId }, select: { id: true, name: true } });
  const name = new Map(cats.map((c) => [c.id, c.name]));
  const by = new Map<string, number>();
  for (const r of rows) {
    const k = r.categoryId ? name.get(r.categoryId) ?? "Sem categoria" : "Sem categoria";
    by.set(k, (by.get(k) ?? 0) + r.amountCents);
  }
  const items = [...by.entries()].map(([n, cents]) => ({ name: n, cents })).sort((a, b) => b.cents - a.cents);
  const title = input.kind === "INCOME" ? "Receitas por categoria" : "Gastos por categoria";
  const sameMonth = input.start.slice(0, 7) === input.end.slice(0, 7) && input.start.endsWith("-01");
  const subtitle = `${sameMonth ? formatMonthBR(input.start.slice(0, 7)) : `${formatDateBR(input.start)} a ${formatDateBR(input.end)}`} · regime de ${regime === "CASH" ? "caixa" : "competência"}`;
  return { png: await svgToPng(categoryBarsSvg({ title, subtitle, items })), title, items };
}
