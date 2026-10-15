"use client";

import { formatBRL } from "@/lib/money";

interface TooltipEntry {
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

/** Tooltip padrão dos gráficos (valores sempre com rótulo e cor da série). */
export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter = (v) => formatBRL(v),
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  labelFormatter?: (label: string) => string;
  valueFormatter?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-40 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="mb-1.5 font-medium text-foreground">{labelFormatter ? labelFormatter(String(label)) : label}</p>}
      <ul className="space-y-1">
        {payload.map((p, i) => (
          <li key={`${p.dataKey ?? i}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full" style={{ backgroundColor: p.color }} />
              {p.name}
            </span>
            <span className="font-medium tabular text-foreground">{typeof p.value === "number" ? valueFormatter(p.value) : String(p.value ?? "")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const axisTick = { fontSize: 11, fill: "var(--chart-axis)" };

/** Rótulos compactos para o eixo (R$ 1,2 mil). */
export function compactBRL(cents: number): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}
