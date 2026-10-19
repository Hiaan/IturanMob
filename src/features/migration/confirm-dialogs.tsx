"use client";

import { useState } from "react";
import { Trash2, Undo2 } from "lucide-react";
import { Button, buttonVariants, type ButtonProps } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { MigrationDTO } from "@/server/modules/migration/types";
import { plural } from "./labels";
import { useDiscardMigration, useMigrationBusy, useUndoMigration } from "./use-migration";

/** Descartar uma migração ainda não importada (READY ou PREVIEW). */
export function DiscardMigrationButton({ migration: m, size = "sm", variant = "ghost", className }: { migration: MigrationDTO; size?: ButtonProps["size"]; variant?: ButtonProps["variant"]; className?: string }) {
  const [open, setOpen] = useState(false);
  const discard = useDiscardMigration(m.id);
  const busy = useMigrationBusy(m.id);
  if (m.status !== "READY" && m.status !== "PREVIEW") return null;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} disabled={busy} className={className}>
        <Trash2 aria-hidden /> Descartar
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar a migração de “{m.fileName}”?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Nenhum lançamento foi gravado ainda. A leitura da planilha, as escolhas de abas, colunas e correspondências{m.status === "PREVIEW" ? " e a prévia" : ""} são descartadas.</p>
                <p>Contas, cartões e categorias criados nesta migração e ainda sem uso são removidos.</p>
                <p>Para migrar depois, envie a planilha de novo.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={discard.isPending}
              onClick={(e) => {
                e.preventDefault();
                discard.mutate(undefined, { onSettled: () => setOpen(false) });
              }}
            >
              {discard.isPending ? "Descartando…" : "Descartar migração"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Desfazer a migração inteira (IMPORTED), com a explicação do que volta atrás. */
export function UndoMigrationButton({ migration: m, size = "default", variant = "outline" }: { migration: MigrationDTO; size?: ButtonProps["size"]; variant?: ButtonProps["variant"] }) {
  const [open, setOpen] = useState(false);
  const undo = useUndoMigration(m.id);
  const busy = useMigrationBusy(m.id);
  if (m.status !== "IMPORTED") return null;
  const r = m.result;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} disabled={busy}>
        <Undo2 aria-hidden /> Desfazer migração
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desfazer a migração de “{m.fileName}”?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Tudo o que esta migração gravou volta atrás:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    {r ? <strong className="text-foreground">{plural(r.created, "lançamento criado", "lançamentos criados")}</strong> : "Os lançamentos criados"} vão para a lixeira (exclusão
                    lógica, auditada);
                  </li>
                  <li>{r?.bills ? `as ${plural(r.bills, "conta a pagar criada", "contas a pagar criadas")} são removidas` : "as contas a pagar criadas são removidas"};</li>
                  <li>{r?.budgets ? `os ${plural(r.budgets, "orçamento", "orçamentos")} voltam` : "os orçamentos voltam"} aos valores de antes;</li>
                  <li>os saldos iniciais das contas voltam ao que eram (e os saldos são recalculados);</li>
                  <li>categorias, contas e cartões criados pela migração e ainda sem uso são removidos.</li>
                </ul>
                <p>Lançamentos que já existiam no app e foram só vinculados não são apagados. Depois, a mesma planilha pode ser migrada de novo.</p>
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
                undo.mutate(undefined, { onSettled: () => setOpen(false) });
              }}
            >
              {undo.isPending ? "Desfazendo…" : "Desfazer migração"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
