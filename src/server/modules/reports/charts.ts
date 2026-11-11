import { z } from "zod";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { NotFoundError } from "../../errors";
import { addMonthsToKey, formatDateBR, formatMonthBR, monthKey, monthRange, todayISO } from "@/lib/dates";
import { recognizedRows, resolveRegime, type AnalyticsFilters } from "../analytics/service";
import { categoryBarsSvg, monthlyBarsSvg, svgToPng } from "./chart-image";

/**
 * Gráficos pedidos à Isa ("compara delivery e transporte nos últimos 6 meses", "gráfico dos meus
 * gastos por categoria"), com os mesmos números do painel. A Isa manda a imagem no WhatsApp; o
 * gráfico pode ser salvo e aparece em "Meus gráficos" no painel, sempre recalculado.
 */

const SHORT_MONTH = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** O que define um gráfico (é o que fica salvo; os números são recalculados a cada abertura). */
export const chartSpecSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("MONTHLY"),
    kind: z.enum(["EXPENSE", "INCOME"]),
    months: z.number().int().min(1).max(12),
    categories: z.array(z.object({ id: z.string(), name: z.string() })).max(4),
  }),
  z.object({
    type: z.literal("BY_CATEGORY"),
    kind: z.enum(["EXPENSE", "INCOME"]),
    /** Período relativo: mês atual (CURRENT_MONTH) ou o anterior (LAST_MONTH); ou datas fixas. */
    period: z.enum(["CURRENT_MONTH", "LAST_MONTH", "FIXED"]),
    start: z.string().nullish(),
    end: z.string().nullish(),
  }),
]);
export type ChartSpec = z.infer<typeof chartSpecSchema>;

export interface MonthlySeries {
  type: "MONTHLY";
  title: string;
  subtitle: string;
  months: Array<{ key: string; label: string }>;
  series: Array<{ name: string; values: number[] }>;
}
export interface CategorySeries {
  type: "BY_CATEGORY";
  title: string;
  subtitle: string;
  items: Array<{ name: string; cents: number }>;
}
export type ChartData = MonthlySeries | CategorySeries;

export async function chartData(ctx: ServiceContext, spec: ChartSpec, filters: AnalyticsFilters = {}): Promise<ChartData> {
  assertCan(ctx, "reports:read");
  const regime = await resolveRegime(ctx);
  const today = todayISO(ctx.timezone);
  const regimeLabel = `regime de ${regime === "CASH" ? "caixa" : "competência"}`;
  if (spec.type === "MONTHLY") {
    const current = monthKey(today);
    const keys = Array.from({ length: spec.months }, (_, i) => addMonthsToKey(current, i - spec.months + 1));
    const rows = (await recognizedRows(ctx, { start: monthRange(keys[0]!).start, end: today }, regime, { ...filters, categoryIds: spec.categories.length ? spec.categories.map((c) => c.id) : filters.categoryIds ?? null })).filter(
      (r) => r.type === spec.kind,
    );
    const base = spec.categories.length ? spec.categories : [{ id: "", name: spec.kind === "INCOME" ? "Receitas" : "Gastos" }];
    const series = base.map((c) => ({ name: c.name, values: keys.map((k) => rows.filter((r) => r.date.startsWith(k) && (!c.id || r.categoryId === c.id)).reduce((s, r) => s + r.amountCents, 0)) }));
    const what = spec.categories.length ? spec.categories.map((c) => c.name).join(" e ") : spec.kind === "INCOME" ? "Receitas por mês" : "Gastos por mês";
    return {
      type: "MONTHLY",
      title: what.length > 48 ? (spec.kind === "INCOME" ? "Receitas por mês" : "Gastos por mês") : what,
      subtitle: `${spec.months === 1 ? formatMonthBR(keys[0]!) : `Últimos ${spec.months} meses`} · mês atual até hoje · ${regimeLabel}`,
      months: keys.map((k) => ({ key: k, label: SHORT_MONTH[Number(k.slice(5, 7)) - 1]! })),
      series,
    };
  }
  const range =
    spec.period === "CURRENT_MONTH"
      ? { start: `${today.slice(0, 7)}-01`, end: today }
      : spec.period === "LAST_MONTH"
        ? monthRange(addMonthsToKey(monthKey(today), -1))
        : { start: spec.start ?? `${today.slice(0, 7)}-01`, end: spec.end ?? today };
  const rows = (await recognizedRows(ctx, range, regime, filters)).filter((r) => r.type === spec.kind);
  const cats = await prisma.category.findMany({ where: { householdId: ctx.householdId }, select: { id: true, name: true } });
  const name = new Map(cats.map((c) => [c.id, c.name]));
  const by = new Map<string, number>();
  for (const r of rows) {
    const k = r.categoryId ? name.get(r.categoryId) ?? "Sem categoria" : "Sem categoria";
    by.set(k, (by.get(k) ?? 0) + r.amountCents);
  }
  const sameMonth = range.start.slice(0, 7) === range.end.slice(0, 7) && range.start.endsWith("-01");
  return {
    type: "BY_CATEGORY",
    title: spec.kind === "INCOME" ? "Receitas por categoria" : "Gastos por categoria",
    subtitle: `${sameMonth ? formatMonthBR(range.start.slice(0, 7)) : `${formatDateBR(range.start)} a ${formatDateBR(range.end)}`} · ${regimeLabel}`,
    items: [...by.entries()].map(([n, cents]) => ({ name: n, cents })).sort((a, b) => b.cents - a.cents),
  };
}

export async function chartPng(data: ChartData): Promise<Buffer> {
  const svg =
    data.type === "MONTHLY"
      ? monthlyBarsSvg({ title: data.title, subtitle: data.subtitle, months: data.months.map((m) => m.label), series: data.series })
      : categoryBarsSvg({ title: data.title, subtitle: data.subtitle, items: data.items });
  return svgToPng(svg);
}

// -----------------------------------------------------------------------------
// Meus gráficos (salvos no painel)
// -----------------------------------------------------------------------------

export async function saveChart(ctx: ServiceContext, input: { title: string; spec: ChartSpec }) {
  assertCan(ctx, "reports:read");
  const spec = chartSpecSchema.parse(input.spec);
  const count = await prisma.savedChart.count({ where: { householdId: ctx.householdId } });
  if (count >= 30) throw new Error("Já são 30 gráficos salvos: apague algum no painel antes de salvar outro.");
  return prisma.savedChart.create({ data: { householdId: ctx.householdId, createdByMemberId: ctx.memberId, title: input.title.slice(0, 80), spec } });
}

export async function listSavedCharts(ctx: ServiceContext) {
  assertCan(ctx, "reports:read");
  const charts = await prisma.savedChart.findMany({ where: { householdId: ctx.householdId }, orderBy: { createdAt: "desc" } });
  const out: Array<{ id: string; title: string; createdAt: string; data: ChartData | null }> = [];
  for (const c of charts) {
    const parsed = chartSpecSchema.safeParse(c.spec);
    out.push({ id: c.id, title: c.title, createdAt: c.createdAt.toISOString(), data: parsed.success ? await chartData(ctx, parsed.data, { scope: ctx.reportScope ?? null }) : null });
  }
  return out;
}

export async function deleteSavedChart(ctx: ServiceContext, id: string) {
  assertCan(ctx, "reports:read");
  const res = await prisma.savedChart.deleteMany({ where: { id, householdId: ctx.householdId } });
  if (!res.count) throw new NotFoundError("Gráfico");
}
