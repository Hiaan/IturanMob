"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { useUndoImport } from "./use-imports";
import type { ImportBatchDTO } from "./types";

/** Botão + confirmação para desfazer uma importação concluída. */
export function UndoImportButton({ batch, size = "sm", variant = "outline", onDone }: { batch: ImportBatchDTO; size?: "sm" | "default"; variant?: "outline" | "ghost"; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const undo = useUndoImport(onDone);
  if (batch.status !== "IMPORTED") return null;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        <Undo2 /> Desfazer importação
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desfazer a importação de “{batch.fileName}”?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Os <strong className="text-foreground">{batch.importedRows}</strong> lançamento(s) criados por esta importação vão para a lixeira (exclusão lógica, auditada) e os saldos
                  das contas e faturas voltam ao que eram antes.
                </p>
                <p>Lançamentos que já existiam no app e foram apenas vinculados não são apagados; as pendências de divergência deste arquivo são descartadas. Depois, o mesmo arquivo poderá ser importado de novo.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={undo.isPending}
              onClick={(e) => {
                e.preventDefault();
                undo.mutate(batch.id, { onSettled: () => setOpen(false) });
              }}
            >
              {undo.isPending ? "Desfazendo…" : "Desfazer importação"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
