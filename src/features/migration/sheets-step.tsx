"use client";

import { useId, useState } from "react";
import { ArrowRight, CalendarDays, ChevronDown, EyeOff, Grid3x3, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MONTH_NAMES, todayISO } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Warnings } from "@/features/imports/warnings";
import type { MatrixMode, MigrationDTO, SheetConfig, SheetKind, UnsignedAs } from "@/server/modules/migration/types";
import { SETTABLE_KINDS, SHEET_KIND_HINTS, SHEET_KIND_LABELS, isIgnoredKind, monthRangeLabel, plural, usesColumns } from "./labels";
import { useMigrationBusy, useUpdateSheets, type SheetPatch } from "./use-migration";

const KIND_VARIANT: Record<SheetKind, "info" | "brand" | "warning" | "muted" | "positive"> = {
  LIST: "info",
  MONTH: "brand",
  MATRIX: "positive",
  SUMMARY: "muted",
  EMPTY: "muted",
};

export function SheetKindBadge({ kind }: { kind: SheetKind }) {
  return <Badge variant={KIND_VARIANT[kind]}>{SHEET_KIND_LABELS[kind]}</Badge>;
}

const UNSIGNED_LABELS: Record<UnsignedAs, string> = {
  EXPENSE: "Despesas",
  INCOME: "Receitas",
  BY_CATEGORY: "Pelo tipo da categoria",
};

/** Mês e ano da aba (AAAA-MM), com dois seletores (funciona em qualquer navegador). */
function MonthPicker({ id, value, onChange, disabled }: { id: string; value: string | null; onChange: (v: string) => void; disabled: boolean }) {
  const thisYear = Number(todayISO().slice(0, 4));
  const [y, m] = value ? value.split("-") : [undefined, undefined];
  const years = Array.from({ length: 32 }, (_, i) => thisYear + 1 - i);
  if (y && !years.includes(Number(y))) years.push(Number(y));
  const set = (year: string | undefined, month: string | undefined) => {
    if (year && month) onChange(`${year}-${month}`);
  };
  return (
    <div className="flex gap-2">
      <Select value={m ?? ""} onValueChange={(v) => set(y ?? String(thisYear), v)} disabled={disabled}>
        <SelectTrigger id={id} className="min-w-0 flex-1" aria-label="Mês da aba">
          <SelectValue placeholder="Mês" />
        </SelectTrigger>
        <SelectContent>
          {MONTH_NAMES.map((name, i) => (
            <SelectItem key={name} value={String(i + 1).padStart(2, "0")}>
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={y ?? ""} onValueChange={(v) => set(v, m ?? "01")} disabled={disabled}>
        <SelectTrigger className="w-28 shrink-0" aria-label="Ano da aba">
          <SelectValue placeholder="Ano" />
        </SelectTrigger>
        <SelectContent>
          {years.map((year) => (
            <SelectItem key={year} value={String(year)}>
              {year}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MatrixModeField({ sheet, onChange, disabled }: { sheet: SheetConfig; onChange: (v: MatrixMode) => void; disabled: boolean }) {
  const name = useId();
  const options: Array<{ value: MatrixMode; title: string; hint: string }> = [
    {
      value: "TRANSACTIONS",
      title: "Lançamentos consolidados por mês",
      hint: "Um lançamento por categoria e mês, marcado “importado de planilha (total do mês)”.",
    },
    { value: "BUDGET", title: "Orçamento", hint: "Os valores viram o limite mensal de cada categoria em Orçamentos." },
  ];
  return (
    <fieldset className={cn("grid gap-2 rounded-lg border p-3 sm:col-span-2", !sheet.matrixMode && "border-warning/50 bg-warning/5")} disabled={disabled}>
      <legend className="px-1 text-[13px] font-medium">
        O que são estes valores? <span className="text-destructive" aria-hidden>*</span>
        <span className="sr-only">(obrigatório)</span>
      </legend>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-muted/50 has-[:disabled]:cursor-not-allowed">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={sheet.matrixMode === o.value}
            onChange={() => onChange(o.value)}
            className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]"
            required
          />
          <span className="min-w-0 text-sm">
            <span className="block font-medium">{o.title}</span>
            <span className="block text-xs text-muted-foreground">{o.hint}</span>
          </span>
        </label>
      ))}
      {!sheet.matrixMode && <p className="text-xs font-medium text-warning">Escolha uma opção para importar esta aba.</p>}
    </fieldset>
  );
}

function SheetControls({ sheet, patch, disabled }: { sheet: SheetConfig; patch: (p: Omit<SheetPatch, "index">) => void; disabled: boolean }) {
  const base = `sheet-${sheet.index}`;
  const months = sheet.matrix?.months.map((m) => m.month) ?? [];
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <Field label="Tipo da aba" htmlFor={`${base}-kind`} hint={SHEET_KIND_HINTS[sheet.kind]}>
        <Select value={sheet.kind} onValueChange={(v) => patch({ kind: v as (typeof SETTABLE_KINDS)[number] })} disabled={disabled}>
          <SelectTrigger id={`${base}-kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTABLE_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {SHEET_KIND_LABELS[k]}
              </SelectItem>
            ))}
            {sheet.kind === "EMPTY" && (
              <SelectItem value="EMPTY" disabled>
                {SHEET_KIND_LABELS.EMPTY}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </Field>

      {sheet.kind === "MONTH" && (
        <Field
          label="Mês da aba"
          htmlFor={`${base}-month`}
          hint={
            sheet.yearGuessed ? (
              <span className="inline-flex items-center gap-1 font-medium text-warning">
                <TriangleAlert className="size-3.5" aria-hidden /> Ano estimado — confira
              </span>
            ) : (
              "Datas só com o dia usam este mês e ano."
            )
          }
        >
          <MonthPicker id={`${base}-month`} value={sheet.month} onChange={(month) => patch({ month })} disabled={disabled} />
        </Field>
      )}

      {sheet.kind === "MATRIX" && (
        <>
          {months.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground sm:col-span-2">
              <CalendarDays className="size-3.5 shrink-0" aria-hidden /> {plural(months.length, "mês encontrado", "meses encontrados")}: {monthRangeLabel(months)}
            </p>
          )}
          <MatrixModeField sheet={sheet} onChange={(matrixMode) => patch({ matrixMode })} disabled={disabled} />
        </>
      )}

      {usesColumns(sheet.kind) && sheet.unsigned && (
        <Field
          label="Valores sem sinal são"
          htmlFor={`${base}-unsigned`}
          hint="Nenhum valor negativo nem coluna de tipo nesta aba: diga como ler os valores."
          className={cn(!sheet.unsignedAs && "[&_button]:border-warning/60")}
        >
          <Select value={sheet.unsignedAs ?? ""} onValueChange={(v) => patch({ unsignedAs: v as UnsignedAs })} disabled={disabled}>
            <SelectTrigger id={`${base}-unsigned`}>
              <SelectValue placeholder="Escolha" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(UNSIGNED_LABELS) as UnsignedAs[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {UNSIGNED_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {usesColumns(sheet.kind) && (
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3 sm:col-span-2">
          <div className="grid gap-0.5">
            <Label htmlFor={`${base}-invert`} className="text-sm">
              Inverter sinais
            </Label>
            <p className="text-xs text-muted-foreground">Ative se as saídas aparecem positivas e as entradas negativas nesta aba.</p>
          </div>
          <Switch id={`${base}-invert`} checked={sheet.invertSigns} onCheckedChange={(v) => patch({ invertSigns: v })} disabled={disabled} />
        </div>
      )}
    </div>
  );
}

function SheetCounts({ sheet }: { sheet: SheetConfig }) {
  const parts = [plural(sheet.rowCount, "linha com conteúdo", "linhas com conteúdo")];
  if (!isIgnoredKind(sheet.kind)) parts.push(sheet.kind === "MATRIX" ? plural(sheet.dataRows, "linha de categoria", "linhas de categoria") : plural(sheet.dataRows, "lançamento", "lançamentos"));
  if (sheet.ignoredRows) parts.push(`${plural(sheet.ignoredRows, "linha de total ignorada", "linhas de total ignoradas")}`);
  return <p className="mt-1 text-xs text-muted-foreground tabular">{parts.join(" · ")}</p>;
}

function SheetCard({ sheet, patch, disabled }: { sheet: SheetConfig; patch: (p: Omit<SheetPatch, "index">) => void; disabled: boolean }) {
  const checkId = `sheet-${sheet.index}-selected`;
  const canSelect = sheet.kind !== "EMPTY" && sheet.kind !== "SUMMARY";
  return (
    <Card className={cn("p-4 sm:p-5", !sheet.selected && "bg-muted/30")}>
      <div className="flex items-start gap-3">
        <Checkbox
          id={checkId}
          checked={sheet.selected}
          onCheckedChange={(v) => patch({ selected: v === true })}
          disabled={disabled || (!canSelect && !sheet.selected)}
          className="mt-1"
          aria-describedby={`${checkId}-reason`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={checkId} className="break-words text-[15px] font-semibold">
              {sheet.name}
            </Label>
            <SheetKindBadge kind={sheet.kind} />
            {sheet.hidden && (
              <Badge variant="muted" title="Aba oculta na planilha">
                <EyeOff aria-hidden /> Oculta
              </Badge>
            )}
            {sheet.kind !== sheet.detectedKind && <Badge variant="outline">ajustada (detectada: {SHEET_KIND_LABELS[sheet.detectedKind]})</Badge>}
            {sheet.fromTemplate && <Badge variant="outline">do formato salvo</Badge>}
          </div>
          <p id={`${checkId}-reason`} className="mt-1 text-sm text-muted-foreground">
            {sheet.reason}
          </p>
          <SheetCounts sheet={sheet} />
          {sheet.truncated && (
            <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> A aba passou do limite de 20 mil linhas por arquivo: só as primeiras foram lidas. Divida a planilha e envie o restante
              depois.
            </p>
          )}
          {sheet.selected ? (
            <SheetControls sheet={sheet} patch={patch} disabled={disabled} />
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">Fora da migração. Marque a caixa para importar esta aba.</p>
          )}
          {sheet.warnings.length > 0 && <Warnings warnings={sheet.warnings} compact className="mt-3" />}
        </div>
      </div>
    </Card>
  );
}

/** Aba ignorada (resumo/vazia): recolhida, com o motivo e a opção de mudar o tipo. */
function IgnoredSheet({ sheet, patch, disabled }: { sheet: SheetConfig; patch: (p: Omit<SheetPatch, "index">) => void; disabled: boolean }) {
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="break-words font-medium">{sheet.name}</span>
          <SheetKindBadge kind={sheet.kind} />
          {sheet.hidden && (
            <Badge variant="muted">
              <EyeOff aria-hidden /> Oculta
            </Badge>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {sheet.reason} · {plural(sheet.rowCount, "linha com conteúdo", "linhas com conteúdo")}
        </p>
      </div>
      {sheet.kind !== "EMPTY" && (
        <Select value="" onValueChange={(v) => patch({ kind: v as (typeof SETTABLE_KINDS)[number], selected: true })} disabled={disabled}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-52" aria-label={`Importar a aba ${sheet.name} como…`}>
            <SelectValue placeholder="Importar mesmo assim como…" />
          </SelectTrigger>
          <SelectContent>
            {SETTABLE_KINDS.filter((k) => k !== "SUMMARY").map((k) => (
              <SelectItem key={k} value={k}>
                {SHEET_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </li>
  );
}

/** Etapa 2: abas da planilha (o que entra, tipo de cada uma, mês, sinais). */
export function SheetsStep({ migration: m, onNext }: { migration: MigrationDTO; onNext: () => void }) {
  const update = useUpdateSheets(m.id);
  const busy = useMigrationBusy(m.id);
  const [showIgnored, setShowIgnored] = useState(false);
  const ignored = m.sheets.filter((s) => isIgnoredKind(s.kind) && !s.selected);
  const active = m.sheets.filter((s) => !ignored.includes(s));
  const selected = m.sheets.filter((s) => s.selected);
  const patch = (index: number) => (p: Omit<SheetPatch, "index">) => update.mutate([{ index, ...p }]);
  const missingMatrix = selected.filter((s) => s.kind === "MATRIX" && !s.matrixMode);
  const missingUnsigned = selected.filter((s) => usesColumns(s.kind) && s.unsigned && !s.unsignedAs);
  const missingMonth = selected.filter((s) => s.kind === "MONTH" && !s.month);
  const hints = [
    ...missingMatrix.map((s) => `Diga o que são os valores da aba “${s.name}” (lançamentos ou orçamento).`),
    ...missingUnsigned.map((s) => `Diga como ler os valores sem sinal da aba “${s.name}”.`),
    ...missingMonth.map((s) => `Escolha o mês da aba “${s.name}”.`),
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">Abas da planilha</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Confira o que o app entendeu de cada aba. Desmarque o que não quiser trazer e ajuste o tipo, se precisar. {plural(selected.length, "aba selecionada", "abas selecionadas")} de{" "}
          {m.sheets.length}.
        </p>
      </div>

      {active.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Nenhuma aba com lançamentos foi encontrada. Veja abaixo as abas ignoradas e importe alguma mesmo assim, se for o caso.</Card>
      ) : (
        <div className="space-y-3">
          {active.map((s) => (
            <SheetCard key={s.index} sheet={s} patch={patch(s.index)} disabled={busy} />
          ))}
        </div>
      )}

      {ignored.length > 0 && (
        <Card className="p-0">
          <button
            type="button"
            onClick={() => setShowIgnored((v) => !v)}
            aria-expanded={showIgnored}
            className="flex w-full items-center justify-between gap-3 rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <Grid3x3 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-medium">{plural(ignored.length, "aba ignorada", "abas ignoradas")}</span>
              <span className="hidden text-muted-foreground sm:inline">(resumos, gráficos ou vazias)</span>
            </span>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", showIgnored && "rotate-180")} aria-hidden />
          </button>
          {showIgnored && (
            <ul className="divide-y border-t px-4">
              {ignored.map((s) => (
                <IgnoredSheet key={s.index} sheet={s} patch={patch(s.index)} disabled={busy} />
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        {hints.length > 0 && (
          <ul className="space-y-0.5 text-xs text-warning sm:mr-auto" aria-label="O que falta nas abas">
            {hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        )}
        <Button variant="brand" onClick={onNext} disabled={!selected.length || busy}>
          Continuar para colunas <ArrowRight aria-hidden />
        </Button>
      </div>
      {!selected.length && <p className="text-right text-xs text-muted-foreground">Selecione ao menos uma aba para continuar.</p>}
    </div>
  );
}
