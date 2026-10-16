"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { invalidateFinance } from "@/features/transactions/invalidate";
import type { RuleDTO, RuleInput } from "./types";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function useCategoryMutations() {
  const qc = useQueryClient();
  const refreshCategories = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["analytics"] });
    qc.invalidateQueries({ queryKey: ["budgets"] });
    qc.invalidateQueries({ queryKey: qk.rules });
  };
  const refreshAll = () => {
    invalidateFinance(qc, ["categories"]);
    qc.invalidateQueries({ queryKey: qk.rules });
  };

  const saveCategory = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: { name: string; kind?: "EXPENSE" | "INCOME"; icon: string; color: string } }) =>
      id ? api.patch<{ name: string }>(`/api/v1/categories/${id}`, { name: input.name, icon: input.icon, color: input.color }) : api.post<{ name: string }>("/api/v1/categories", input),
    onSuccess: (c, vars) => {
      toast.success(vars.id ? "Categoria atualizada" : "Categoria criada", { description: c.name });
      refreshCategories();
    },
  });

  const archiveCategory = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.patch<{ name: string }>(`/api/v1/categories/${id}`, { archived }),
    onSuccess: (c, vars) => {
      toast.success(vars.archived ? "Categoria arquivada" : "Categoria reativada", {
        description: vars.archived ? `${c.name} não aparece mais para novos lançamentos; o histórico é mantido.` : c.name,
      });
      refreshCategories();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const deleteCategory = useMutation({
    mutationFn: ({ id, moveToCategoryId }: { id: string; moveToCategoryId?: string }) =>
      api.delete<{ ok: true }>(`/api/v1/categories/${id}`, moveToCategoryId ? { moveToCategoryId } : undefined),
    onSuccess: (_r, vars) => {
      toast.success("Categoria excluída", { description: vars.moveToCategoryId ? "As transações foram movidas para a categoria escolhida." : undefined });
      refreshAll();
    },
  });

  const reclassify = useMutation({
    mutationFn: (body: { fromCategoryId: string; fromSubcategoryId?: string | null; toCategoryId: string; toSubcategoryId?: string | null }) =>
      api.post<{ moved: number }>("/api/v1/categories/reclassify", body),
    onSuccess: (r) => {
      toast.success(r.moved ? `${plural(r.moved, "transação reclassificada", "transações reclassificadas")}` : "Nenhuma transação para mover");
      refreshAll();
    },
  });

  const saveSubcategory = useMutation({
    mutationFn: ({ id, categoryId, input }: { id?: string; categoryId?: string; input: { name?: string; keywords?: string[] } }) =>
      id ? api.patch<{ name: string; keywords: string[] }>(`/api/v1/subcategories/${id}`, input) : api.post<{ name: string; keywords: string[] }>(`/api/v1/categories/${categoryId}/subcategories`, input),
    onSuccess: () => refreshCategories(),
  });

  const archiveSubcategory = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api.patch<{ name: string }>(`/api/v1/subcategories/${id}`, { archived }),
    onSuccess: (s, vars) => {
      toast.success(vars.archived ? "Subcategoria arquivada" : "Subcategoria reativada", { description: s.name });
      refreshCategories();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const deleteSubcategory = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/v1/subcategories/${id}`),
    onSuccess: () => {
      toast.success("Subcategoria excluída");
      refreshCategories();
    },
  });

  return { saveCategory, archiveCategory, deleteCategory, reclassify, saveSubcategory, archiveSubcategory, deleteSubcategory };
}

export function useRules() {
  return useQuery({ queryKey: qk.rules, queryFn: () => api.get<RuleDTO[]>("/api/v1/rules") });
}

export function useRuleMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.rules });

  const save = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: Partial<RuleInput> }) => (id ? api.patch<RuleDTO>(`/api/v1/rules/${id}`, input) : api.post<RuleDTO>("/api/v1/rules", input)),
    onSuccess: (r, vars) => {
      if (!(vars.input.active !== undefined && Object.keys(vars.input).length === 1)) toast.success(vars.id ? "Regra atualizada" : "Regra criada", { description: r.name });
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/v1/rules/${id}`),
    onSuccess: () => {
      toast.success("Regra excluída");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /** Aplica regras (em ordem de prioridade) a lançamentos ainda sem categoria. */
  const apply = useMutation({
    mutationFn: async (rules: RuleDTO[]) => {
      let applied = 0;
      const errors: string[] = [];
      for (const r of rules) {
        try {
          const res = await api.post<{ applied: number }>(`/api/v1/rules/${r.id}/apply`, { onlyUncategorized: true });
          applied += res.applied;
        } catch (e) {
          errors.push(`${r.name}: ${errorMessage(e)}`);
        }
      }
      return { applied, errors, count: rules.length };
    },
    onSuccess: ({ applied, errors, count }) => {
      if (applied) toast.success(`${plural(applied, "lançamento reclassificado", "lançamentos reclassificados")}`, { description: count > 1 ? `${count} regras aplicadas em ordem de prioridade.` : undefined });
      else if (!errors.length) toast.info("Nenhum lançamento sem categoria corresponde às regras");
      if (errors.length) toast.error(errors[0] ?? "Falha ao aplicar regra", { description: errors.length > 1 ? `${errors.length} regras falharam` : undefined });
      invalidateFinance(qc, ["categories"]);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /** Regra de transferência: converte receitas/despesas anteriores que atendem à regra em transferências. */
  const applyTransfer = useMutation({
    mutationFn: (rule: RuleDTO) => api.post<{ applied: number }>(`/api/v1/rules/${rule.id}/apply`, { onlyUncategorized: false }),
    onSuccess: ({ applied }, rule) => {
      const account = rule.transferAccount?.name;
      if (applied)
        toast.success(`${plural(applied, "lançamento convertido", "lançamentos convertidos")} em transferência${account ? ` com ${account}` : ""}`, {
          description: "Não contam mais como receita nem despesa. Saldos recalculados.",
        });
      else toast.info("Nenhuma receita ou despesa anterior corresponde à regra", { description: "Só lançamentos em conta (fora compras no cartão e parcelados) podem virar transferência." });
      invalidateFinance(qc, ["categories", "reports"]);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /**
   * Regra de natureza aplicada aos lançamentos anteriores que a atendem: Repasse (desconsiderar), Pessoal/
   * Empresa ou "perguntar" (marca para escolher, com pendência). Saldo e fatura nunca mudam. Se a regra também
   * define categoria, os sem categoria são classificados; o servidor devolve a soma das alterações.
   */
  const applyNature = useMutation({
    mutationFn: (rule: RuleDTO) => api.post<{ applied: number }>(`/api/v1/rules/${rule.id}/apply`, { onlyUncategorized: true }),
    onSuccess: ({ applied }, rule) => {
      const scopeLabel = rule.setScope === "BUSINESS" ? "Empresa" : "Pessoal";
      if (!applied) {
        toast.info("Nenhum lançamento anterior alterado", {
          description: rule.askNature
            ? "Só entram os que atendem à regra e ainda estão como Pessoal, sem escolha pendente."
            : rule.setScope
              ? `Nenhuma receita ou despesa que atende à regra estava fora de ${scopeLabel}.`
              : "Nenhuma receita ou despesa ainda considerada atende à regra.",
        });
      } else if (rule.setCategoryId) {
        toast.success(`${plural(applied, "alteração feita", "alterações feitas")} pela regra`, {
          description: `${rule.setExcludeFromReports ? "Repasse" : rule.askNature ? "Pedido de natureza" : `Natureza ${scopeLabel}`} e categoria (nos sem categoria). O saldo e a fatura não mudam.`,
        });
      } else if (rule.setExcludeFromReports) {
        toast.success(`${plural(applied, "lançamento desconsiderado", "lançamentos desconsiderados")} nos relatórios`, { description: "O saldo da conta e a fatura do cartão não mudam." });
      } else if (rule.askNature) {
        toast.success(`${plural(applied, "lançamento aguarda", "lançamentos aguardam")} a escolha da natureza`, { description: "Escolha em Lançamentos (“Pedem natureza”) ou em Pendências. Saldo e fatura não mudam." });
      } else {
        toast.success(`${plural(applied, "lançamento marcado", "lançamentos marcados")} como ${scopeLabel}`, { description: "Só os relatórios mudam: saldo e fatura continuam iguais." });
      }
      invalidateFinance(qc, ["categories", "reports"]);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return { save, remove, apply, applyTransfer, applyNature };
}
