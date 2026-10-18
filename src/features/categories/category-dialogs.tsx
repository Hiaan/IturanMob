"use client";

import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import type { CategoryDTO, SubcategoryDTO } from "@/features/finance/types";
import { ColorSwatches } from "@/features/accounts/account-icon";
import { CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_ICON_NAMES, CategoryIcon } from "./category-icon";
import { CategoryPicker, type CategoryChoice } from "./category-picker";
import { KeywordEditor } from "./keyword-editor";
import { useCategoryMutations } from "./use-category-mutations";

// -----------------------------------------------------------------------------
// Criar / editar categoria
// -----------------------------------------------------------------------------

const categorySchema = z.object({
  name: z.string().trim().min(1, "Informe o nome").max(50, "Use no máximo 50 caracteres"),
  kind: z.enum(["EXPENSE", "INCOME"]),
  icon: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida"),
});
type CategoryValues = z.infer<typeof categorySchema>;

export function CategoryFormDialog({
  open,
  onOpenChange,
  category,
  defaultKind,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  category?: CategoryDTO | null;
  defaultKind: "EXPENSE" | "INCOME";
}) {
  const { saveCategory } = useCategoryMutations();
  const [serverError, setServerError] = useState<string | null>(null);
  const initial = (): CategoryValues =>
    category
      ? { name: category.name, kind: category.kind, icon: category.icon, color: category.color }
      : { name: "", kind: defaultKind, icon: defaultKind === "INCOME" ? "trending-up" : "tag", color: CATEGORY_COLORS[0]! };
  const form = useForm<CategoryValues>({ resolver: zodResolver(categorySchema), defaultValues: initial() });
  const { control, register, handleSubmit, reset, formState } = form;
  const [icon, color, name, kind] = useWatch({ control, name: ["icon", "color", "name", "kind"] });

  useEffect(() => {
    if (open) {
      reset(initial());
      setServerError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, category, defaultKind]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{category ? "Editar categoria" : "Nova categoria"}</DialogTitle>
          <DialogDescription>Escolha um nome, um ícone e uma cor para identificar a categoria nos gráficos e listas.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit((v) => {
            setServerError(null);
            saveCategory.mutate(
              { id: category?.id, input: { name: v.name, kind: v.kind, icon: v.icon, color: v.color } },
              { onSuccess: () => onOpenChange(false), onError: (e) => setServerError(errorMessage(e)) },
            );
          })}
        >
          <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
            <CategoryIcon icon={icon} color={color} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-medium">{name || "Nova categoria"}</p>
              <p className="text-xs text-muted-foreground">{kind === "INCOME" ? "Categoria de receita" : "Categoria de despesa"}</p>
            </div>
          </div>
          {!category && (
            <Controller
              control={control}
              name="kind"
              render={({ field }) => (
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Tipo da categoria">
                  {(
                    [
                      ["EXPENSE", "Despesa", TrendingDown],
                      ["INCOME", "Receita", TrendingUp],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === value}
                      onClick={() => field.onChange(value)}
                      className={cn("flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition", field.value === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                    >
                      <Icon className="size-4" aria-hidden /> {label}
                    </button>
                  ))}
                </div>
              )}
            />
          )}
          <Field label="Nome" htmlFor="cat-name" error={formState.errors.name?.message} required>
            <Input id="cat-name" {...register("name")} placeholder="Ex.: Pets" aria-invalid={Boolean(formState.errors.name)} autoFocus={!category} />
          </Field>
          <Field label="Ícone">
            <Controller
              control={control}
              name="icon"
              render={({ field }) => (
                <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10" role="radiogroup" aria-label="Ícone da categoria">
                  {CATEGORY_ICON_NAMES.map((n) => {
                    const Icon = CATEGORY_ICONS[n]!.icon;
                    const selected = field.value === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={CATEGORY_ICONS[n]!.label}
                        title={CATEGORY_ICONS[n]!.label}
                        onClick={() => field.onChange(n)}
                        className={cn(
                          "flex aspect-square items-center justify-center rounded-lg border outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                          selected ? "border-brand bg-accent text-accent-foreground" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="size-4" aria-hidden />
                      </button>
                    );
                  })}
                </div>
              )}
            />
          </Field>
          <Field label="Cor" error={formState.errors.color?.message}>
            <Controller control={control} name="color" render={({ field }) => <ColorSwatches value={field.value} onChange={field.onChange} colors={CATEGORY_COLORS} label="Cor da categoria" />} />
          </Field>
          {serverError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={saveCategory.isPending}>
              {category ? "Salvar" : "Criar categoria"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Criar / editar subcategoria
// -----------------------------------------------------------------------------

export function SubcategoryDialog({
  open,
  onOpenChange,
  category,
  subcategory,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  category: CategoryDTO | null;
  subcategory?: SubcategoryDTO | null;
}) {
  const { saveSubcategory } = useCategoryMutations();
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(subcategory?.name ?? "");
      setKeywords(subcategory?.keywords ?? []);
      setError(null);
    }
  }, [open, subcategory]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{subcategory ? "Editar subcategoria" : "Nova subcategoria"}</DialogTitle>
          <DialogDescription>
            {category ? `Em ${category.name}. ` : ""}As palavras-chave ajudam a sugerir a subcategoria em mensagens e importações (sem acentos, minúsculas).
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return setError("Informe o nome");
            if (!category) return;
            saveSubcategory.mutate(
              { id: subcategory?.id, categoryId: category.id, input: { name: name.trim(), keywords } },
              {
                onSuccess: (s) => {
                  onOpenChange(false);
                  toast.success(subcategory ? "Subcategoria atualizada" : "Subcategoria criada", { description: s.name });
                },
                onError: (err) => setError(errorMessage(err)),
              },
            );
          }}
        >
          <Field label="Nome" htmlFor="sub-name" error={error ?? undefined} required>
            <Input id="sub-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="Ex.: Ração" autoFocus aria-invalid={Boolean(error)} />
          </Field>
          <Field label="Palavras-chave" hint="Pressione Enter ou vírgula para adicionar">
            <KeywordEditor keywords={keywords} onChange={setKeywords} inputId="sub-keywords" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={saveSubcategory.isPending}>
              {subcategory ? "Salvar" : "Criar subcategoria"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Excluir categoria (com reclassificação obrigatória quando há uso)
// -----------------------------------------------------------------------------

export function DeleteCategoryDialog({ category, onOpenChange }: { category: CategoryDTO | null; onOpenChange: (o: boolean) => void }) {
  const { deleteCategory, archiveCategory } = useCategoryMutations();
  const [target, setTarget] = useState<CategoryChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsTarget, setNeedsTarget] = useState(false);
  useEffect(() => {
    if (category) {
      setTarget(null);
      setError(null);
      setNeedsTarget(category.transactionsCount > 0);
    }
  }, [category]);
  if (!category) return null;
  const count = category.transactionsCount;

  return (
    <AlertDialog open={Boolean(category)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir a categoria {category.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {needsTarget
              ? `${count > 0 ? `Ela tem ${count} ${count === 1 ? "transação" : "transações"}. ` : "Ela tem transações (inclusive na lixeira). "}Escolha para qual categoria movê-las antes de excluir — ou arquive a categoria para manter o histórico como está.`
              : "A categoria e suas subcategorias serão removidas. Orçamentos desta categoria também serão excluídos."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {needsTarget && (
          <Field label="Mover transações para" htmlFor="del-target" required>
            <CategoryPicker id="del-target" kind={category.kind} excludeCategoryId={category.id} categoriesOnly allowCreate={false} value={target} onChange={setTarget} placeholder="Escolha a categoria de destino" />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          {needsTarget && !category.archivedAt && (
            <Button
              variant="outline"
              onClick={() => {
                archiveCategory.mutate({ id: category.id, archived: true });
                onOpenChange(false);
              }}
            >
              Arquivar
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={needsTarget && !target}
            loading={deleteCategory.isPending}
            onClick={() =>
              deleteCategory.mutate(
                { id: category.id, moveToCategoryId: needsTarget ? target?.categoryId : undefined },
                {
                  onSuccess: () => onOpenChange(false),
                  onError: (e) => {
                    if (e instanceof ApiError && e.status === 409 && !needsTarget) setNeedsTarget(true);
                    setError(errorMessage(e));
                  },
                },
              )
            }
          >
            {needsTarget ? "Mover e excluir" : "Excluir"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// -----------------------------------------------------------------------------
// Reclassificar transações entre categorias/subcategorias
// -----------------------------------------------------------------------------

export function ReclassifyDialog({
  open,
  onOpenChange,
  from,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  from: { category: CategoryDTO; subcategory?: SubcategoryDTO | null } | null;
}) {
  const { reclassify } = useCategoryMutations();
  const [source, setSource] = useState<CategoryChoice | null>(null);
  const [target, setTarget] = useState<CategoryChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && from) {
      setSource({ categoryId: from.category.id, subcategoryId: from.subcategory?.id ?? null });
      setTarget(null);
      setError(null);
    }
  }, [open, from]);
  if (!from) return null;
  const kind = from.category.kind;
  const same = source && target && source.categoryId === target.categoryId && source.subcategoryId === target.subcategoryId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reclassificar transações</DialogTitle>
          <DialogDescription>Move todas as transações (não excluídas) da origem para o destino. Cada alteração fica registrada no histórico da transação.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!source || !target) return setError("Escolha a origem e o destino");
            if (same) return setError("Origem e destino são iguais");
            setError(null);
            reclassify.mutate(
              { fromCategoryId: source.categoryId, fromSubcategoryId: source.subcategoryId, toCategoryId: target.categoryId, toSubcategoryId: target.subcategoryId },
              { onSuccess: () => onOpenChange(false), onError: (err) => setError(errorMessage(err)) },
            );
          }}
        >
          <Field label="De (origem)" htmlFor="rc-from" hint={source?.subcategoryId ? "Somente as transações desta subcategoria" : "Todas as transações da categoria, com ou sem subcategoria"}>
            <CategoryPicker id="rc-from" kind={kind} allowCreate={false} value={source} onChange={setSource} />
          </Field>
          <div className="flex justify-center text-muted-foreground" aria-hidden>
            <ArrowRight className="size-4 rotate-90" />
          </div>
          <Field label="Para (destino)" htmlFor="rc-to" required>
            <CategoryPicker id="rc-to" kind={kind} value={target} onChange={setTarget} placeholder="Escolha o destino" />
          </Field>
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={reclassify.isPending} disabled={!target || Boolean(same)}>
              Reclassificar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
