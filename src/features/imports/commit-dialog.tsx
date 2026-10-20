"use client";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { formatBRL } from "@/lib/money";
import { commitSummary } from "./helpers";
import type { useCommitImport } from "./use-imports";
import type { ImportPreview } from "./types";

/** Confirmação final da importação (revisão de extrato ou "Confirmar fatura"): o que será gravado e o que fica de fora. */
export function CommitImportDialog({
  preview,
  open,
  onOpenChange,
  commit,
  saving = false,
}: {
  preview: ImportPreview;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  commit: ReturnType<typeof useCommitImport>;
  /** Escolhas da conferência ainda sendo gravadas: espera antes de importar. */
  saving?: boolean;
}) {
  const { toCreate, toLink, toReview, transfers, toConvert, natureCounts } = commitSummary(preview.rows);
  const card = Boolean(preview.batch.creditCard);
  const skipped = preview.review.notImportedCount;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirmar importação?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Serão criados <strong className="text-foreground">{toCreate.length}</strong> lançamento(s)
                {preview.batch.account ? ` na conta ${preview.batch.account.name}` : preview.batch.creditCard ? ` no cartão ${preview.batch.creditCard.name}` : ""}, vinculadas{" "}
                <strong className="text-foreground">{toLink.length}</strong> correspondência(s) e abertas <strong className="text-foreground">{toReview.length}</strong> pendência(s) de divergência.
              </p>
              {skipped > 0 && (
                <p>
                  <strong className="text-foreground">{skipped}</strong> {card ? (skipped === 1 ? "compra" : "compras") : skipped === 1 ? "saída" : "saídas"} com “Não importar” (
                  <span className="tabular">{formatBRL(preview.review.differenceCents)}</span>) {skipped === 1 ? "fica" : "ficam"} de fora{" "}
                  {card ? "da fatura no app, inclusive as parcelas futuras." : "do app."}
                </p>
              )}
              {(transfers.count > 0 || toConvert.length > 0) && (
                <p>
                  {transfers.count > 0 && (
                    <>
                      <strong className="text-foreground">{transfers.count}</strong> deles entram como transferência entre contas próprias (aplicação/resgate).{" "}
                    </>
                  )}
                  {toConvert.length > 0 && (
                    <>
                      <strong className="text-foreground">{toConvert.length}</strong> lançamento(s) já registrado(s) como receita/despesa vão virar transferência.{" "}
                    </>
                  )}
                  Transferências não contam como receita nem despesa.
                </p>
              )}
              {(natureCounts.business > 0 || natureCounts.passthrough > 0 || natureCounts.ask > 0) && (
                <p>
                  Natureza:{" "}
                  {[
                    natureCounts.business ? `${natureCounts.business} como Empresa` : null,
                    natureCounts.passthrough ? `${natureCounts.passthrough} como Repasse (fora dos relatórios)` : null,
                    natureCounts.ask ? `${natureCounts.ask} sem escolha: entram como Pessoal e ficam em Pendências para você escolher` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  . Saldo e fatura não mudam.
                </p>
              )}
              <p>Você poderá desfazer a importação depois: os lançamentos criados vão para a lixeira e os saldos voltam ao que eram.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Voltar</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              commit.mutate(undefined, { onSettled: () => onOpenChange(false) });
            }}
            disabled={commit.isPending || saving}
          >
            {commit.isPending ? "Importando…" : saving ? "Salvando escolhas…" : "Importar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
