"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { ReviewStep } from "@/features/imports/review-step";
import { Warnings } from "@/features/imports/warnings";
import { isNatureWarning, isTransferWarning } from "@/features/imports/helpers";
import { useImportPreview } from "@/features/imports/use-imports";
import type { MigrationDestinationDTO } from "@/server/modules/migration/types";
import { migrationKeys } from "./use-migration";

function BatchRows({ batchId }: { batchId: string }) {
  const preview = useImportPreview(batchId);
  if (preview.isLoading)
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Carregando linhas">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  if (preview.error || !preview.data) return <ErrorState error={preview.error ?? new Error("Linhas não encontradas.")} onRetry={() => preview.refetch()} />;
  const warnings = preview.data.batch.warnings.filter((w) => !isTransferWarning(w) && !isNatureWarning(w));
  return (
    <div className="min-w-0 space-y-4">
      <Warnings warnings={warnings} compact />
      <ReviewStep preview={preview.data} embedded />
    </div>
  );
}

/**
 * "Ver linhas" de um destino da prévia: a revisão de linhas da importação (seleção, categoria,
 * transferência, natureza), sem confirmar — a migração inteira é importada de uma vez.
 */
export function DestinationRowsDialog({ migrationId, destination, onOpenChange }: { migrationId: string; destination: MigrationDestinationDTO | null; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  return (
    <Dialog
      open={Boolean(destination)}
      onOpenChange={(v) => {
        // As contagens da prévia são recalculadas no servidor a partir das linhas.
        if (!v) qc.invalidateQueries({ queryKey: migrationKeys.detail(migrationId) });
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-6xl gap-4 p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Linhas · {destination?.name}</DialogTitle>
          <DialogDescription>
            Desmarque o que não quiser trazer e ajuste categoria, transferência ou natureza linha a linha. As mudanças valem na hora; a gravação acontece para a migração inteira, em “Importar
            tudo”.
          </DialogDescription>
        </DialogHeader>
        {destination && <BatchRows batchId={destination.batchId} />}
      </DialogContent>
    </Dialog>
  );
}
