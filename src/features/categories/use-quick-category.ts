"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useCan } from "@/features/me/use-me";

export interface QuickCategoryInput {
  name: string;
  kind?: "EXPENSE" | "INCOME";
  /** Categoria-mãe: com ela, cria (ou reaproveita) a subcategoria. */
  parentId?: string | null;
}

/** Resposta de POST /api/v1/categories/quick. */
export interface QuickCategoryResult {
  categoryId: string;
  subcategoryId: string | null;
  /** "Pet" ou "Pet › Ração". */
  label: string;
  kind: "EXPENSE" | "INCOME";
  /** false = já existia com esse nome (foi só escolhida). */
  created: boolean;
}

/** Valor reservado da opção "+ Nova categoria" dentro dos seletores (nunca é selecionado). */
export const NEW_CATEGORY_VALUE = "__new_category__";

/**
 * Cria (ou reaproveita) a categoria/subcategoria. Só resolve depois de recarregar a lista de categorias,
 * para o seletor já encontrar a opção nova ao selecioná-la.
 */
export function useQuickCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: QuickCategoryInput) => {
      const result = await api.post<QuickCategoryResult>("/api/v1/categories/quick", input);
      await qc.invalidateQueries({ queryKey: ["categories"] });
      return result;
    },
    onSuccess: (r) => {
      toast.success(r.created ? `${r.subcategoryId ? "Subcategoria" : "Categoria"} ${r.label} criada` : `${r.label} já existia — selecionada`);
      qc.invalidateQueries({ queryKey: ["analytics"] });
      qc.invalidateQueries({ queryKey: ["budgets"] });
    },
  });
}

/**
 * Liga a opção "+ Nova categoria" de um seletor ao diálogo de criação rápida.
 * `intercept(v)` devolve true quando o valor escolhido é a opção de criar (e abre o diálogo).
 */
export function useQuickCategoryOption(onCreated: (r: QuickCategoryResult) => void, enabled = true) {
  const canWrite = useCan("categories:write");
  const [open, setOpen] = useState(false);
  /** Botão do seletor: recebe o foco de volta quando o diálogo fecha. */
  const triggerRef = useRef<HTMLButtonElement>(null);
  const canCreate = enabled && canWrite;
  return {
    canCreate,
    triggerRef,
    intercept: (value: string) => {
      if (value !== NEW_CATEGORY_VALUE) return false;
      // Abre depois que o seletor termina de fechar (ele devolve o foco ao próprio botão).
      if (canCreate) setTimeout(() => setOpen(true), 0);
      return true;
    },
    dialog: { open, onOpenChange: setOpen, onCreated, returnFocusRef: triggerRef },
  };
}
