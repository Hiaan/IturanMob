"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ArrowLeftRight, ChevronDown, List, MoreHorizontal, PencilLine, Plus, Shuffle, Tags, Trash2, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { useCategories } from "@/features/finance/hooks";
import { useCan } from "@/features/me/use-me";
import type { CategoryDTO, SubcategoryDTO } from "@/features/finance/types";
import { CategoryIcon } from "./category-icon";
import { CategoryFormDialog, DeleteCategoryDialog, ReclassifyDialog, SubcategoryDialog } from "./category-dialogs";
import { KeywordEditor } from "./keyword-editor";
import { RulesSection } from "./rules-section";
import { useCategoryMutations } from "./use-category-mutations";

const PREFS_KEY = "fa:categories:prefs";

function SubcategoryRow({
  category,
  sub,
  canWrite,
  canReclassify,
  onEdit,
  onReclassify,
  onDelete,
}: {
  category: CategoryDTO;
  sub: SubcategoryDTO;
  canWrite: boolean;
  canReclassify: boolean;
  onEdit: () => void;
  onReclassify: () => void;
  onDelete: () => void;
}) {
  const { saveSubcategory, archiveSubcategory } = useCategoryMutations();
  const [keywords, setKeywords] = useState(sub.keywords);
  useEffect(() => setKeywords(sub.keywords), [sub.keywords]);
  const archived = Boolean(sub.archivedAt);

  const saveKeywords = (next: string[]) => {
    const prev = keywords;
    setKeywords(next);
    saveSubcategory.mutate(
      { id: sub.id, input: { keywords: next } },
      {
        onError: (e) => {
          setKeywords(prev);
          toast.error(errorMessage(e));
        },
      },
    );
  };

  return (
    <li className={cn("rounded-lg border bg-background/60 p-3", archived && "opacity-70")}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{sub.name}</span>
          {archived && (
            <Badge variant="muted">
              <Archive aria-hidden /> Arquivada
            </Badge>
          )}
          {saveSubcategory.isPending && <span className="text-xs font-normal text-muted-foreground">salvando…</span>}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ações da subcategoria ${sub.name}`}>
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/transacoes?subcategoryId=${sub.id}`}>
                <List /> Ver transações
              </Link>
            </DropdownMenuItem>
            {canWrite && (
              <DropdownMenuItem onSelect={onEdit}>
                <PencilLine /> Renomear / palavras-chave
              </DropdownMenuItem>
            )}
            {canReclassify && (
              <DropdownMenuItem onSelect={onReclassify}>
                <Shuffle /> Reclassificar transações
              </DropdownMenuItem>
            )}
            {canWrite && (
              <>
                <DropdownMenuItem onSelect={() => archiveSubcategory.mutate({ id: sub.id, archived: !archived })}>
                  {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Desarquivar" : "Arquivar"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 /> Excluir
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {canWrite ? (
        <KeywordEditor keywords={keywords} onChange={saveKeywords} disabled={archived} />
      ) : keywords.length ? (
        <div className="flex flex-wrap gap-1.5">
          {keywords.map((k) => (
            <span key={k} className="rounded-md bg-muted px-2 py-0.5 text-xs">
              {k}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Sem palavras-chave.</p>
      )}
    </li>
  );
}

function CategoryItem({
  category,
  expanded,
  onToggle,
  showArchived,
  canWrite,
  canReclassify,
  onEdit,
  onAddSub,
  onEditSub,
  onDeleteSub,
  onReclassify,
  onDelete,
}: {
  category: CategoryDTO;
  expanded: boolean;
  onToggle: () => void;
  showArchived: boolean;
  canWrite: boolean;
  canReclassify: boolean;
  onEdit: () => void;
  onAddSub: () => void;
  onEditSub: (s: SubcategoryDTO) => void;
  onDeleteSub: (s: SubcategoryDTO) => void;
  onReclassify: (s?: SubcategoryDTO) => void;
  onDelete: () => void;
}) {
  const { archiveCategory } = useCategoryMutations();
  const archived = Boolean(category.archivedAt);
  const subs = category.subcategories.filter((s) => showArchived || !s.archivedAt);
  const activeSubs = category.subcategories.filter((s) => !s.archivedAt).length;
  const panelId = `cat-panel-${category.id}`;

  return (
    <li>
      <Card className={cn("overflow-hidden", archived && "opacity-75")}>
        <div className="flex items-center gap-3 p-3 sm:p-4">
          <CategoryIcon icon={category.icon} color={category.color} />
          <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={panelId} className="min-w-0 flex-1 text-left outline-none focus-visible:underline">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-medium">{category.name}</span>
              {category.isSystem && <Badge variant="muted">Padrão</Badge>}
              {archived && (
                <Badge variant="muted">
                  <Archive aria-hidden /> Arquivada
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {category.transactionsCount} {category.transactionsCount === 1 ? "transação" : "transações"} · {activeSubs} {activeSubs === 1 ? "subcategoria" : "subcategorias"}
            </span>
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={expanded ? `Recolher ${category.name}` : `Expandir ${category.name}`}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ações da categoria ${category.name}`}>
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/transacoes?categoryId=${category.id}`}>
                  <List /> Ver transações
                </Link>
              </DropdownMenuItem>
              {canWrite && (
                <>
                  <DropdownMenuItem onSelect={onEdit}>
                    <PencilLine /> Editar
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onAddSub}>
                    <Plus /> Nova subcategoria
                  </DropdownMenuItem>
                </>
              )}
              {canReclassify && (
                <DropdownMenuItem onSelect={() => onReclassify()}>
                  <Shuffle /> Reclassificar transações
                </DropdownMenuItem>
              )}
              {canWrite && (
                <>
                  <DropdownMenuItem onSelect={() => archiveCategory.mutate({ id: category.id, archived: !archived })}>
                    {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Desarquivar" : "Arquivar"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2 /> Excluir
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded && (
          <div id={panelId} className="space-y-2 border-t bg-muted/20 p-3 sm:p-4">
            {subs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma subcategoria.</p>
            ) : (
              <ul className="grid gap-2">
                {subs.map((s) => (
                  <SubcategoryRow
                    key={s.id}
                    category={category}
                    sub={s}
                    canWrite={canWrite}
                    canReclassify={canReclassify}
                    onEdit={() => onEditSub(s)}
                    onReclassify={() => onReclassify(s)}
                    onDelete={() => onDeleteSub(s)}
                  />
                ))}
              </ul>
            )}
            {canWrite && !archived && (
              <Button size="sm" variant="ghost" onClick={onAddSub}>
                <Plus /> Adicionar subcategoria
              </Button>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

export function CategoriesView() {
  const categories = useCategories({ includeArchived: true });
  const canWrite = useCan("categories:write");
  const canReclassify = useCan("transactions:write");
  const { deleteSubcategory } = useCategoryMutations();
  const [kind, setKind] = useState<"EXPENSE" | "INCOME">("EXPENSE");
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [catForm, setCatForm] = useState<{ open: boolean; category: CategoryDTO | null }>({ open: false, category: null });
  const [subForm, setSubForm] = useState<{ open: boolean; category: CategoryDTO | null; sub: SubcategoryDTO | null }>({ open: false, category: null, sub: null });
  const [deleting, setDeleting] = useState<CategoryDTO | null>(null);
  const [deletingSub, setDeletingSub] = useState<SubcategoryDTO | null>(null);
  const [deleteSubError, setDeleteSubError] = useState<string | null>(null);
  const [reclassifying, setReclassifying] = useState<{ category: CategoryDTO; subcategory?: SubcategoryDTO | null } | null>(null);

  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as { kind?: "EXPENSE" | "INCOME"; showArchived?: boolean };
      if (p.kind === "EXPENSE" || p.kind === "INCOME") setKind(p.kind);
      if (typeof p.showArchived === "boolean") setShowArchived(p.showArchived);
    } catch {
      // armazenamento indisponível
    }
  }, []);
  const savePrefs = (patch: { kind?: "EXPENSE" | "INCOME"; showArchived?: boolean }) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ kind, showArchived, ...patch }));
    } catch {
      // ignore
    }
  };

  const all = useMemo(() => categories.data ?? [], [categories.data]);
  const ofKind = all.filter((c) => c.kind === kind);
  const shown = ofKind.filter((c) => showArchived || !c.archivedAt);
  const archivedCount = ofKind.filter((c) => c.archivedAt).length + ofKind.reduce((s, c) => s + c.subcategories.filter((x) => x.archivedAt).length, 0);
  const counts = { EXPENSE: all.filter((c) => c.kind === "EXPENSE" && !c.archivedAt).length, INCOME: all.filter((c) => c.kind === "INCOME" && !c.archivedAt).length };
  const subCategoryOf = (s: SubcategoryDTO) => all.find((c) => c.subcategories.some((x) => x.id === s.id)) ?? null;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Categorias"
        description="Organize despesas e receitas, subcategorias, palavras-chave e regras automáticas"
        actions={
          canWrite && (
            <Button variant="brand" onClick={() => setCatForm({ open: true, category: null })}>
              <Plus /> Nova categoria
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={kind}
          onValueChange={(v) => {
            setKind(v as "EXPENSE" | "INCOME");
            savePrefs({ kind: v as "EXPENSE" | "INCOME" });
          }}
        >
          <TabsList>
            <TabsTrigger value="EXPENSE">
              <TrendingDown /> Despesas <span className="text-xs tabular text-muted-foreground">{counts.EXPENSE}</span>
            </TabsTrigger>
            <TabsTrigger value="INCOME">
              <TrendingUp /> Receitas <span className="text-xs tabular text-muted-foreground">{counts.INCOME}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-3">
          {shown.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((prev) => (shown.every((c) => prev.has(c.id)) ? new Set() : new Set(shown.map((c) => c.id))))}
            >
              {shown.every((c) => expanded.has(c.id)) ? "Recolher todas" : "Expandir todas"}
            </Button>
          )}
          {archivedCount > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={showArchived}
                onCheckedChange={(v) => {
                  setShowArchived(v);
                  savePrefs({ showArchived: v });
                }}
                aria-label="Mostrar arquivadas"
              />
              Mostrar arquivadas ({archivedCount})
            </label>
          )}
        </div>
      </div>

      {categories.isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-xl" />
          ))}
        </div>
      ) : categories.error ? (
        <ErrorState error={categories.error} onRetry={() => categories.refetch()} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Tags}
          title={kind === "INCOME" ? "Nenhuma categoria de receita" : "Nenhuma categoria de despesa"}
          description="Crie categorias para organizar os lançamentos e acompanhar orçamentos."
          action={
            canWrite && (
              <Button variant="brand" onClick={() => setCatForm({ open: true, category: null })}>
                <Plus /> Nova categoria
              </Button>
            )
          }
        />
      ) : (
        <ul className="grid items-start gap-3 lg:grid-cols-2">
          {shown.map((c) => (
            <CategoryItem
              key={c.id}
              category={c}
              expanded={expanded.has(c.id)}
              onToggle={() => toggle(c.id)}
              showArchived={showArchived}
              canWrite={canWrite}
              canReclassify={canReclassify}
              onEdit={() => setCatForm({ open: true, category: c })}
              onAddSub={() => {
                setExpanded((prev) => new Set(prev).add(c.id));
                setSubForm({ open: true, category: c, sub: null });
              }}
              onEditSub={(s) => setSubForm({ open: true, category: c, sub: s })}
              onDeleteSub={(s) => {
                setDeleteSubError(null);
                setDeletingSub(s);
              }}
              onReclassify={(s) => setReclassifying({ category: c, subcategory: s ?? null })}
              onDelete={() => setDeleting(c)}
            />
          ))}
        </ul>
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowLeftRight className="size-3.5" aria-hidden />
        Transferências entre contas, pagamentos de fatura e ajustes de saldo não usam categorias.
      </p>

      <RulesSection />

      <CategoryFormDialog open={catForm.open} onOpenChange={(o) => setCatForm((s) => ({ ...s, open: o }))} category={catForm.category} defaultKind={kind} />
      <SubcategoryDialog open={subForm.open} onOpenChange={(o) => setSubForm((s) => ({ ...s, open: o }))} category={subForm.category} subcategory={subForm.sub} />
      <DeleteCategoryDialog category={deleting} onOpenChange={(o) => !o && setDeleting(null)} />
      <ReclassifyDialog open={Boolean(reclassifying)} onOpenChange={(o) => !o && setReclassifying(null)} from={reclassifying} />
      <AlertDialog open={Boolean(deletingSub)} onOpenChange={(o) => !o && setDeletingSub(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir a subcategoria {deletingSub?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Só é possível excluir subcategorias sem transações. Se houver uso, reclassifique as transações antes ou arquive a subcategoria.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteSubError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {deleteSubError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            {deleteSubError && deletingSub && canReclassify && subCategoryOf(deletingSub) && (
              <Button
                variant="outline"
                onClick={() => {
                  const cat = subCategoryOf(deletingSub);
                  if (cat) setReclassifying({ category: cat, subcategory: deletingSub });
                  setDeletingSub(null);
                }}
              >
                <Shuffle /> Reclassificar
              </Button>
            )}
            <Button
              variant="destructive"
              loading={deleteSubcategory.isPending}
              onClick={() => deletingSub && deleteSubcategory.mutate(deletingSub.id, { onSuccess: () => setDeletingSub(null), onError: (e) => setDeleteSubError(errorMessage(e)) })}
            >
              <Trash2 /> Excluir
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
