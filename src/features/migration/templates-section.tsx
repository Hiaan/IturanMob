"use client";

import { useId, useState } from "react";
import { BookmarkCheck, ChevronDown, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ErrorState } from "@/components/shared/error-state";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { MigrationTemplateDTO } from "@/server/modules/migration/types";
import { plural } from "./labels";
import { useDeleteTemplate, useMigrationTemplates } from "./use-migration";

/** "Formatos salvos": formatos de planilha lembrados para a próxima migração (com exclusão). */
export function TemplatesSection({ timezone }: { timezone?: string }) {
  const [open, setOpen] = useState(false);
  const [toDelete, setToDelete] = useState<MigrationTemplateDTO | null>(null);
  const q = useMigrationTemplates();
  const remove = useDeleteTemplate();
  const panelId = useId();
  const count = q.data?.length ?? 0;

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-3 rounded-xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5"
      >
        <span className="flex min-w-0 items-start gap-2">
          <BookmarkCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold">Formatos salvos{q.data ? ` (${count})` : ""}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Planilhas com um formato salvo já chegam com abas, colunas e correspondências preenchidas — o app só pergunta o que for novo.
            </span>
          </span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div id={panelId} className="border-t px-3 pb-3 sm:px-5 sm:pb-5">
          {q.isLoading ? (
            <div className="space-y-2 pt-3">
              <Skeleton className="h-12 rounded-lg" />
              <Skeleton className="h-12 rounded-lg" />
            </div>
          ) : q.error ? (
            <div className="pt-3">
              <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
            </div>
          ) : !count ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhum formato salvo. Ao migrar, ligue “Salvar este formato para a próxima planilha” na etapa de correspondências.
            </p>
          ) : (
            <ul className="divide-y">
              {q.data!.map((t) => (
                <li key={t.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{t.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {plural(t.sheets, "aba", "abas")} · {plural(t.correspondences, "correspondência", "correspondências")} · usado {plural(t.timesUsed, "vez", "vezes")}
                      {t.lastUsedAt ? ` · último uso em ${formatDateTimeBR(t.lastUsedAt, timezone)}` : ` · salvo em ${formatDateTimeBR(t.createdAt, timezone)}`}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="self-start text-destructive hover:text-destructive sm:self-auto" onClick={() => setToDelete(t)} disabled={remove.isPending}>
                    <Trash2 aria-hidden /> Excluir
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <AlertDialog open={Boolean(toDelete)} onOpenChange={(v) => !v && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir o formato “{toDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              As próximas planilhas com este formato serão interpretadas do zero (abas, colunas e correspondências). Migrações já feitas e os lançamentos importados não mudam.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (toDelete) remove.mutate(toDelete, { onSettled: () => setToDelete(null) });
              }}
            >
              {remove.isPending ? "Excluindo…" : "Excluir formato"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
