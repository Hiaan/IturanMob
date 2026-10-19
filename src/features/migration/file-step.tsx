"use client";

import { useRef, useState } from "react";
import { CalendarRange, Download, FileSpreadsheet, Grid3x3, ListChecks, ShieldCheck, Undo2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatFileSize } from "@/features/imports/helpers";
import { FormatTile } from "@/features/imports/status";
import type { MigrationDTO, SheetFormat } from "@/server/modules/migration/types";
import { MIGRATION_MAX_BYTES, MIGRATION_MAX_MB, MIGRATION_MODEL_URL, useUploadMigration } from "./use-migration";

const ACCEPT =
  ".xlsx,.xls,.ods,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.oasis.opendocument.spreadsheet,text/csv";

function formatOf(name: string): SheetFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "xlsx") return "XLSX";
  if (ext === "xls") return "XLS";
  if (ext === "ods") return "ODS";
  if (ext === "csv") return "CSV";
  return null;
}

function validate(file: File): string | null {
  if (!formatOf(file.name)) return "Formato não suportado. Envie uma planilha .xlsx, .xls, .ods ou .csv.";
  if (file.size > MIGRATION_MAX_BYTES) return `A planilha tem ${formatFileSize(file.size)}; o limite é ${MIGRATION_MAX_MB} MB.`;
  if (!file.size) return "O arquivo está vazio.";
  return null;
}

const RECOGNIZED = [
  { icon: ListChecks, text: "Listas de lançamentos (data, descrição, valor, categoria, conta, cartão, parcela…)" },
  { icon: CalendarRange, text: "Uma aba por mês (“Janeiro”, “Fev/25”…), com dia ou data" },
  { icon: Grid3x3, text: "Categorias × meses: vira orçamento ou totais mensais, você escolhe" },
  { icon: FileSpreadsheet, text: "Abas de resumo, gráficos e linhas de total são ignoradas" },
];

/** Etapa 1: envio da planilha. */
export function UploadCard({ onUploaded, title = "Envie a sua planilha" }: { onUploaded: (dto: MigrationDTO) => void; title?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useUploadMigration(onUploaded);

  const pick = (list: FileList | null | undefined) => {
    const f = list?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (!f) return;
    const err = validate(f);
    setError(err);
    setFile(err ? null : f);
  };

  const submit = () => {
    if (!file) {
      setError("Escolha a planilha para enviar.");
      return;
    }
    upload.mutate(file);
  };

  return (
    <Card className="p-4 sm:p-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Excel (.xlsx ou .xls), OpenDocument (.ods) ou CSV · até {MIGRATION_MAX_MB} MB · todas as abas são lidas de uma vez.
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files);
            }}
            className={cn(
              "mt-4 flex min-h-44 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-muted/30 p-4 text-center transition sm:p-6",
              dragging && "border-brand bg-accent",
              error && "border-destructive/60",
            )}
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
              <UploadCloud className="size-6" aria-hidden />
            </span>
            {file ? (
              <div className="flex w-full max-w-md min-w-0 items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 text-left text-sm shadow-xs">
                <FormatTile format={formatOf(file.name)} className="size-8" />
                <span className="min-w-0 flex-1 truncate font-medium" title={file.name}>
                  {file.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular">{formatFileSize(file.size)}</span>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  disabled={upload.isPending}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  aria-label={`Remover ${file.name}`}
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ) : (
              <p className="text-sm">
                <span className="font-medium">Arraste a planilha para cá</span>
                <span className="text-muted-foreground"> ou</span>
              </p>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
              {file ? "Trocar arquivo" : "Escolher arquivo"}
            </Button>
            <input ref={inputRef} type="file" accept={ACCEPT} className="sr-only" aria-label="Planilha para migrar" onChange={(e) => pick(e.target.files)} />
          </div>
          <p className="sr-only" aria-live="polite">
            {file ? `Arquivo selecionado: ${file.name}.` : ""}
          </p>
          {error && (
            <p role="alert" className="mt-2 text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="text-[15px] font-semibold">O que o app reconhece</h2>
            <ul className="mt-2 space-y-2 text-sm">
              {RECOGNIZED.map(({ icon: Icon, text }) => (
                <li key={text} className="flex gap-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0">{text}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Nada é gravado antes da sua confirmação: você confere abas, colunas e o “De → Para” das categorias, contas e cartões, vê a prévia e só então importa.{" "}
              <Undo2 className="inline size-3.5 align-text-bottom" aria-hidden /> Dá para desfazer a migração inteira depois.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Prefere começar organizado? Baixe a planilha modelo, copie seus dados para ela e envie — o app reconhece tudo de primeira.
          </p>
          <div className="mt-auto flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
            <Button asChild variant="outline" className="sm:flex-1">
              <a href={MIGRATION_MODEL_URL} download>
                <Download aria-hidden /> Baixar planilha modelo
              </a>
            </Button>
            <Button variant="brand" onClick={submit} loading={upload.isPending} disabled={!file} className="sm:flex-1">
              <UploadCloud aria-hidden /> Enviar e interpretar
            </Button>
          </div>
          {!file && <p className="-mt-2 text-xs text-muted-foreground">Escolha a planilha para continuar.</p>}
        </div>
      </div>
    </Card>
  );
}
