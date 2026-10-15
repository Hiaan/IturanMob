"use client";

import { CreditCard, FileSpreadsheet, FileText, History, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { BatchStatusBadge } from "./status";
import { UndoImportButton } from "./undo-dialog";
import { useImportList } from "./use-imports";

/** Histórico de importações com acesso ao lote e opção de desfazer. */
export function ImportHistory({ activeId, onOpen, timezone }: { activeId: string | null; onOpen: (id: string) => void; timezone?: string }) {
  const q = useImportList();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" aria-hidden /> Histórico de importações
        </CardTitle>
        <CardDescription className="text-xs">Arquivos enviados, situação e lançamentos criados. Importações concluídas podem ser desfeitas.</CardDescription>
      </CardHeader>
      <CardContent className="px-3 pb-3 sm:px-5 sm:pb-5">
        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        ) : !q.data?.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma importação ainda.</p>
        ) : (
          <ul className="divide-y">
            {q.data.map((b) => {
              const Icon = b.format === "XLSX" ? FileSpreadsheet : FileText;
              const DestIcon = b.creditCard ? CreditCard : Landmark;
              return (
                <li key={b.id} className={cn("flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between", b.id === activeId && "rounded-lg bg-accent/60 px-2")}>
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{b.fileName}</span>
                        <BatchStatusBadge status={b.status} />
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <span>{b.format}</span>·
                        <span className="inline-flex items-center gap-1">
                          <DestIcon className="size-3" aria-hidden /> {b.account?.name ?? b.creditCard?.name ?? "Sem conta"}
                        </span>
                        ·<span>{formatDateTimeBR(b.createdAt, timezone)}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground tabular">
                        {b.totalRows} linha(s) · {b.importedRows} criada(s) · {b.matchedRows} vinculada(s) · {b.duplicateRows} duplicada(s)
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 pl-12 sm:pl-0">
                    <Button variant={b.id === activeId ? "secondary" : "outline"} size="sm" onClick={() => onOpen(b.id)} aria-current={b.id === activeId || undefined}>
                      {b.status === "PREVIEW" ? "Continuar" : "Abrir"}
                    </Button>
                    <UndoImportButton batch={b} variant="ghost" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
