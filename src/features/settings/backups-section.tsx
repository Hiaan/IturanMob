"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, Copy, Database, DatabaseBackup, FileArchive, Lock, ShieldAlert, ShieldCheck, TerminalSquare, XCircle, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";

interface BackupDTO {
  id: string;
  kind: "DATABASE_DUMP" | "HOUSEHOLD_EXPORT";
  status: "SUCCESS" | "FAILED" | "VERIFIED" | "CORRUPTED";
  fileName: string;
  sha256: string | null;
  sizeBytes: number | null;
  error: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

interface Instructions {
  databaseDump: string[];
  jsonExport: string[];
  cli: string[];
}

const KEY = ["settings", "backups"] as const;

const STATUS: Record<BackupDTO["status"], { label: string; icon: LucideIcon; variant: "positive" | "info" | "negative" | "warning" }> = {
  VERIFIED: { label: "Verificado", icon: ShieldCheck, variant: "positive" },
  SUCCESS: { label: "Concluído", icon: CheckCircle2, variant: "info" },
  FAILED: { label: "Falhou", icon: XCircle, variant: "negative" },
  CORRUPTED: { label: "Corrompido", icon: ShieldAlert, variant: "warning" },
};

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

function StatusBadge({ status }: { status: BackupDTO["status"] }) {
  const meta = STATUS[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon aria-hidden /> {meta.label}
    </Badge>
  );
}

function ShaChip({ sha }: { sha: string | null }) {
  if (!sha) return <span className="text-muted-foreground">—</span>;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(sha);
          toast.success("SHA-256 copiado");
        } catch {
          toast.error("Não foi possível copiar.");
        }
      }}
      className="inline-flex items-center gap-1 rounded-md px-1 font-mono text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
      title={`SHA-256: ${sha} (clique para copiar)`}
      aria-label="Copiar SHA-256 completo"
    >
      {sha.slice(0, 12)}… <Copy className="size-3" aria-hidden />
    </button>
  );
}

function VerifyButton({ backup }: { backup: BackupDTO }) {
  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; status: string; message: string }>(`/api/v1/backups/${backup.id}/verify`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: KEY });
      if (r.ok) toast.success("Integridade verificada", { description: r.message });
      else toast.error("Backup com problema", { description: r.message });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (backup.status === "FAILED") return null;
  return (
    <Button variant="outline" size="sm" onClick={() => verify.mutate()} loading={verify.isPending}>
      <ShieldCheck /> Verificar integridade
    </Button>
  );
}

function RestoreInstructions({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: [...KEY, "instructions"], queryFn: () => api.get<Instructions>("/api/v1/backups/instructions"), enabled: enabled && open, staleTime: Infinity });
  return (
    <div className="rounded-lg border">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 p-4 text-left">
        <span className="flex items-center gap-2 text-sm font-medium">
          <TerminalSquare className="size-4 text-muted-foreground" aria-hidden /> Como restaurar um backup
        </span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="space-y-4 border-t p-4 text-sm">
          {q.isLoading ? (
            <Skeleton className="h-32 rounded-lg" />
          ) : q.data ? (
            <>
              <div>
                <p className="mb-2 font-medium">Banco completo (pg_dump)</p>
                <ol className="space-y-1 text-muted-foreground">
                  {q.data.databaseDump.map((l) => (
                    <li key={l} className={cn("break-words", /^\s/.test(l) && "pl-4")}>
                      {l}
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <p className="mb-2 font-medium">Exportação JSON (sem pg_dump no servidor)</p>
                <ul className="space-y-1 text-muted-foreground">
                  {q.data.jsonExport.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-2 font-medium">Linha de comando no servidor</p>
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{q.data.cli.join("\n")}</pre>
              </div>
            </>
          ) : (
            <div className="space-y-2 text-muted-foreground">
              <p>Restaure com o PostgreSQL em um banco vazio:</p>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">
                {"pg_restore --no-owner --no-privileges -h HOST -U USUARIO -d BANCO_NOVO arquivo.dump"}
              </pre>
              <p>Depois aponte DATABASE_URL para o banco restaurado e rode pnpm db:deploy.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Seção de Configurações: backups do banco (lista, criar agora, verificar integridade e restauração). */
export function BackupsSection() {
  const me = useMe();
  const canManage = useCan("settings:manage");
  const isOwner = me.data?.member.role === "OWNER";
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<BackupDTO[]>("/api/v1/backups", { limit: 30 }), enabled: canManage });
  const create = useMutation({
    mutationFn: () => api.post<BackupDTO>("/api/v1/backups"),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: KEY });
      if (b.status === "FAILED") toast.error("O backup falhou", { description: b.error ?? undefined });
      else toast.success("Backup concluído", { description: `${b.fileName} · ${formatSize(b.sizeBytes)} · ${STATUS[b.status].label.toLowerCase()}` });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const latest = q.data?.find((b) => b.status === "VERIFIED" || b.status === "SUCCESS");

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <DatabaseBackup className="size-4 text-brand" aria-hidden /> Backups
          </CardTitle>
          <CardDescription className="mt-1">
            Cópias periódicas do banco com verificação de integridade (SHA-256). {latest ? `Último backup válido: ${formatDateTimeBR(latest.createdAt, me.data?.household.timezone)}.` : ""}
          </CardDescription>
        </div>
        {canManage && (
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!isOwner} title={isOwner ? undefined : "Somente o proprietário pode iniciar um backup"}>
            <Database /> Fazer backup agora
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!canManage ? (
          <p className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" aria-hidden /> Somente administradores podem consultar os backups.
          </p>
        ) : q.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        ) : !q.data?.length ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <FileArchive className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">Nenhum backup ainda</p>
            <p className="max-w-sm text-xs text-muted-foreground">O backup automático roda no intervalo configurado no servidor. {isOwner ? "Você também pode fazer um agora." : ""}</p>
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Data</th>
                    <th className="px-3 py-2 font-medium">Tipo</th>
                    <th className="px-3 py-2 text-right font-medium">Tamanho</th>
                    <th className="px-3 py-2 font-medium">Situação</th>
                    <th className="px-3 py-2 font-medium">SHA-256</th>
                    <th className="py-2 pl-3" />
                  </tr>
                </thead>
                <tbody>
                  {q.data.map((b) => (
                    <tr key={b.id} className="border-b last:border-0">
                      <td className="py-3 pr-3 tabular">
                        {formatDateTimeBR(b.createdAt, me.data?.household.timezone)}
                        <span className="block max-w-56 truncate text-xs text-muted-foreground" title={b.fileName}>
                          {b.fileName}
                        </span>
                      </td>
                      <td className="px-3 py-3">{b.kind === "DATABASE_DUMP" ? "Banco completo (pg_dump)" : "Exportação JSON"}</td>
                      <td className="px-3 py-3 text-right tabular">{formatSize(b.sizeBytes)}</td>
                      <td className="px-3 py-3">
                        <StatusBadge status={b.status} />
                        {b.error && <span className="mt-1 block max-w-56 text-xs text-muted-foreground">{b.error}</span>}
                      </td>
                      <td className="px-3 py-3">
                        <ShaChip sha={b.sha256} />
                      </td>
                      <td className="py-3 pl-3 text-right">
                        <VerifyButton backup={b} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y md:hidden">
              {q.data.map((b) => (
                <li key={b.id} className="space-y-2 py-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium tabular">{formatDateTimeBR(b.createdAt, me.data?.household.timezone)}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.kind === "DATABASE_DUMP" ? "Banco completo (pg_dump)" : "Exportação JSON"} · {formatSize(b.sizeBytes)}
                      </p>
                    </div>
                    <StatusBadge status={b.status} />
                  </div>
                  {b.error && <p className="text-xs text-muted-foreground">{b.error}</p>}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <ShaChip sha={b.sha256} />
                    <VerifyButton backup={b} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {canManage && !isOwner && <p className="text-xs text-muted-foreground">Somente o proprietário pode iniciar um backup manual; administradores podem verificar a integridade.</p>}
        {canManage && <RestoreInstructions enabled={canManage} />}
      </CardContent>
    </Card>
  );
}
