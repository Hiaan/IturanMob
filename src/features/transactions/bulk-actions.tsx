"use client";

import { useEffect, useState } from "react";
import { ArchiveRestore, ArrowLeftRight, CheckCircle2, ChevronDown, EyeOff, Tags, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CategoryPicker, type CategoryChoice } from "@/features/categories/category-picker";
import type { TransactionDTO } from "@/features/finance/types";
import { canConvertToTransfer } from "./convert-transfer-dialog";
import { canExcludeFromReports } from "./report-exclusion";

/** Barra flutuante com as ações em lote para os itens selecionados. */
export function BulkBar({
  items,
  trash,
  onClear,
  onReclassify,
  onConvertTransfer,
  onExclude,
  onInclude,
  onConfirm,
  onDelete,
  onRestore,
  onPurge,
  busy,
  canWrite,
  canDelete,
}: {
  items: TransactionDTO[];
  trash: boolean;
  onClear: () => void;
  onReclassify: () => void;
  onConvertTransfer: () => void;
  /** Desconsiderar nos relatórios (abre o diálogo). */
  onExclude: () => void;
  /** Voltar a considerar os desconsiderados selecionados. */
  onInclude: () => void;
  onConfirm: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
  busy?: boolean;
  canWrite: boolean;
  canDelete: boolean;
}) {
  if (!items.length) return null;
  const pending = items.filter((t) => t.status === "PENDING").length;
  const convertible = items.filter(canConvertToTransfer).length;
  const excludable = items.filter(canExcludeFromReports);
  const excludedCount = excludable.filter((t) => t.excludedFromReports).length;
  return (
    <div role="toolbar" aria-label="Ações em lote" className="fixed left-[calc(0.75rem+var(--safe-left))] right-[calc(0.75rem+var(--safe-right))] bottom-[calc(5rem+var(--safe-bottom))] z-40 mx-auto flex max-w-3xl items-center gap-1.5 rounded-2xl border bg-popover p-2 shadow-2xl sm:gap-2 lg:bottom-6">
      <Button size="icon-sm" variant="ghost" onClick={onClear} aria-label="Limpar seleção">
        <X />
      </Button>
      <p className="shrink-0 whitespace-nowrap text-sm font-medium tabular" aria-live="polite">
        {items.length}
        {/* No celular só o número (como em apps de e-mail): sobra espaço para as ações. */}
        <span className="max-[479px]:sr-only"> {items.length === 1 ? "selecionado" : "selecionados"}</span>
      </p>
      {/* Em telas estreitas, se as ações não couberem numa linha, quebram para a de baixo (nunca rolam). */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5 sm:gap-2">
        {!trash ? (
          <>
            {canWrite && (
              <Button size="sm" variant="outline" onClick={onReclassify} disabled={busy}>
                <Tags /> <span className="max-sm:sr-only">Reclassificar</span>
              </Button>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="outline"
                onClick={onConvertTransfer}
                disabled={busy || !convertible}
                title={convertible ? "Aplicação, resgate ou transferência entre contas próprias: não é receita nem despesa" : "Selecione receitas ou despesas em conta (fora compras no cartão)"}
              >
                <ArrowLeftRight /> <span className="max-lg:sr-only">Converter em transferência</span>
              </Button>
            )}
            {canWrite && excludable.length > 0 && excludedCount === 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={onExclude}
                disabled={busy}
                title="Repasse de cliente, reembolso…: sai das receitas e despesas. O saldo da conta e a fatura do cartão não mudam."
              >
                <EyeOff /> <span className="max-sm:sr-only">Desconsiderar</span>
              </Button>
            )}
            {canWrite && excludedCount > 0 && (
              // Há desconsiderados na seleção: um só botão com as duas opções (cabe numa linha).
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy} aria-label="Desconsiderar nos relatórios: opções">
                    <EyeOff /> <span className="max-sm:sr-only">Desconsiderar</span>
                    <ChevronDown className="size-3.5 opacity-70" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top">
                  <DropdownMenuItem onSelect={onExclude}>
                    <EyeOff /> {excludedCount === excludable.length ? "Editar motivo e cliente…" : "Desconsiderar nos relatórios…"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onInclude}>
                    <Undo2 /> Voltar a considerar{excludedCount !== items.length ? ` (${excludedCount})` : ""}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canWrite && pending > 0 && (
              <Button size="sm" variant="outline" onClick={onConfirm} disabled={busy}>
                <CheckCircle2 /> <span className="max-sm:sr-only">Confirmar{pending !== items.length ? ` (${pending})` : ""}</span>
              </Button>
            )}
            {canDelete && (
              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={onDelete} disabled={busy}>
                <Trash2 /> <span className="max-sm:sr-only">Excluir</span>
              </Button>
            )}
          </>
        ) : (
          canDelete && (
            <>
              <Button size="sm" variant="outline" onClick={onRestore} disabled={busy}>
                <ArchiveRestore /> <span className="max-sm:sr-only">Restaurar</span>
              </Button>
              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={onPurge} disabled={busy}>
                <Trash2 /> <span className="max-sm:sr-only">Excluir definitivamente</span>
              </Button>
            </>
          )
        )}
      </div>
    </div>
  );
}

/** Reclassificação em lote: escolhe categoria/subcategoria para despesas ou receitas selecionadas. */
export function BulkReclassifyDialog({
  open,
  onOpenChange,
  items,
  onSubmit,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  items: TransactionDTO[];
  onSubmit: (ids: string[], choice: CategoryChoice) => void;
  loading?: boolean;
}) {
  const [choice, setChoice] = useState<CategoryChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setChoice(null);
      setError(null);
    }
  }, [open]);

  const expenses = items.filter((t) => t.type === "EXPENSE");
  const incomes = items.filter((t) => t.type === "INCOME");
  const others = items.length - expenses.length - incomes.length;
  const mixed = expenses.length > 0 && incomes.length > 0;
  const kind = incomes.length > 0 && !expenses.length ? "INCOME" : "EXPENSE";
  const eligible = mixed ? [] : kind === "INCOME" ? incomes : expenses;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reclassificar lançamentos</DialogTitle>
          <DialogDescription>
            {eligible.length} {eligible.length === 1 ? "lançamento será movido" : "lançamentos serão movidos"} para a categoria escolhida. Cada alteração fica registrada no histórico.
          </DialogDescription>
        </DialogHeader>
        {mixed ? (
          <p role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            A seleção mistura despesas e receitas. Selecione apenas um dos tipos para reclassificar.
          </p>
        ) : eligible.length === 0 ? (
          <p role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            Transferências, pagamentos de fatura e ajustes não têm categoria.
          </p>
        ) : (
          <form
            id="bulk-reclassify"
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!choice) return setError("Escolha a categoria de destino");
              onSubmit(
                eligible.map((t) => t.id),
                choice,
              );
            }}
          >
            <Field label={kind === "INCOME" ? "Categoria de receita" : "Categoria de despesa"} htmlFor="bulk-category" error={error ?? undefined} required>
              <CategoryPicker id="bulk-category" kind={kind} value={choice} onChange={(c) => { setChoice(c); setError(null); }} invalid={Boolean(error)} />
            </Field>
            {others > 0 && <p className="text-xs text-muted-foreground">{others} item(ns) sem categoria aplicável (transferências, pagamentos de fatura ou ajustes) serão ignorados.</p>}
          </form>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="bulk-reclassify" variant="brand" loading={loading} disabled={mixed || eligible.length === 0}>
            Reclassificar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
