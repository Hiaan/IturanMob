"use client";

import { useRef, useState } from "react";
import { CreditCard, FileUp, Info, Landmark, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAccounts, useCards } from "@/features/finance/hooks";
import { MAX_IMPORT_BYTES, useUploadImport } from "./use-imports";
import type { ImportPreview } from "./types";

const ACCEPT = ".csv,.txt,.ofx,.qfx,.xlsx";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

function validate(file: File): string | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "xls") return "Planilhas .xls (Excel 97-2003) não são suportadas. Salve como .xlsx ou CSV.";
  if (!["csv", "txt", "ofx", "qfx", "xlsx"].includes(ext)) return "Formato não suportado. Envie um arquivo CSV, OFX ou XLSX.";
  if (file.size > MAX_IMPORT_BYTES) return `O arquivo tem ${formatSize(file.size)}; o limite é 5 MB.`;
  if (!file.size) return "O arquivo está vazio.";
  return null;
}

/** Etapa 1: envio do arquivo e escolha da conta ou cartão de destino. */
export function UploadStep({ onUploaded }: { onUploaded: (preview: ImportPreview) => void }) {
  const accounts = useAccounts();
  const cards = useCards();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [destination, setDestination] = useState<string>("");
  const [format, setFormat] = useState<string>("AUTO");
  const [invert, setInvert] = useState(false);
  const upload = useUploadImport(onUploaded);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    const err = validate(f);
    setFileError(err);
    setFile(err ? null : f);
  };

  const submit = () => {
    if (!file) {
      setFileError("Escolha um arquivo para importar.");
      return;
    }
    const [kind, id] = destination.split(":");
    upload.mutate({
      file,
      opts: {
        accountId: kind === "acc" ? id : null,
        creditCardId: kind === "card" ? id : null,
        format: format === "AUTO" ? null : (format as "CSV" | "OFX" | "XLSX"),
        invertSigns: invert,
      },
    });
  };

  const activeAccounts = (accounts.data ?? []).filter((a) => !a.archivedAt);
  const activeCards = (cards.data ?? []).filter((c) => !c.archivedAt);
  const isCard = destination.startsWith("card:");

  return (
    <Card className="p-4 sm:p-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div>
          <h2 className="text-[15px] font-semibold">1. Escolha o arquivo do extrato</h2>
          <p className="mt-1 text-sm text-muted-foreground">CSV, OFX ou XLSX exportado pelo banco ou pelo app do cartão · até 5 MB e 5.000 linhas.</p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "mt-4 flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed bg-muted/30 p-6 text-center transition",
              dragging && "border-brand bg-accent",
              fileError && "border-destructive/60",
            )}
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
              <UploadCloud className="size-6" aria-hidden />
            </span>
            {file ? (
              <div className="flex max-w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-xs">
                <FileUp className="size-4 shrink-0 text-brand" aria-hidden />
                <span className="truncate font-medium">{file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatSize(file.size)}</span>
                <button
                  type="button"
                  onClick={() => {
                    setFile(null);
                    if (inputRef.current) inputRef.current.value = "";
                  }}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Remover arquivo"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <p className="text-sm">
                <span className="font-medium">Arraste o arquivo para cá</span>
                <span className="text-muted-foreground"> ou</span>
              </p>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              {file ? "Trocar arquivo" : "Escolher arquivo"}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              aria-label="Arquivo do extrato"
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </div>
          {fileError && (
            <p role="alert" className="mt-2 text-sm font-medium text-destructive">
              {fileError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-[15px] font-semibold">2. Para onde vão os lançamentos?</h2>
            <p className="mt-1 text-sm text-muted-foreground">Escolha a conta do extrato bancário ou o cartão da fatura.</p>
          </div>
          <Field label="Conta ou cartão de destino" htmlFor="imp-destination">
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
                <SelectItem value="none">Nenhuma (não altera saldos)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Formato" htmlFor="imp-format">
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger id="imp-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">Detectar automaticamente</SelectItem>
                <SelectItem value="CSV">CSV</SelectItem>
                <SelectItem value="OFX">OFX</SelectItem>
                <SelectItem value="XLSX">Excel (XLSX)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-start gap-2">
            <Checkbox id="imp-invert" checked={invert} onCheckedChange={(v) => setInvert(v === true)} className="mt-0.5" />
            <Label htmlFor="imp-invert" className="text-sm font-normal leading-snug">
              Inverter sinais dos valores
              <span className="block text-xs text-muted-foreground">Use se as saídas aparecerem como entradas (pode ser ajustado depois).</span>
            </Label>
          </div>
          <div className="flex gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              {isCard
                ? "Fatura de cartão: compras viram despesas no cartão; pagamentos e créditos da fatura são ignorados (o pagamento é registrado na conta)."
                : "Extrato bancário: valores negativos são saídas (despesas) e positivos são entradas (receitas). Pagamentos de fatura viram pagamento de cartão, não despesa."}{" "}
              Nada é gravado antes da sua confirmação.
            </p>
          </div>
          <Button variant="brand" onClick={submit} loading={upload.isPending} disabled={!destination} className="mt-auto">
            <UploadCloud /> Enviar e pré-visualizar
          </Button>
          {!destination && <p className="-mt-2 text-xs text-muted-foreground">Selecione a conta ou o cartão para continuar.</p>}
        </div>
      </div>
    </Card>
  );
}
