"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Columns3, CreditCard, Landmark, Layers, Plus, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { useMe } from "@/features/me/use-me";
import { BatchStatusBadge, FormatTile, formatLabel } from "./status";
import { Stepper, type StepDef } from "./stepper";
import { Warnings } from "./warnings";
import { UploadStep } from "./upload-step";
import { MappingPanel } from "./mapping-panel";
import { ReviewStep } from "./review-step";
import { ReconciliationStep } from "./reconciliation-step";
import { ImportHistory } from "./import-history";
import { BulkImport } from "./bulk-import";
import { clearBulkSession, isBulkUploading, useBulkSession } from "./bulk-store";
import { bankLabel, isTabularFormat, needsMappingReview, statementKindLabel } from "./helpers";
import { useImportPreview } from "./use-imports";
import type { ImportPreview } from "./types";

type StepId = "upload" | "mapping" | "review" | "reconcile";

function singleSteps(hasMapping: boolean): StepDef[] {
  return [
    { id: "upload", label: "Enviar arquivo" },
    ...(hasMapping ? [{ id: "mapping", label: "Mapear colunas" }] : []),
    { id: "review", label: "Revisar" },
    { id: "reconcile", label: "Conciliar" },
  ];
}

function SingleStepper({ current, hasMapping }: { current: StepId; hasMapping: boolean }) {
  return <Stepper steps={singleSteps(hasMapping)} current={current} />;
}

function BatchHeader({ preview }: { preview: ImportPreview }) {
  const b = preview.batch;
  const DestIcon = b.creditCard ? CreditCard : Landmark;
  const kind = statementKindLabel(b.statement);
  const bank = bankLabel(b);
  return (
    <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <FormatTile format={b.format} className="size-10 rounded-xl" />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{b.fileName}</span>
            <Badge variant="outline">{formatLabel(b.format)}</Badge>
            {b.statement?.source === "AI" && (
              <Badge variant="info" title="PDF digitalizado: os lançamentos foram lidos pela IA. Confira valores e datas.">
                <Sparkles aria-hidden /> Lido por IA
              </Badge>
            )}
            <BatchStatusBadge status={b.status} />
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <DestIcon className="size-3.5" aria-hidden /> {b.account?.name ?? b.creditCard?.name ?? "Sem conta ou cartão"}
            </span>
            {b.statement && (
              <>
                {kind && <span>· {kind}</span>}
                {bank && <span>· {bank}</span>}
                {b.statement.accountIdMasked && <span>· conta {b.statement.accountIdMasked}</span>}
                {b.statement.startDate && b.statement.endDate && (
                  <span>
                    · {formatDateBR(b.statement.startDate)} a {formatDateBR(b.statement.endDate)}
                  </span>
                )}
                {b.statement.ledgerBalanceCents !== null && b.statement.ledgerBalanceCents !== undefined && (
                  <span>· saldo informado {formatBRL(b.statement.ledgerBalanceCents)}</span>
                )}
              </>
            )}
            {preview.cardPurchasesPositive !== null && <span>· compras {preview.cardPurchasesPositive ? "positivas" : "negativas"} no arquivo (ajustado)</span>}
          </p>
        </div>
      </div>
    </Card>
  );
}

function PreviewFlow({ preview, onCommitted, onNewImport }: { preview: ImportPreview; onCommitted: () => void; onNewImport: () => void }) {
  const tabular = isTabularFormat(preview.batch.format);
  const mappingBroken = needsMappingReview(preview);
  const [showMapping, setShowMapping] = useState(mappingBroken);
  const mappingKey = JSON.stringify([preview.mapping, preview.headerRowIndex, preview.invertSigns, preview.headers]);

  if (preview.batch.status !== "PREVIEW") {
    return (
      <>
        <SingleStepper current="reconcile" hasMapping={tabular} />
        <div className="space-y-4">
          <BatchHeader preview={preview} />
          <ReconciliationStep preview={preview} onNewImport={onNewImport} />
        </div>
      </>
    );
  }

  return (
    <>
      <SingleStepper current={showMapping || mappingBroken ? "mapping" : "review"} hasMapping={tabular} />
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
            <span className="text-foreground">Envie o arquivo de novo marcando “Inverter sinais”.</span> Arquivos {formatLabel(preview.batch.format)} não precisam de mapeamento de colunas.
          </p>
        )}
        {!mappingBroken && <ReviewStep preview={preview} onCommitted={onCommitted} />}
      </div>
    </>
  );
}

/** Aviso exibido na revisão de um arquivo que faz parte de um lote com vários arquivos. */
function LotBanner({ position, total, state, onBack }: { position: number; total: number; state: "mapping" | "review" | "done"; onBack: () => void }) {
  return (
    <Card className="mb-4 flex flex-col gap-3 border-brand/30 bg-accent/40 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Layers className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 text-sm">
          <p className="font-semibold">
            Arquivo {position} de {total} do lote
          </p>
          <p className="text-xs text-muted-foreground">
            {state === "mapping"
              ? "Ajuste o mapeamento de colunas abaixo. Depois de aplicar, o arquivo entra no “Confirmar todos” do lote."
              : state === "review"
                ? "Revise o que quiser (seleção, categorias). Você pode confirmar só este arquivo aqui ou voltar e confirmar todos de uma vez."
                : "Este arquivo já saiu da revisão. Volte ao lote para acompanhar os demais."}
          </p>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onBack} className="shrink-0">
        <Layers /> Voltar ao lote
      </Button>
    </Card>
  );
}

export function ImportsView() {
  const router = useRouter();
  const params = useSearchParams();
  const batchId = params.get("batch");
  const me = useMe();
  const timezone = me.data?.household.timezone;
  const preview = useImportPreview(batchId);
  const bulk = useBulkSession();
  const uploading = isBulkUploading(bulk);
  const lotIndex = batchId && bulk ? bulk.items.findIndex((i) => i.batchId === batchId) : -1;

  const open = (id: string | null) => {
    router.replace(id ? `/importacao?batch=${id}` : "/importacao", { scroll: false });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const startOver = () => {
    clearBulkSession();
    open(null);
  };

  const newImportButton = (
    <Button variant="outline" onClick={startOver} disabled={uploading} title={uploading ? "Aguarde o envio dos arquivos do lote terminar" : undefined}>
      <Plus /> Nova importação
    </Button>
  );

  return (
    <div className="pb-4">
      <PageHeader
        title="Importação de extratos"
        description="Traga extratos bancários e faturas de cartão (CSV, OFX, Excel ou PDF) — um ou vários arquivos de uma vez —, revise antes de gravar e concilie com o que já foi registrado."
        actions={
          batchId ? (
            <>
              {bulk && lotIndex < 0 && (
                <Button variant="outline" onClick={() => open(null)}>
                  <Layers /> Voltar ao lote
                </Button>
              )}
              {newImportButton}
            </>
          ) : bulk ? (
            newImportButton
          ) : undefined
        }
      />

      {!batchId ? (
        bulk ? (
          <BulkImport session={bulk} />
        ) : (
          <>
            <SingleStepper current="upload" hasMapping />
            <UploadStep onUploaded={(p) => open(p.batch.id)} onBulkStarted={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
          </>
        )
      ) : preview.isLoading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Carregando importação">
          <Skeleton className="h-8 w-full max-w-80 rounded-lg" />
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
        <>
          {bulk && lotIndex >= 0 && (
            <LotBanner
              position={lotIndex + 1}
              total={bulk.items.length}
              state={preview.data.batch.status !== "PREVIEW" ? "done" : needsMappingReview(preview.data) ? "mapping" : "review"}
              onBack={() => open(null)}
            />
          )}
          <PreviewFlow key={preview.data.batch.id} preview={preview.data} onCommitted={() => window.scrollTo({ top: 0, behavior: "smooth" })} onNewImport={startOver} />
        </>
      )}

      <div className="mt-8">
        <ImportHistory activeId={batchId} onOpen={(id) => open(id)} timezone={timezone} />
      </div>
    </div>
  );
}
