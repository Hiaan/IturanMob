"use client";

import { AlertTriangle, CheckCircle2, CircleMinus, CirclePlus, Copy, Eye, Link2, Undo2, XCircle, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ImportBatchStatus, ImportRowStatus } from "./types";

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
