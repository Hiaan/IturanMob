"use client";

import { useMemo, useState } from "react";
import { Columns3, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRemap } from "./use-imports";
import type { ColumnMapping, DateFormat, ImportPreview } from "./types";

const NONE = "none";
type FieldKey = "date" | "description" | "amount" | "debit" | "credit" | "category" | "externalId";

const FIELD_LABELS: Record<FieldKey, string> = {
  date: "Data",
  description: "Descrição",
  amount: "Valor",
  debit: "Débito",
  credit: "Crédito",
  category: "Categoria",
  externalId: "Identificador",
};

const EMPTY: ColumnMapping = { date: null, description: null, amount: null, debit: null, credit: null, category: null, externalId: null, dateFormat: "auto" };

function ColumnSelect({ id, value, onChange, headers, optional }: { id: string; value: number | null; onChange: (v: number | null) => void; headers: string[]; optional?: boolean }) {
  return (
    <Select value={value === null ? NONE : String(value)} onValueChange={(v) => onChange(v === NONE ? null : Number(v))}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Escolha a coluna" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{optional ? "— Não usar" : "— Selecione"}</SelectItem>
        {headers.map((h, i) => (
          <SelectItem key={`${h}-${i}`} value={String(i)}>
            {String.fromCharCode(65 + (i % 26))} · {h}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Mapeamento de colunas (CSV/XLSX) com pré-visualização das primeiras linhas. */
export function MappingPanel({ preview, onApplied }: { preview: ImportPreview; onApplied?: () => void }) {
  const headers = preview.headers;
  const [mapping, setMapping] = useState<ColumnMapping>({ ...EMPTY, ...(preview.mapping ?? {}) });
  const [splitAmount, setSplitAmount] = useState(Boolean(preview.mapping && preview.mapping.amount === null && (preview.mapping.debit !== null || preview.mapping.credit !== null)));
  const [headerRow, setHeaderRow] = useState<string>("keep");
  const [invert, setInvert] = useState(preview.invertSigns);
  const remap = useRemap(preview.batch.id, onApplied);

  const set = (key: FieldKey, v: number | null) => setMapping((m) => ({ ...m, [key]: v }));
  const problems: string[] = [];
  if (headerRow === "keep") {
    if (mapping.date === null) problems.push("Indique a coluna de data.");
    if (!splitAmount && mapping.amount === null) problems.push("Indique a coluna de valor.");
    if (splitAmount && mapping.debit === null && mapping.credit === null) problems.push("Indique as colunas de débito e/ou crédito.");
  }

  const roleByColumn = useMemo(() => {
    const map = new Map<number, string[]>();
    (Object.keys(FIELD_LABELS) as FieldKey[]).forEach((k) => {
      if (splitAmount ? k === "amount" : k === "debit" || k === "credit") return;
      const col = mapping[k];
      if (col === null || col === undefined) return;
      map.set(col, [...(map.get(col) ?? []), FIELD_LABELS[k]]);
    });
    return map;
  }, [mapping, splitAmount]);

  const sample = preview.rows.slice(0, 6);

  const apply = () => {
    if (headerRow !== "keep") {
      remap.mutate({ headerRowIndex: Number(headerRow), invertSigns: invert });
      return;
    }
    const body: ColumnMapping = splitAmount ? { ...mapping, amount: null } : { ...mapping, debit: null, credit: null };
    remap.mutate({ mapping: body, invertSigns: invert });
  };

  return (
    <Card className="p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <Columns3 className="size-4 text-muted-foreground" aria-hidden /> Mapeamento de colunas
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Confira quais colunas do arquivo correspondem à data, descrição e valor. A prévia é recalculada ao aplicar.</p>
        </div>
        <Badge variant="muted">{headers.length} coluna(s)</Badge>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Field label="Data" htmlFor="map-date" required>
          <ColumnSelect id="map-date" value={mapping.date} onChange={(v) => set("date", v)} headers={headers} />
        </Field>
        <Field label="Descrição" htmlFor="map-desc">
          <ColumnSelect id="map-desc" value={mapping.description} onChange={(v) => set("description", v)} headers={headers} optional />
        </Field>
        <Field label="Formato da data" htmlFor="map-datefmt">
          <Select value={mapping.dateFormat} onValueChange={(v) => setMapping((m) => ({ ...m, dateFormat: v as DateFormat }))}>
            <SelectTrigger id="map-datefmt">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automático</SelectItem>
              <SelectItem value="dmy">Dia/mês/ano (31/12/2026)</SelectItem>
              <SelectItem value="ymd">Ano-mês-dia (2026-12-31)</SelectItem>
              <SelectItem value="mdy">Mês/dia/ano (12/31/2026)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-1.5 md:col-span-2 xl:col-span-3">
          <Label className="text-[13px]">Como os valores aparecem?</Label>
          <Tabs value={splitAmount ? "split" : "single"} onValueChange={(v) => setSplitAmount(v === "split")}>
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="single">Uma coluna (com sinal)</TabsTrigger>
              <TabsTrigger value="split">Débito e crédito separados</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {splitAmount ? (
          <>
            <Field label="Débito (saídas)" htmlFor="map-debit">
              <ColumnSelect id="map-debit" value={mapping.debit} onChange={(v) => set("debit", v)} headers={headers} optional />
            </Field>
            <Field label="Crédito (entradas)" htmlFor="map-credit">
              <ColumnSelect id="map-credit" value={mapping.credit} onChange={(v) => set("credit", v)} headers={headers} optional />
            </Field>
          </>
        ) : (
          <Field label="Valor" htmlFor="map-amount" required>
            <ColumnSelect id="map-amount" value={mapping.amount} onChange={(v) => set("amount", v)} headers={headers} />
          </Field>
        )}
        <Field label="Categoria (opcional)" htmlFor="map-cat" hint="Nomes iguais aos das suas categorias são reconhecidos.">
          <ColumnSelect id="map-cat" value={mapping.category} onChange={(v) => set("category", v)} headers={headers} optional />
        </Field>
        <Field label="Identificador (opcional)" htmlFor="map-id" hint="Número do documento; ajuda a evitar duplicidade.">
          <ColumnSelect id="map-id" value={mapping.externalId} onChange={(v) => set("externalId", v)} headers={headers} optional />
        </Field>
        <Field label="Linha do cabeçalho" htmlFor="map-header" hint="Mude se o banco incluir linhas de identificação antes dos títulos.">
          <Select value={headerRow} onValueChange={setHeaderRow}>
            <SelectTrigger id="map-header">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="keep">
                {preview.headerRowIndex === null || preview.headerRowIndex < 0 ? "Atual: sem cabeçalho" : `Atual: linha ${preview.headerRowIndex + 1}`}
              </SelectItem>
              <SelectItem value="-1">Arquivo sem cabeçalho</SelectItem>
              {Array.from({ length: 10 }, (_, i) => (
                <SelectItem key={i} value={String(i)}>
                  Linha {i + 1} (detectar colunas de novo)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border p-3">
        <div className="grid gap-1">
          <Label htmlFor="map-invert" className="text-sm">
            Inverter sinais
          </Label>
          <p className="text-xs text-muted-foreground">Saídas devem ficar negativas; ative se o arquivo mostrar o contrário.</p>
        </div>
        <Switch id="map-invert" checked={invert} onCheckedChange={setInvert} />
      </div>

      <div className="mt-5">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Primeiras linhas do arquivo</p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                {headers.map((h, i) => {
                  const roles = roleByColumn.get(i);
                  return (
                    <th key={`${h}-${i}`} scope="col" className="px-3 py-2 text-left align-top font-medium">
                      <span className="block text-[11px] text-muted-foreground">Coluna {String.fromCharCode(65 + (i % 26))}</span>
                      <span className="block max-w-48 truncate">{h}</span>
                      {roles?.map((r) => (
                        <Badge key={r} variant="brand" className="mt-1 mr-1">
                          {r}
                        </Badge>
                      ))}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sample.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  {headers.map((h, i) => (
                    <td key={`${h}-${i}`} className="max-w-56 truncate px-3 py-2 text-muted-foreground tabular">
                      {r.cells[h] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {problems.length > 0 && (
        <p role="alert" className="mt-3 text-sm font-medium text-destructive">
          {problems.join(" ")}
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={apply} loading={remap.isPending} disabled={problems.length > 0}>
          <RefreshCw /> Aplicar e reprocessar
        </Button>
      </div>
    </Card>
  );
}
