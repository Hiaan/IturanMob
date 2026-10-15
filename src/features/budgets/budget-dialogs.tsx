"use client";

import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyInput } from "@/components/shared/money-input";
import { formatBRL } from "@/lib/money";
import { formatMonthBR } from "@/lib/dates";
import { useCategories } from "@/features/finance/hooks";
import type { BudgetCategory, BudgetItem } from "./types";
import { useBudgetMutations } from "./use-budgets";

const addSchema = z.object({
  categoryId: z.string().min(1, "Escolha a categoria"),
  limitCents: z.number().int().positive("Informe um limite maior que zero"),
});
type AddValues = z.infer<typeof addSchema>;

/** Define o limite de uma categoria (ainda sem orçamento) no mês. */
export function AddBudgetDialog({
  open,
  onOpenChange,
  month,
  categories,
  initialCategoryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  month: string;
  categories: BudgetCategory[];
  initialCategoryId?: string | null;
}) {
  const { upsert } = useBudgetMutations();
  const form = useForm<AddValues>({ resolver: zodResolver(addSchema), defaultValues: { categoryId: initialCategoryId ?? "", limitCents: 0 } });
  const { control, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (open) reset({ categoryId: initialCategoryId ?? "", limitCents: 0 });
  }, [open, initialCategoryId, reset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo orçamento</DialogTitle>
          <DialogDescription>Limite de gastos para uma categoria em {formatMonthBR(month)}.</DialogDescription>
        </DialogHeader>
        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todas as categorias de despesa já têm orçamento neste mês.</p>
        ) : (
          <form
            className="grid gap-4"
            noValidate
            onSubmit={handleSubmit((v) => upsert.mutate({ ...v, month }, { onSuccess: () => onOpenChange(false) }))}
          >
            <Field label="Categoria" htmlFor="budget-category" error={formState.errors.categoryId?.message} required>
              <Controller
                control={control}
                name="categoryId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="budget-category" aria-invalid={Boolean(formState.errors.categoryId)}>
                      <SelectValue placeholder="Selecione a categoria" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <span className="flex items-center gap-2">
                            <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                            {c.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="Limite mensal" htmlFor="budget-limit" error={formState.errors.limitCents?.message} required>
              <Controller
                control={control}
                name="limitCents"
                render={({ field }) => <MoneyInput id="budget-limit" size="lg" value={field.value} onChange={field.onChange} aria-invalid={Boolean(formState.errors.limitCents)} />}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" variant="brand" loading={upsert.isPending}>
                Salvar orçamento
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Define (ou remove) os limites de várias categorias de uma vez. Limite zero remove o orçamento. */
export function BulkBudgetDialog({ open, onOpenChange, month, items }: { open: boolean; onOpenChange: (open: boolean) => void; month: string; items: BudgetItem[] }) {
  const categories = useCategories();
  const { bulk } = useBudgetMutations();
  const expense = useMemo(() => (categories.data ?? []).filter((c) => c.kind === "EXPENSE" && !c.archivedAt), [categories.data]);
  const current = useMemo(() => new Map(items.map((i) => [i.category.id, i.limitCents])), [items]);
  const [values, setValues] = useState<Record<string, number>>({});

  // Inicializa ao abrir (e quando as categorias terminam de carregar); recargas em segundo plano não apagam a edição.
  useEffect(() => {
    if (open) setValues(Object.fromEntries(expense.map((c) => [c.id, current.get(c.id) ?? 0])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense.length]);

  const changed = expense.filter((c) => (values[c.id] ?? 0) !== (current.get(c.id) ?? 0));
  const total = Object.values(values).reduce((s, v) => s + v, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Definir orçamentos em lote</DialogTitle>
          <DialogDescription>
            Limites de {formatMonthBR(month)} por categoria de despesa. Deixe em R$ 0,00 para não ter orçamento na categoria.
          </DialogDescription>
        </DialogHeader>
        {categories.isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!changed.length) {
                onOpenChange(false);
                return;
              }
              bulk.mutate(
                { month, items: changed.map((c) => ({ categoryId: c.id, limitCents: values[c.id] ? values[c.id]! : null })) },
                { onSuccess: () => onOpenChange(false) },
              );
            }}
          >
            <ul className="grid max-h-[50dvh] gap-2 overflow-y-auto pr-1">
              {expense.map((c) => (
                <li key={c.id} className="grid grid-cols-[1fr_minmax(0,11rem)] items-center gap-3">
                  <label htmlFor={`bulk-${c.id}`} className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                    <span className="truncate">{c.name}</span>
                  </label>
                  <MoneyInput id={`bulk-${c.id}`} value={values[c.id] ?? 0} onChange={(v) => setValues((s) => ({ ...s, [c.id]: v }))} />
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Total do mês</span>
              <span className="font-semibold tabular">{formatBRL(total)}</span>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" variant="brand" loading={bulk.isPending}>
                {changed.length ? `Salvar ${changed.length} ${changed.length === 1 ? "alteração" : "alterações"}` : "Nada alterado"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
