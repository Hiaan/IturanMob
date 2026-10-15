"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Confirmação de exclusão lógica (vai para a lixeira, restaurável). */
export function DeleteTransactionsDialog({
  open,
  onOpenChange,
  count,
  description,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count: number;
  description?: string;
  onConfirm: () => void;
  loading?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{count === 1 ? "Excluir lançamento?" : `Excluir ${count} lançamentos?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {description ? <strong className="font-medium text-foreground">{description}</strong> : null}
            {description ? " — " : ""}
            {count === 1 ? "o lançamento vai para a lixeira" : "os lançamentos vão para a lixeira"} e deixa{count === 1 ? "" : "m"} de afetar saldos, faturas e relatórios. Você pode restaurar depois.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <Button variant="destructive" loading={loading} onClick={onConfirm}>
            Mover para a lixeira
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Exclusão definitiva: exige digitar EXCLUIR. */
export function PurgeTransactionsDialog({
  open,
  onOpenChange,
  count,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count: number;
  onConfirm: () => void;
  loading?: boolean;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const ok = text.trim().toUpperCase() === "EXCLUIR";
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-destructive" aria-hidden />
            {count === 1 ? "Excluir definitivamente?" : `Excluir ${count} lançamentos definitivamente?`}
          </AlertDialogTitle>
          <AlertDialogDescription>Esta ação não pode ser desfeita. O registro será apagado de forma permanente (o histórico de auditoria é mantido).</AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm();
          }}
        >
          <Label htmlFor="purge-confirm" className="text-[13px]">
            <span>
              Digite <strong>EXCLUIR</strong> para confirmar
            </span>
          </Label>
          <Input id="purge-confirm" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoFocus aria-describedby="purge-hint" />
          <p id="purge-hint" className="sr-only">
            O botão de exclusão é liberado quando o texto digitado for EXCLUIR.
          </p>
          <AlertDialogFooter className="mt-2">
            <AlertDialogCancel type="button">Cancelar</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!ok} loading={loading}>
              Excluir definitivamente
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
