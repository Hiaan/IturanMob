"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarRange, ChevronDown, ChevronUp, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { axisTick, compactBRL } from "@/components/charts/chart-tooltip";
import { formatBRL } from "@/lib/money";
import { addMonthsToKey, formatMonthBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { CardDTO } from "@/features/finance/types";
import type { ProjectionMonth } from "./types";

/**
 * Cores fixas por série (validadas para daltonismo e contraste nos dois temas, nesta ordem de empilhamento):
 * contas fixas, assinaturas no cartão e até quatro cartões; a partir do quinto, "Outros cartões".
 * A cor segue o cartão (ordem do cadastro), não a posição no gráfico: trocar o recorte não repinta.
 */
const FIXED_COLOR = "var(--series-1)";
const CARD_SUBS_COLOR = "var(--series-4)";
const CARD_COLORS = ["var(--series-3)", "var(--series-2)", "var(--series-7)", "var(--series-5)"];
const OTHER_CARDS_COLOR = "var(--chart-axis)";
const OTHER_KEY = "card:other";

interface Series {
  key: string;
  name: string;
  color: string;
}

type Row = { month: string; label: string; totalCents: number; endingCount: number; releasesNextMonthCents: number; topKey: string | null } & Record<string, number | string | null>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 parcelamentos terminam — libera R$ 614,96 no mês seguinte" */
export function endingNote(p: Pick<ProjectionMonth, "endingCount" | "releasesNextMonthCents">): string | null {
  if (!p.endingCount) return null;
  return `${plural(p.endingCount, "parcelamento termina", "parcelamentos terminam")} — libera ${formatBRL(p.releasesNextMonthCents)} no mês seguinte`;
}

function useSeries(projection: ProjectionMonth[], cards: CardDTO[]) {
  return useMemo(() => {
    // Ordem estável: cartões ativos (ordem do cadastro) e depois os arquivados.
    const order = [...cards.filter((c) => !c.archivedAt), ...cards.filter((c) => c.archivedAt)].map((c) => c.id);
    const present = new Map<string, string>();
    for (const p of projection) for (const c of p.installmentsByCard) if (c.amountCents > 0) present.set(c.cardId, c.cardName);
    const slotOf = (id: string) => {
      const i = order.indexOf(id);
      return i >= 0 && i < CARD_COLORS.length ? i : -1;
    };
    const cardSeries: Series[] = [...present.entries()]
      .filter(([id]) => slotOf(id) >= 0)
      .sort(([a], [b]) => slotOf(a) - slotOf(b))
      .map(([id, name]) => ({ key: `card:${id}`, name: `Parcelas ${name}`, color: CARD_COLORS[slotOf(id)]! }));
    const others = [...present.keys()].filter((id) => slotOf(id) < 0);
    const series: Series[] = [];
    if (projection.some((p) => p.recurringCents > 0)) series.push({ key: "fixed", name: "Contas fixas", color: FIXED_COLOR });
    if (projection.some((p) => p.recurringOnCardCents > 0)) series.push({ key: "cardSubs", name: "Assinaturas no cartão", color: CARD_SUBS_COLOR });
    series.push(...cardSeries);
    if (others.length) series.push({ key: OTHER_KEY, name: others.length === 1 ? `Parcelas ${present.get(others[0]!)}` : "Parcelas de outros cartões", color: OTHER_CARDS_COLOR });
    const otherSet = new Set(others);

    const rows: Row[] = projection.map((p) => {
      const row: Row = {
        month: p.month,
        label: formatMonthBR(p.month, { short: true }),
        totalCents: p.totalCents,
        endingCount: p.endingCount,
        releasesNextMonthCents: p.releasesNextMonthCents,
        topKey: null,
        fixed: p.recurringCents,
        cardSubs: p.recurringOnCardCents,
      };
      for (const sr of series) row[sr.key] ??= 0;
      let other = 0;
      for (const c of p.installmentsByCard) {
        if (otherSet.has(c.cardId)) other += c.amountCents;
        else row[`card:${c.cardId}`] = c.amountCents;
      }
      if (others.length) row[OTHER_KEY] = other;
      // Série no topo da pilha neste mês (para o rótulo do total).
      for (const s of series) if (Number(row[s.key] ?? 0) > 0) row.topKey = s.key;
      return row;
    });
    return { series, rows };
  }, [projection, cards]);
}

function ProjectionTooltip({ active, payload, label, series }: { active?: boolean; payload?: Array<{ payload?: Row }>; label?: string; series: Series[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const note = endingNote(row);
  return (
    <div className="min-w-52 max-w-72 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-medium text-foreground">{label}</p>
      <ul className="space-y-1">
        {[...series].reverse().map((s) => {
          const v = Number(row[s.key] ?? 0);
          if (!v) return null;
          return (
            <li key={s.key} className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="truncate">{s.name}</span>
              </span>
              <span className="font-medium tabular text-foreground">{formatBRL(v)}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 flex items-center justify-between gap-4 border-t pt-1.5 font-semibold text-foreground">
        <span>Total</span>
        <span className="tabular">{formatBRL(row.totalCents)}</span>
      </p>
      {note && <p className="mt-1 text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * Rótulo do total no topo da pilha (só na série que está no topo daquele mês e quando há espaço).
 * O mês chega como `value` (via `valueAccessor`): o índice do LabelList pula as barras vazias.
 */
const monthOfEntry = (entry: { payload?: unknown }) => (entry.payload as Row | undefined)?.month;

function totalLabel(key: string, rows: Row[]) {
  function TotalLabel(props: { x?: number | string; y?: number | string; width?: number | string; value?: unknown }) {
    const row = rows.find((r) => r.month === props.value);
    const width = Number(props.width ?? 0);
    if (!row || row.topKey !== key || width < 26) return null;
    return (
      <text x={Number(props.x) + width / 2} y={Number(props.y) - 6} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)" className="tabular">
        {compactBRL(row.totalCents)}
      </text>
    );
  }
  return TotalLabel;
}

function MonthCard({ p, series, row }: { p: ProjectionMonth; series: Series[]; row: Row }) {
  const note = endingNote(p);
  return (
    <li className="rounded-xl border p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium">{formatMonthBR(p.month, { capitalize: true })}</p>
        <p className="whitespace-nowrap text-base font-semibold tabular">{formatBRL(p.totalCents)}</p>
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        {series.map((s) => {
          const v = Number(row[s.key] ?? 0);
          if (!v) return null;
          return (
            <div key={s.key} className="flex items-center justify-between gap-3">
              <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
                <span className="truncate">{s.name}</span>
              </dt>
              <dd className="whitespace-nowrap font-medium tabular">{formatBRL(v)}</dd>
            </div>
          );
        })}
      </dl>
      {note && (
        <p className="mt-2 flex gap-1.5 rounded-lg bg-positive/10 px-2 py-1.5 text-xs text-positive">
          <TrendingDown className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {note}
        </p>
      )}
    </li>
  );
}

const MOBILE_INITIAL_MONTHS = 6;

/** c) Projeção mês a mês do que já está comprometido: gráfico empilhado + tabela (cartões por mês no celular). */
export function ProjectionSection({ projection, cards }: { projection: ProjectionMonth[]; cards: CardDTO[] }) {
  const { series, rows } = useSeries(projection, cards);
  const [showAll, setShowAll] = useState(false);
  const empty = projection.every((p) => !p.totalCents);
  const peak = projection.reduce<ProjectionMonth | null>((m, p) => (!m || p.totalCents > m.totalCents ? p : m), null);
  const mobileRows = showAll ? projection : projection.slice(0, MOBILE_INITIAL_MONTHS);
  const months = projection.length;

  return (
    <Card aria-labelledby="fixed-projection-title">
      <CardHeader>
        <CardTitle id="fixed-projection-title" className="flex items-center gap-2">
          <CalendarRange className="size-4 text-brand" aria-hidden /> Projeção ({months} {months === 1 ? "mês" : "meses"})
        </CardTitle>
        <CardDescription className="text-xs">
          Contas fixas, assinaturas no cartão e parcelas de cada cartão, pelo mês de vencimento.
          {peak && peak.totalCents > 0 && ` Mês mais pesado: ${formatMonthBR(peak.month)} (${formatBRL(peak.totalCents)}).`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {empty ? (
          <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">Nada comprometido nos próximos meses: cadastre contas fixas ou lance compras parceladas para ver a projeção.</p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label="Legenda">
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
                  {s.name}
                </li>
              ))}
            </ul>
            <figure className="m-0" aria-label={`Gráfico de barras empilhadas: compromissos de ${formatMonthBR(projection[0]!.month)} a ${formatMonthBR(projection[projection.length - 1]!.month)}. Os mesmos valores estão na tabela abaixo.`}>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows} barCategoryGap="22%" margin={{ top: 20, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={4} />
                  <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={compactBRL} width={48} />
                  <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={(p) => <ProjectionTooltip active={p.active} payload={p.payload as never} label={p.label as string} series={series} />} />
                  {series.map((s, idx) => (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      name={s.name}
                      stackId="total"
                      fill={s.color}
                      stroke="var(--card)"
                      strokeWidth={2}
                      radius={idx === series.length - 1 ? [4, 4, 0, 0] : undefined}
                      maxBarSize={40}
                      isAnimationActive={false}
                    >
                      <LabelList valueAccessor={monthOfEntry} content={totalLabel(s.key, rows)} />
                    </Bar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </figure>

            <div className="hidden xl:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-60">Mês</TableHead>
                    {series.map((s) => (
                      <TableHead key={s.key} className="h-auto py-2 text-right whitespace-normal">
                        <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ backgroundColor: s.color }} aria-hidden />
                        {s.name}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projection.map((p, idx) => {
                    const row = rows[idx]!;
                    const note = endingNote(p);
                    return (
                      <TableRow key={p.month}>
                        <TableCell className="min-w-60 max-w-72 align-top whitespace-normal">
                          <span className="block whitespace-nowrap font-medium">{formatMonthBR(p.month, { capitalize: true })}</span>
                          {note && (
                            <span className="mt-0.5 flex items-start gap-1 text-xs text-positive" title={`A partir de ${formatMonthBR(addMonthsToKey(p.month, 1))}`}>
                              <TrendingDown className="mt-0.5 size-3 shrink-0" aria-hidden />
                              {note}
                            </span>
                          )}
                        </TableCell>
                        {series.map((s) => {
                          const v = Number(row[s.key] ?? 0);
                          return (
                            <TableCell key={s.key} className={cn("whitespace-nowrap text-right align-top tabular", !v && "text-muted-foreground")}>
                              {v ? formatBRL(v) : "—"}
                            </TableCell>
                          );
                        })}
                        <TableCell className="whitespace-nowrap text-right align-top font-semibold tabular">{formatBRL(p.totalCents)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="xl:hidden">
              <ul className="grid gap-2 md:grid-cols-2" aria-label="Projeção mês a mês">
                {mobileRows.map((p) => (
                  <MonthCard key={p.month} p={p} series={series} row={rows[projection.indexOf(p)]!} />
                ))}
              </ul>
              {projection.length > MOBILE_INITIAL_MONTHS && (
                <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                  {showAll ? <ChevronUp /> : <ChevronDown />}
                  {showAll ? "Mostrar menos meses" : `Mostrar os ${projection.length} meses`}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
