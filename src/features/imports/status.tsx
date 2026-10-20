"use client";

import { AlertTriangle, CheckCircle2, CircleMinus, CirclePlus, Copy, Eye, FileSpreadsheet, FileText, Landmark, Link2, Undo2, XCircle, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ImportBatchStatus, ImportFormat, ImportRowStatus } from "./types";

type Variant = "info" | "positive" | "warning" | "muted" | "negative" | "brand";

export const ROW_STATUS: Record<ImportRowStatus, { label: string; plural: string; icon: LucideIcon; variant: Variant; help: string }> = {
  NEW: { label: "Novo", plural: "Novos", icon: CirclePlus, variant: "info", help: "Não existe no app: será criado como lançamento ao confirmar (se selecionado)." },
  MATCHED: { label: "Já registrado", plural: "Correspondentes", icon: Link2, variant: "positive", help: "Já existe no app (mesmo valor, até 3 dias de diferença). Será apenas vinculado, sem duplicar." },
  DIVERGENT: { label: "Divergente", plural: "Divergentes", icon: AlertTriangle, variant: "warning", help: "Parece um lançamento do app, mas com valor diferente (até 30%). Vira uma pendência para revisão." },
  DUPLICATE: { label: "Duplicado", plural: "Duplicados", icon: Copy, variant: "muted", help: "Esta linha já foi importada antes nesta conta ou cartão. Não será importada novamente." },
  SKIPPED: { label: "Ignorado", plural: "Ignorados", icon: CircleMinus, variant: "muted", help: "Linha de saldo, valor zero ou pagamento/crédito de fatura — não é um gasto ou receita." },
  ERROR: { label: "Erro", plural: "Com erro", icon: XCircle, variant: "negative", help: "Data ou valor não puderam ser lidos. Ajuste o mapeamento de colunas." },
  IMPORTED: { label: "Importado", plural: "Importados", icon: CheckCircle2, variant: "positive", help: "Lançamento criado por esta importação." },
};

export const ROW_STATUS_ORDER: ImportRowStatus[] = ["NEW", "MATCHED", "DIVERGENT", "DUPLICATE", "SKIPPED", "ERROR", "IMPORTED"];

export function RowStatusBadge({ status }: { status: ImportRowStatus }) {
  const meta = ROW_STATUS[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} title={meta.help}>
      <Icon aria-hidden /> {meta.label}
    </Badge>
  );
}

const BATCH_STATUS: Record<ImportBatchStatus, { label: string; icon: LucideIcon; variant: Variant }> = {
  PREVIEW: { label: "Em revisão", icon: Eye, variant: "info" },
  IMPORTED: { label: "Importado", icon: CheckCircle2, variant: "positive" },
  UNDONE: { label: "Desfeito", icon: Undo2, variant: "muted" },
  FAILED: { label: "Falhou", icon: XCircle, variant: "negative" },
};

export function BatchStatusBadge({ status }: { status: ImportBatchStatus }) {
  const meta = BATCH_STATUS[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon aria-hidden /> {meta.label}
    </Badge>
  );
}

export const FORMAT_META: Record<ImportFormat, { label: string; short: string; icon: LucideIcon; tone: string; tag: string }> = {
  CSV: { label: "CSV", short: "CSV", icon: FileText, tone: "bg-muted text-muted-foreground", tag: "text-muted-foreground" },
  OFX: { label: "OFX", short: "OFX", icon: Landmark, tone: "bg-info/10 text-info", tag: "text-info" },
  XLSX: { label: "Excel (XLSX)", short: "XLSX", icon: FileSpreadsheet, tone: "bg-positive/10 text-positive", tag: "text-positive" },
  XLS: { label: "Excel 97–2003 (XLS)", short: "XLS", icon: FileSpreadsheet, tone: "bg-positive/10 text-positive", tag: "text-positive" },
  ODS: { label: "OpenDocument (ODS)", short: "ODS", icon: FileSpreadsheet, tone: "bg-info/10 text-info", tag: "text-info" },
  PDF: { label: "PDF", short: "PDF", icon: FileText, tone: "bg-negative/10 text-negative", tag: "text-negative" },
  OPEN_FINANCE: { label: "Banco (Open Finance)", short: "Banco", icon: Landmark, tone: "bg-brand/10 text-brand", tag: "text-brand" },
};

export function formatLabel(format: ImportFormat | string): string {
  return FORMAT_META[format as ImportFormat]?.label ?? format;
}

/** Ícone do arquivo com a etiqueta do formato (CSV, OFX, XLSX, XLS, ODS, PDF). */
export function FormatTile({ format, className }: { format: ImportFormat | null; className?: string }) {
  const meta = format ? FORMAT_META[format] : null;
  const Icon = meta?.icon ?? FileText;
  return (
    <span className={cn("relative flex size-9 shrink-0 items-center justify-center rounded-lg", meta?.tone ?? "bg-muted text-muted-foreground", className)} aria-hidden>
      <Icon className="size-4" />
      {meta && (
        <span className={cn("absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded border bg-card px-1 text-[9px] font-bold leading-3.5 tracking-wide", meta.tag)}>{meta.short}</span>
      )}
    </span>
  );
}
