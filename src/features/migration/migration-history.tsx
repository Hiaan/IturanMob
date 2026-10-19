"use client";

import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { FormatTile, formatLabel } from "@/features/imports/status";
import type { MigrationListItemDTO } from "@/server/modules/migration/types";
import { MigrationStatusBadge } from "./status";
import { isBusyStatus, useMigrationList } from "./use-migration";

function openLabel(m: MigrationListItemDTO): string {
  if (m.status === "READY" || m.status === "PREVIEW") return "Continuar";
  if (isBusyStatus(m.status)) return "Acompanhar";
  return "Abrir";
}

/** "Migrações anteriores": situação, linhas e acesso a cada migração. */
export function MigrationHistory({ activeId, onOpen, timezone }: { activeId: string | null; onOpen: (id: string) => void; timezone?: string }) {
  const q = useMigrationList();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" aria-hidden /> Migrações anteriores
        </CardTitle>
        <CardDescription className="text-xs">Planilhas enviadas e a situação de cada uma. Retome uma migração em ajuste ou desfaça uma importada.</CardDescription>
      </CardHeader>
      <CardContent className="px-3 pb-3 sm:px-5 sm:pb-5">
        {q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        ) : !q.data?.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma migração ainda.</p>
        ) : (
          <ul className="divide-y">
            {q.data.map((m) => (
              <li key={m.id} className={cn("flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between", m.id === activeId && "rounded-lg bg-accent/60 px-2")}>
                <div className="flex min-w-0 items-start gap-3">
                  <FormatTile format={m.format} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{m.fileName}</span>
                      <MigrationStatusBadge status={m.status} />
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatLabel(m.format)} · enviada em {formatDateTimeBR(m.createdAt, timezone)}
                      {m.importedAt ? ` · importada em ${formatDateTimeBR(m.importedAt, timezone)}` : ""}
                      {m.undoneAt ? ` · desfeita em ${formatDateTimeBR(m.undoneAt, timezone)}` : ""}
                    </p>
                    {(m.rows !== null || m.created !== null) && (
                      <p className="mt-0.5 text-xs text-muted-foreground tabular">
                        {m.rows !== null ? `${m.rows.toLocaleString("pt-BR")} linha(s)` : ""}
                        {m.rows !== null && m.created !== null ? " · " : ""}
                        {m.created !== null ? `${m.created.toLocaleString("pt-BR")} lançamento(s) criado(s)` : ""}
                      </p>
                    )}
                    {isBusyStatus(m.status) && <Progress value={m.progress} className="mt-2 h-1.5 w-40 max-w-full" aria-label={`Progresso de ${m.fileName}`} />}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2 pl-12 sm:pl-0">
                  <Button variant={m.id === activeId ? "secondary" : "outline"} size="sm" onClick={() => onOpen(m.id)} aria-current={m.id === activeId || undefined}>
                    {openLabel(m)}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
