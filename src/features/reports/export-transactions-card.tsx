"use client";

import { useState } from "react";
import { FileSpreadsheet, Sheet as SheetIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolvePeriod, todayISO, type PeriodPreset } from "@/lib/dates";
import { useCan } from "@/features/me/use-me";
import { cn } from "@/lib/utils";
import { downloadWithToast } from "./use-reports";

/** Natureza das transações exportadas (a coluna "Natureza" vem em todas). */
type ExportNature = "ALL" | "PERSONAL" | "BUSINESS" | "PASSTHROUGH";
const NATURE_TYPES = ["EXPENSE", "INCOME"];
const EXPORT_NATURES: Array<{ id: ExportNature; label: string; params: Record<string, unknown> }> = [
  { id: "ALL", label: "Todas", params: {} },
  { id: "PERSONAL", label: "Pessoal", params: { scope: "PERSONAL", excluded: "hide", types: NATURE_TYPES } },
  { id: "BUSINESS", label: "Empresa", params: { scope: "BUSINESS", excluded: "hide", types: NATURE_TYPES } },
  { id: "PASSTHROUGH", label: "Repasses", params: { excluded: "only" } },
];

const PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: "thisMonth", label: "Este mês" },
  { id: "lastMonth", label: "Mês anterior" },
  { id: "last3Months", label: "Últimos 3 meses" },
  { id: "thisYear", label: "Este ano" },
];

/** Exportação avulsa de transações (CSV pt-BR ou Excel) por período. */
export function ExportTransactionsCard({ timezone }: { timezone?: string }) {
  const today = todayISO(timezone);
  const initial = resolvePeriod("thisMonth", today);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [nature, setNature] = useState<ExportNature>("ALL");
  const [busy, setBusy] = useState<"csv" | "xlsx" | null>(null);
  const canExport = useCan("data:export");
  const invalid = !start || !end || start > end;

  const run = async (format: "csv" | "xlsx") => {
    setBusy(format);
    await downloadWithToast(
      "/api/v1/exports/transactions",
      { format, start, end, dateField: "date", sort: "date_asc", deleted: includeDeleted ? "include" : "exclude", ...(EXPORT_NATURES.find((n) => n.id === nature)?.params ?? {}) },
      `transacoes.${format}`,
      format === "csv" ? "CSV" : "Planilha Excel",
    );
    setBusy(null);
  };

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-[15px] font-semibold">Exportar transações</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Planilha com data, descrição, categoria, tipo, valor, forma de pagamento, conta/cartão, responsável, situação e natureza. O CSV usa ponto e vírgula e vírgula decimal (abre direto no Excel em português). Até 50 mil linhas.
      </p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Períodos rápidos">
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const r = resolvePeriod(p.id, today);
              setStart(r.start);
              setEnd(r.end);
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <Field label="De" htmlFor="exp-start">
          <Input id="exp-start" type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} aria-invalid={invalid || undefined} />
        </Field>
        <Field label="Até" htmlFor="exp-end" error={invalid && start && end ? "A data final deve ser posterior à inicial." : undefined}>
          <Input id="exp-end" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} aria-invalid={invalid || undefined} />
        </Field>
      </div>
      <div className="mt-4 grid gap-1.5">
        <p id="exp-nature-label" className="text-[13px] font-medium">
          Natureza
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="exp-nature-label">
          {EXPORT_NATURES.map((n) => (
            <button
              key={n.id}
              type="button"
              role="radio"
              aria-checked={nature === n.id}
              onClick={() => setNature(n.id)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                nature === n.id ? "border-brand bg-accent text-accent-foreground" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {nature === n.id && <span aria-hidden>✓</span>}
              {n.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {nature === "BUSINESS"
            ? "Só receitas e despesas da empresa (ex.: para o contador). Transferências e pagamentos de fatura não têm natureza e ficam de fora."
            : nature === "PERSONAL"
              ? "Só receitas e despesas pessoais (sem empresa e sem repasses). Transferências e pagamentos de fatura ficam de fora."
              : nature === "PASSTHROUGH"
                ? "Só os repasses de clientes e reembolsos (desconsiderados nos relatórios)."
                : "Todas as transações do período, com a coluna “Natureza”."}
        </p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Checkbox id="exp-deleted" checked={includeDeleted} onCheckedChange={(v) => setIncludeDeleted(v === true)} />
        <Label htmlFor="exp-deleted" className="text-sm font-normal">
          Incluir lançamentos excluídos (lixeira), marcados como “Excluída”
        </Label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => run("csv")} loading={busy === "csv"} disabled={invalid || Boolean(busy) || !canExport}>
          <SheetIcon /> Baixar CSV
        </Button>
        <Button variant="outline" onClick={() => run("xlsx")} loading={busy === "xlsx"} disabled={invalid || Boolean(busy) || !canExport}>
          <FileSpreadsheet /> Baixar Excel
        </Button>
      </div>
      {!canExport && <p className="mt-2 text-xs text-muted-foreground">Seu perfil não tem permissão para exportar dados.</p>}
    </Card>
  );
}
