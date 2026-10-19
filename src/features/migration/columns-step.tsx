"use client";

import { ArrowLeft, ArrowRight, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ColumnMap, MigrationDTO, MigrationField, SheetConfig } from "@/server/modules/migration/types";
import { FIELD_LABELS, FIELD_ORDER, columnLetter, plural, usesColumns } from "./labels";
import { SheetKindBadge } from "./sheets-step";
import { useMigrationBusy, useUpdateSheets } from "./use-migration";

const NONE = "__none__";
/** Até quantas linhas oferecer como cabeçalho. */
const MAX_HEADER_ROWS = 30;

/** Campo ligado a cada coluna (o primeiro, se houver mais de um). */
function fieldsByColumn(columns: ColumnMap): Map<number, MigrationField[]> {
  const map = new Map<number, MigrationField[]>();
  for (const f of FIELD_ORDER) {
    const col = columns[f];
    if (col === null || col === undefined) continue;
    map.set(col, [...(map.get(col) ?? []), f]);
  }
  return map;
}

/**
 * Liga `field` à coluna `col` (ou solta a coluna, com field null): a coluna fica com um campo só e cada
 * campo com uma coluna só — o objeto inteiro vai para o servidor.
 */
export function assignColumn(columns: ColumnMap, col: number, field: MigrationField | null): ColumnMap {
  const next = { ...columns };
  for (const f of FIELD_ORDER) if (next[f] === col) next[f] = null;
  if (field) next[field] = col;
  return next;
}

/** O que falta para a aba ser lida (conferência rápida; quem decide é o servidor). */
function missingFields(sheet: SheetConfig): string[] {
  const c = sheet.columns;
  const out: string[] = [];
  const hasDate = c.date !== null || (sheet.kind === "MONTH" && c.day !== null);
  if (!hasDate) out.push(sheet.kind === "MONTH" ? "Data ou Dia" : "Data");
  if (c.amount === null && c.debit === null && c.credit === null) out.push("Valor (ou Débito / Crédito)");
  return out;
}

function SheetColumns({ sheet, disabled, onColumns, onHeaderRow }: { sheet: SheetConfig; disabled: boolean; onColumns: (c: ColumnMap) => void; onHeaderRow: (i: number) => void }) {
  const width = Math.max(sheet.headers.length, ...sheet.sample.map((r) => r.length), 0);
  const cols = Array.from({ length: width }, (_, i) => i);
  const byColumn = fieldsByColumn(sheet.columns);
  const missing = missingFields(sheet);
  const headerOptions = Math.max(1, Math.min(sheet.rowCount, MAX_HEADER_ROWS));
  const base = `cols-${sheet.index}`;

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-words text-[15px] font-semibold">{sheet.name}</span>
            <SheetKindBadge kind={sheet.kind} />
            {sheet.fromTemplate && <Badge variant="outline">do formato salvo</Badge>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {plural(width, "coluna", "colunas")} · {plural(sheet.dataRows, "lançamento", "lançamentos")} · primeiras {sheet.sample.length} linhas abaixo
          </p>
        </div>
        <Field label="Linha do cabeçalho" htmlFor={`${base}-header`} className="sm:w-56">
          <Select value={String(sheet.headerRowIndex)} onValueChange={(v) => onHeaderRow(Number(v))} disabled={disabled}>
            <SelectTrigger id={`${base}-header`} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="-1">Sem cabeçalho</SelectItem>
              {Array.from({ length: Math.max(headerOptions, sheet.headerRowIndex + 1) }, (_, i) => (
                <SelectItem key={i} value={String(i)}>
                  Linha {i + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        A linha do cabeçalho é contada entre as linhas com conteúdo da aba (linhas em branco não contam). Ao trocar, as colunas são detectadas de novo.
      </p>

      {missing.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 p-2.5 text-xs font-medium">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden /> Falta indicar a coluna de: {missing.join(", ")}.
        </p>
      )}

      {width === 0 ? (
        <p className="mt-4 rounded-lg border p-4 text-center text-sm text-muted-foreground">Nenhuma linha de dados abaixo do cabeçalho. Escolha outra linha de cabeçalho.</p>
      ) : (
        <div className="relative mt-4 overflow-x-auto rounded-lg border">
          <table className="w-full min-w-max text-sm">
            <caption className="sr-only">Colunas da aba {sheet.name}: escolha o campo de cada coluna</caption>
            <thead>
              <tr className="border-b bg-muted/40">
                {cols.map((i) => {
                  const fields = byColumn.get(i) ?? [];
                  const current = fields[0] ?? null;
                  const header = sheet.headers[i]?.trim();
                  return (
                    <th key={i} scope="col" className="min-w-44 px-2 py-2 text-left align-top font-medium">
                      <span className="block px-1 text-[11px] text-muted-foreground">Coluna {columnLetter(i)}</span>
                      <span className="block max-w-56 truncate px-1" title={header || undefined}>
                        {header || <span className="font-normal italic text-muted-foreground">sem título</span>}
                      </span>
                      <Select value={current ?? NONE} onValueChange={(v) => onColumns(assignColumn(sheet.columns, i, v === NONE ? null : (v as MigrationField)))} disabled={disabled}>
                        <SelectTrigger
                          className={cn("mt-1.5 h-8 text-xs font-normal", current && "border-brand/50 bg-accent/40 font-medium")}
                          aria-label={`Campo da coluna ${columnLetter(i)}${header ? ` (${header})` : ""}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>— não usar —</SelectItem>
                          {FIELD_ORDER.filter((f) => f !== "day" || sheet.kind === "MONTH" || current === "day").map((f) => {
                            const elsewhere = sheet.columns[f];
                            return (
                              <SelectItem key={f} value={f}>
                                {FIELD_LABELS[f]}
                                {elsewhere !== null && elsewhere !== i ? ` (hoje na ${columnLetter(elsewhere)})` : ""}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {fields.slice(1).map((f) => (
                        <Badge key={f} variant="brand" className="mr-1 mt-1">
                          + {FIELD_LABELS[f]}
                        </Badge>
                      ))}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sheet.sample.map((row, r) => (
                <tr key={r} className="border-b last:border-0">
                  {cols.map((i) => (
                    <td key={i} className={cn("max-w-56 truncate px-3 py-2 tabular", byColumn.has(i) ? "text-foreground" : "text-muted-foreground")} title={row[i] || undefined}>
                      {row[i] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sheet.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {sheet.warnings.map((w) => (
            <li key={w} className="flex gap-1.5">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Etapa 3: colunas de cada aba de lançamentos (lista ou mês). */
export function ColumnsStep({ migration: m, onBack, onNext }: { migration: MigrationDTO; onBack: () => void; onNext: () => void }) {
  const update = useUpdateSheets(m.id);
  const busy = useMigrationBusy(m.id);
  const sheets = m.sheets.filter((s) => s.selected && usesColumns(s.kind));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">Colunas</h2>
        <p className="mt-1 text-sm text-muted-foreground">Escolha o que é cada coluna. Cada campo vale para uma coluna só: ao escolher um campo em outra coluna, ele sai da anterior.</p>
      </div>

      <div className="flex gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <ul className="min-w-0 space-y-1">
          <li>
            <strong className="text-foreground">Parcela</strong> no formato “3/10” cria a compra parcelada e as parcelas futuras (no cartão, quando houver).
          </li>
          <li>
            <strong className="text-foreground">Status</strong> “a pagar” com data futura vira conta a pagar, não lançamento.
          </li>
          <li>Linhas de total, subtotal e saldo são reconhecidas e ignoradas. A coluna Saldo ajuda a sugerir o saldo inicial das contas.</li>
        </ul>
      </div>

      {sheets.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Nenhuma aba de lista ou de mês selecionada: não há colunas a ajustar. Abas de categorias × meses são lidas pelo layout de meses.
        </Card>
      ) : (
        sheets.map((s) => (
          <SheetColumns
            key={s.index}
            sheet={s}
            disabled={busy}
            onColumns={(columns) => update.mutate([{ index: s.index, columns }])}
            onHeaderRow={(headerRowIndex) => update.mutate([{ index: s.index, headerRowIndex }])}
          />
        ))
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft aria-hidden /> Abas
        </Button>
        <Button variant="brand" onClick={onNext} disabled={busy}>
          Continuar para correspondências <ArrowRight aria-hidden />
        </Button>
      </div>
    </div>
  );
}
