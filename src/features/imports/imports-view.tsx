"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Columns3, CreditCard, FileText, Info, Landmark, Plus, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";
import { BatchStatusBadge } from "./status";
import { UploadStep } from "./upload-step";
import { MappingPanel } from "./mapping-panel";
import { ReviewStep } from "./review-step";
import { ReconciliationStep } from "./reconciliation-step";
import { ImportHistory } from "./import-history";
import { useImportPreview } from "./use-imports";
import type { ImportPreview } from "./types";

type StepId = "upload" | "mapping" | "review" | "reconcile";

function Stepper({ current, hasMapping }: { current: StepId; hasMapping: boolean }) {
  const steps: Array<{ id: StepId; label: string }> = [
    { id: "upload", label: "Enviar arquivo" },
    ...(hasMapping ? [{ id: "mapping" as const, label: "Mapear colunas" }] : []),
    { id: "review", label: "Revisar" },
    { id: "reconcile", label: "Conciliar" },
  ];
  const idx = steps.findIndex((s) => s.id === current);
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Etapas da importação">
      {steps.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li key={s.id} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs font-semibold",
                done && "border-brand bg-brand text-brand-foreground",
                active && "border-brand text-brand",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span className={cn("text-sm", active ? "font-semibold" : "text-muted-foreground")}>{s.label}</span>
            {i < steps.length - 1 && <span className="mx-1 hidden h-px w-8 bg-border sm:block" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function BatchHeader({ preview }: { preview: ImportPreview }) {
  const b = preview.batch;
  const DestIcon = b.creditCard ? CreditCard : Landmark;
  return (
    <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <FileText className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{b.fileName}</span>
            <Badge variant="outline">{b.format}</Badge>
            <BatchStatusBadge status={b.status} />
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <DestIcon className="size-3.5" aria-hidden /> {b.account?.name ?? b.creditCard?.name ?? "Sem conta ou cartão"}
            </span>
            {b.statement && (
              <>
                · <span>{b.statement.kind === "CREDIT_CARD" ? "Fatura de cartão" : "Extrato bancário"}</span>
                {b.statement.accountIdMasked && <span>· conta {b.statement.accountIdMasked}</span>}
                {b.statement.startDate && b.statement.endDate && (
                  <span>
                    · {formatDateBR(b.statement.startDate)} a {formatDateBR(b.statement.endDate)}
                  </span>
                )}
                {b.statement.ledgerBalanceCents !== null && <span>· saldo informado {formatBRL(b.statement.ledgerBalanceCents)}</span>}
              </>
            )}
            {preview.cardPurchasesPositive !== null && <span>· compras {preview.cardPurchasesPositive ? "positivas" : "negativas"} no arquivo (ajustado)</span>}
          </p>
        </div>
      </div>
    </Card>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div role="status" className="space-y-2">
      {warnings.map((w) => {
        const strong = /já foi importado|Ajuste o mapeamento|Nenhuma conta/i.test(w);
        return (
          <div key={w} className={cn("flex gap-2 rounded-lg border p-3 text-sm", strong ? "border-warning/30 bg-warning/5" : "bg-muted/40")}>
            {strong ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <p>{w}</p>
          </div>
        );
      })}
    </div>
  );
}

function PreviewFlow({ preview, onCommitted, onNewImport }: { preview: ImportPreview; onCommitted: () => void; onNewImport: () => void }) {
  const tabular = preview.batch.format !== "OFX";
  const mappingBroken = tabular && (preview.counts.ERROR === preview.counts.total || preview.batch.warnings.some((w) => /mapeamento/i.test(w)));
  const [showMapping, setShowMapping] = useState(mappingBroken);
  const mappingKey = JSON.stringify([preview.mapping, preview.headerRowIndex, preview.invertSigns, preview.headers]);

  if (preview.batch.status !== "PREVIEW") {
    return (
      <>
        <Stepper current="reconcile" hasMapping={tabular} />
        <div className="space-y-4">
          <BatchHeader preview={preview} />
          <ReconciliationStep preview={preview} onNewImport={onNewImport} />
        </div>
      </>
    );
  }

  return (
    <>
      <Stepper current={showMapping || mappingBroken ? "mapping" : "review"} hasMapping={tabular} />
      <div className="space-y-4">
        <BatchHeader preview={preview} />
        <Warnings warnings={preview.batch.warnings} />
        {tabular && (
          <div>
            {!showMapping && !mappingBroken ? (
              <Button variant="outline" size="sm" onClick={() => setShowMapping(true)}>
                <Columns3 /> Ajustar mapeamento de colunas <ChevronDown />
              </Button>
            ) : (
              <MappingPanel key={mappingKey} preview={preview} onApplied={() => setShowMapping(false)} />
            )}
          </div>
        )}
        {!tabular && (
          <p className="text-xs text-muted-foreground">
            Sinais invertidos?{" "}
            <span className="text-foreground">Envie o arquivo de novo marcando “Inverter sinais”.</span> Arquivos OFX não precisam de mapeamento de colunas.
          </p>
        )}
        {!mappingBroken && <ReviewStep preview={preview} onCommitted={onCommitted} />}
      </div>
    </>
  );
}

export function ImportsView() {
  const router = useRouter();
  const params = useSearchParams();
  const batchId = params.get("batch");
  const me = useMe();
  const timezone = me.data?.household.timezone;
  const preview = useImportPreview(batchId);

  const open = (id: string | null) => {
    router.replace(id ? `/importacao?batch=${id}` : "/importacao", { scroll: false });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="pb-4">
      <PageHeader
        title="Importação de extratos"
        description="Traga extratos bancários e faturas de cartão (CSV, OFX ou Excel), revise antes de gravar e concilie com o que já foi registrado."
        actions={
          batchId ? (
            <Button variant="outline" onClick={() => open(null)}>
              <Plus /> Nova importação
            </Button>
          ) : undefined
        }
      />

      {!batchId ? (
        <>
          <Stepper current="upload" hasMapping />
          <UploadStep onUploaded={(p) => open(p.batch.id)} />
        </>
      ) : preview.isLoading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Carregando importação">
          <Skeleton className="h-8 w-80 rounded-lg" />
          <Skeleton className="h-20 rounded-xl" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : preview.error || !preview.data ? (
        <ErrorState error={preview.error ?? new Error("Importação não encontrada.")} onRetry={() => preview.refetch()} />
      ) : (
        <PreviewFlow key={preview.data.batch.id} preview={preview.data} onCommitted={() => window.scrollTo({ top: 0, behavior: "smooth" })} onNewImport={() => open(null)} />
      )}

      <div className="mt-8">
        <ImportHistory activeId={batchId} onOpen={(id) => open(id)} timezone={timezone} />
      </div>
    </div>
  );
}
