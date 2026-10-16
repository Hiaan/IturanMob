"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CreditCard, Info, Landmark, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAccounts, useCards } from "@/features/finance/hooks";
import { startBulkUpload } from "./bulk-store";
import { formatFileSize, formatFromFileName } from "./helpers";
import { FormatTile } from "./status";
import { MAX_BULK_FILES, MAX_IMPORT_BYTES, MAX_IMPORT_MB, useUploadImport, type UploadOptions } from "./use-imports";
import type { ImportFormat, ImportPreview } from "./types";

const ACCEPT = ".csv,.txt,.ofx,.qfx,.xlsx,.pdf,application/pdf";

function validate(file: File): string | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "xls") return "Planilhas .xls (Excel 97-2003) não são suportadas. Salve como .xlsx ou CSV.";
  if (!formatFromFileName(file.name)) return "Formato não suportado. Envie CSV, OFX, XLSX ou PDF.";
  if (file.size > MAX_IMPORT_BYTES) return `O arquivo tem ${formatFileSize(file.size)}; o limite é ${MAX_IMPORT_MB} MB por arquivo.`;
  if (!file.size) return "O arquivo está vazio.";
  return null;
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** Etapa 1: envio de um ou vários arquivos e escolha da conta ou cartão de destino. */
export function UploadStep({ onUploaded, onBulkStarted }: { onUploaded: (preview: ImportPreview) => void; onBulkStarted?: () => void }) {
  const accounts = useAccounts();
  const cards = useCards();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<Array<{ name: string; reason: string }>>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [destination, setDestination] = useState<string>("");
  const [format, setFormat] = useState<string>("AUTO");
  const [invert, setInvert] = useState(false);
  const upload = useUploadImport(onUploaded);

  const add = (list: FileList | File[] | null | undefined) => {
    const incoming = Array.from(list ?? []);
    if (inputRef.current) inputRef.current.value = "";
    if (!incoming.length) return;
    const nextRejected: Array<{ name: string; reason: string }> = [];
    const merged = [...files];
    for (const f of incoming) {
      const err = validate(f);
      if (err) nextRejected.push({ name: f.name, reason: err });
      else if (merged.some((m) => sameFile(m, f))) continue;
      else if (merged.length >= MAX_BULK_FILES) nextRejected.push({ name: f.name, reason: `Limite de ${MAX_BULK_FILES} arquivos por importação.` });
      else merged.push(f);
    }
    setFiles(merged);
    setRejected(nextRejected);
    setFileError(null);
  };

  const remove = (f: File) => setFiles((prev) => prev.filter((x) => x !== f));

  const submit = () => {
    if (!files.length) {
      setFileError("Escolha um arquivo para importar.");
      return;
    }
    const [kind, id] = destination.split(":");
    const opts: UploadOptions = {
      accountId: kind === "acc" ? id : null,
      creditCardId: kind === "card" ? id : null,
      format: format === "AUTO" ? null : (format as ImportFormat),
      invertSigns: invert,
    };
    const [only] = files;
    if (only && files.length === 1) {
      upload.mutate({ file: only, opts });
      return;
    }
    startBulkUpload(qc, files, opts);
    onBulkStarted?.();
  };

  const activeAccounts = (accounts.data ?? []).filter((a) => !a.archivedAt);
  const activeCards = (cards.data ?? []).filter((c) => !c.archivedAt);
  const isCard = destination.startsWith("card:");
  const many = files.length > 1;
  const hasPdf = files.some((f) => formatFromFileName(f.name) === "PDF");

  return (
    <Card className="p-4 sm:p-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">1. Escolha os arquivos do extrato</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            CSV, OFX, XLSX ou PDF de extrato e de fatura, exportados pelo banco ou pelo app do cartão · até {MAX_IMPORT_MB} MB por arquivo · envie vários de uma vez (até{" "}
            {MAX_BULK_FILES}).
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
              add(e.dataTransfer.files);
            }}
            className={cn(
              "mt-4 flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-muted/30 p-4 text-center transition sm:p-6",
              dragging && "border-brand bg-accent",
              fileError && "border-destructive/60",
            )}
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
              <UploadCloud className="size-6" aria-hidden />
            </span>
            {files.length > 0 ? (
              <ul className="flex w-full max-w-md flex-col gap-1.5" aria-label="Arquivos selecionados">
                {files.map((f) => (
                  <li key={`${f.name}-${f.size}-${f.lastModified}`} className="flex min-w-0 items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 text-left text-sm shadow-xs">
                    <FormatTile format={formatFromFileName(f.name)} className="size-8" />
                    <span className="min-w-0 flex-1 truncate font-medium" title={f.name}>
                      {f.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular">{formatFileSize(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => remove(f)}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={`Remover ${f.name}`}
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">
                <span className="font-medium">Arraste um ou mais arquivos para cá</span>
                <span className="text-muted-foreground"> ou</span>
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={files.length >= MAX_BULK_FILES}>
                {files.length ? "Adicionar arquivos" : "Escolher arquivos"}
              </Button>
              {many && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setFiles([])}>
                  Remover todos
                </Button>
              )}
            </div>
            <input ref={inputRef} type="file" accept={ACCEPT} multiple className="sr-only" aria-label="Arquivos do extrato" onChange={(e) => add(e.target.files)} />
          </div>
          <p className="sr-only" aria-live="polite">
            {files.length ? `${files.length} arquivo(s) selecionado(s).` : ""}
          </p>
          {fileError && (
            <p role="alert" className="mt-2 text-sm font-medium text-destructive">
              {fileError}
            </p>
          )}
          {rejected.length > 0 && (
            <div role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-destructive">{rejected.length === 1 ? "Um arquivo não foi adicionado:" : `${rejected.length} arquivos não foram adicionados:`}</p>
                <button type="button" onClick={() => setRejected([])} className="-m-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Fechar aviso">
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {rejected.map((r, i) => (
                  <li key={`${r.name}-${i}`} className="break-words">
                    <span className="font-medium">{r.name}</span> — <span className="text-muted-foreground">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="text-[15px] font-semibold">2. Para onde vão os lançamentos?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Escolha a conta do extrato bancário ou o cartão da fatura{many ? " — vale para todos os arquivos enviados agora" : ""}.
            </p>
          </div>
          <Field
            label="Conta ou cartão de destino"
            htmlFor="imp-destination"
            hint={
              <span className={cn(hasPdf && "text-foreground")}>
                Em PDFs, o sistema tenta identificar o banco e se é extrato ou fatura, mas escolher a conta ou o cartão evita enganos.
                {destination === "none" && hasPdf ? " Sem destino, cada PDF vai para a conta ou o cartão do banco identificado (quando há só uma opção); os outros arquivos ficam sem conta." : ""}
              </span>
            }
          >
            <Select value={destination} onValueChange={setDestination}>
              <SelectTrigger id="imp-destination">
                <SelectValue placeholder={accounts.isLoading || cards.isLoading ? "Carregando…" : "Selecione a conta ou o cartão"} />
              </SelectTrigger>
              <SelectContent>
                {activeAccounts.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Contas (extrato bancário)</SelectLabel>
                    {activeAccounts.map((a) => (
                      <SelectItem key={a.id} value={`acc:${a.id}`}>
                        <span className="flex items-center gap-2">
                          <Landmark className="size-3.5 text-muted-foreground" aria-hidden /> {a.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {activeCards.length > 0 && (
                  <SelectGroup>
                    <SelectSeparator />
                    <SelectLabel>Cartões (fatura)</SelectLabel>
                    {activeCards.map((c) => (
                      <SelectItem key={c.id} value={`card:${c.id}`}>
                        <span className="flex items-center gap-2">
                          <CreditCard className="size-3.5 text-muted-foreground" aria-hidden /> {c.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                <SelectSeparator />
                <SelectItem value="none">{hasPdf ? "Automático pelo banco do PDF (senão, nenhuma)" : "Nenhuma (não altera saldos)"}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Formato" htmlFor="imp-format" hint={many ? (format === "AUTO" ? "Detectado em cada arquivo." : "O formato escolhido vale para todos os arquivos.") : undefined}>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger id="imp-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">Detectar automaticamente</SelectItem>
                <SelectItem value="CSV">CSV</SelectItem>
                <SelectItem value="OFX">OFX</SelectItem>
                <SelectItem value="XLSX">Excel (XLSX)</SelectItem>
                <SelectItem value="PDF">PDF</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-start gap-2">
            <Checkbox id="imp-invert" checked={invert} onCheckedChange={(v) => setInvert(v === true)} className="mt-0.5" />
            <div className="grid gap-1">
              <Label htmlFor="imp-invert" className="text-sm font-normal leading-snug">
                Inverter sinais dos valores
              </Label>
              <p className="text-xs text-muted-foreground">Use se as saídas aparecerem como entradas (pode ser ajustado depois).</p>
            </div>
          </div>
          <div className="flex gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              {isCard
                ? "Fatura de cartão: compras viram despesas no cartão; pagamentos e créditos da fatura são ignorados (o pagamento é registrado na conta)."
                : "Extrato bancário: valores negativos são saídas (despesas) e positivos são entradas (receitas). Pagamentos de fatura viram pagamento de cartão, não despesa. Aplicações, resgates e transferências entre contas próprias viram transferência."}{" "}
              {many ? "Com vários arquivos, cada um gera a sua prévia e você confirma todos de uma vez. " : ""}Nada é gravado antes da sua confirmação.
            </p>
          </div>
          <Button variant="brand" onClick={submit} loading={upload.isPending} disabled={!destination} className="mt-auto">
            <UploadCloud /> {many ? `Enviar ${files.length} arquivos e pré-visualizar` : "Enviar e pré-visualizar"}
          </Button>
          {!destination && <p className="-mt-2 text-xs text-muted-foreground">Selecione a conta ou o cartão para continuar.</p>}
        </div>
      </div>
    </Card>
  );
}
