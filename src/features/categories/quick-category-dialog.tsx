"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { Plus, TrendingDown, TrendingUp } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { useCategories } from "@/features/finance/hooks";
import { NEW_CATEGORY_VALUE, useQuickCreateCategory, type QuickCategoryResult } from "./use-quick-category";

const TOP_LEVEL = "__top__";
const MAX_NAME = 50;

type Errors = { name?: string; parentId?: string; form?: string };

function errorsFrom(err: unknown): Errors {
  if (err instanceof ApiError) {
    const out: Errors = {};
    for (const issue of err.issues ?? []) {
      if (issue.path === "name" && !out.name) out.name = issue.message;
      else if (issue.path === "parentId" && !out.parentId) out.parentId = issue.message;
    }
    const field = (err.details as { field?: string } | null | undefined)?.field;
    if (!out.name && !out.parentId) {
      if (field === "name") out.name = err.message;
      else if (field === "parentId" || err.status === 404) out.parentId = err.status === 404 ? "Essa categoria não existe mais. Escolha outra." : err.message;
      else out.form = err.message;
    }
    return out;
  }
  return { form: errorMessage(err) };
}

/**
 * Opção "+ Nova categoria" no fim da lista de um seletor de categoria (fica visível mesmo com a lista
 * rolada). O seletor trata o valor `NEW_CATEGORY_VALUE` abrindo o `QuickCategoryDialog`.
 */
export function NewCategoryOption() {
  return (
    <div className="sticky -bottom-1 z-10 -mx-1 -mb-1 mt-1 border-t bg-popover p-1">
      <SelectItem value={NEW_CATEGORY_VALUE} className="pl-2 font-medium text-brand focus:text-brand">
        <span className="flex items-center gap-2">
          <Plus className="size-4" aria-hidden />
          Nova categoria
        </span>
      </SelectItem>
    </div>
  );
}

type QuickCategoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: QuickCategoryResult) => void;
  /** Tipo já definido pelo seletor (Despesa/Receita); sem ele, o diálogo pergunta. */
  kind?: "EXPENSE" | "INCOME" | null;
  /** false quando o seletor só aceita categorias (sem subcategoria). */
  allowSubcategory?: boolean;
  /** Para onde o foco volta ao fechar (o botão do seletor que abriu o diálogo). */
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Criação rápida de categoria (ou de subcategoria, escolhendo "Dentro de") a partir de um seletor.
 * Nome que já existe não duplica: o servidor devolve a existente e ela é selecionada.
 * Só monta o conteúdo na primeira abertura (há telas com um seletor por linha, como a importação).
 */
export function QuickCategoryDialog(props: QuickCategoryDialogProps) {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  return mounted ? <QuickCategoryDialogContent {...props} /> : null;
}

function QuickCategoryDialogContent({ open, onOpenChange, onCreated, kind, allowSubcategory = true, returnFocusRef }: QuickCategoryDialogProps) {
  const categories = useCategories();
  const create = useQuickCreateCategory();
  const [name, setName] = useState("");
  const [type, setType] = useState<"EXPENSE" | "INCOME">(kind ?? "EXPENSE");
  const [parentId, setParentId] = useState(TOP_LEVEL);
  const [errors, setErrors] = useState<Errors>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const resetCreate = create.reset;

  useEffect(() => {
    if (!open) return;
    setName("");
    setType(kind ?? "EXPENSE");
    setParentId(TOP_LEVEL);
    setErrors({});
    resetCreate();
  }, [open, kind, resetCreate]);

  const effectiveKind = kind ?? type;
  const parents = useMemo(() => (categories.data ?? []).filter((c) => c.kind === effectiveKind && !c.archivedAt), [categories.data, effectiveKind]);
  const parent = allowSubcategory ? (parents.find((c) => c.id === parentId) ?? null) : null;
  const trimmed = name.trim();
  const preview = trimmed ? (parent ? `${parent.name} › ${trimmed}` : trimmed) : null;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // O diálogo é renderizado dentro de outros formulários (no React): o envio não pode subir até eles.
    e.stopPropagation();
    if (!trimmed) {
      setErrors({ name: "Informe o nome" });
      nameRef.current?.focus();
      return;
    }
    if (trimmed.length > MAX_NAME) {
      setErrors({ name: `Use no máximo ${MAX_NAME} caracteres` });
      return;
    }
    setErrors({});
    create.mutate(
      { name: trimmed, kind: effectiveKind, parentId: parent?.id ?? null },
      {
        onSuccess: (result) => {
          onCreated(result);
          onOpenChange(false);
        },
        onError: (err) => {
          const next = errorsFrom(err);
          setErrors(next);
          if (next.name) nameRef.current?.focus();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          const target = returnFocusRef?.current;
          if (target?.isConnected) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{parent ? "Nova subcategoria" : "Nova categoria"}</DialogTitle>
          <DialogDescription>Ela já fica selecionada. Ícone, cor e palavras-chave podem ser ajustados depois em Categorias.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={submit}>
          {!kind && (
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
                  aria-checked={type === value}
                  onClick={() => {
                    if (type === value) return;
                    setType(value);
                    setParentId(TOP_LEVEL);
                  }}
                  className={cn("flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition", type === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  <Icon className="size-4" aria-hidden /> {label}
                </button>
              ))}
            </div>
          )}
          <Field
            label={parent ? "Nome da subcategoria" : "Nome"}
            htmlFor="quick-cat-name"
            error={errors.name}
            required
            hint={preview ? `Vai aparecer como “${preview}”. Se o nome já existir, a existente é selecionada.` : undefined}
          >
            <Input
              id="quick-cat-name"
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name || errors.form) setErrors((s) => ({ ...s, name: undefined, form: undefined }));
              }}
              placeholder={parent ? "Ex.: Ração" : effectiveKind === "INCOME" ? "Ex.: Freelas" : "Ex.: Pet"}
              maxLength={MAX_NAME}
              autoComplete="off"
              enterKeyHint="done"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "quick-cat-name-error" : undefined}
            />
          </Field>
          {allowSubcategory && (
            <Field label="Dentro de" htmlFor="quick-cat-parent" error={errors.parentId} hint={parent ? `Cria uma subcategoria de ${parent.name}.` : "Opcional: escolha uma categoria para criar uma subcategoria dela."}>
              <Select
                value={parent ? parent.id : TOP_LEVEL}
                onValueChange={(v) => {
                  setParentId(v);
                  if (errors.parentId) setErrors((s) => ({ ...s, parentId: undefined }));
                }}
              >
                <SelectTrigger id="quick-cat-parent" aria-invalid={Boolean(errors.parentId)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TOP_LEVEL}>Nenhuma — categoria principal</SelectItem>
                  {parents.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="flex items-center gap-2">
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                        {c.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {errors.form && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errors.form}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={create.isPending}>
              <Plus /> {parent ? "Criar subcategoria" : "Criar categoria"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
