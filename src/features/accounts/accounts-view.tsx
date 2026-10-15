"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, Eye, EyeOff, Landmark, Lock, MoreHorizontal, PencilLine, Plus, Scale, ShieldCheck, Trash2, TrendingUp, Users, Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { ACCOUNT_TYPE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/features/finance/hooks";
import { useCan } from "@/features/me/use-me";
import type { AccountDTO } from "@/features/finance/types";
import { AccountIcon } from "./account-icon";
import { AccountFormDialog } from "./account-form-dialog";
import { AdjustBalanceDialog } from "./adjust-balance-dialog";
import { AccountDetailSheet } from "./account-detail-sheet";
import { useAccountMutations } from "./use-account-mutations";
import { LedgerIntegrityDialog } from "./ledger-integrity-dialog";

const SHOW_ARCHIVED_KEY = "fa:accounts:show-archived";

function SummaryTile({ label, value, hint, icon: Icon, emphasis, className }: { label: string; value: number; hint: string; icon: typeof Wallet; emphasis?: boolean; className?: string }) {
  return (
    <Card className={cn("p-4 sm:p-5", className, emphasis && "border-transparent bg-gradient-to-br from-[#0b2545] to-[#0e3a5c] text-white dark:from-[#0d2a4a] dark:to-[#0b3b37]")}>
      <div className="flex items-start justify-between gap-2">
        <p className={cn("text-[13px] font-medium", emphasis ? "text-white/75" : "text-muted-foreground")}>{label}</p>
        <span className={cn("flex size-8 items-center justify-center rounded-lg", emphasis ? "bg-white/10 text-emerald-300" : "bg-accent text-accent-foreground")}>
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      <p className={cn("mt-3 font-semibold leading-none tracking-tight tabular", emphasis ? "text-[26px]" : "text-xl sm:text-[26px]", value < 0 && !emphasis && "text-negative")}>{formatBRL(value)}</p>
      <p className={cn("mt-2 text-xs", emphasis ? "text-white/70" : "text-muted-foreground")}>{hint}</p>
    </Card>
  );
}

function AccountCard({
  account,
  canWrite,
  onOpen,
  onEdit,
  onAdjust,
  onArchive,
  onDelete,
}: {
  account: AccountDTO;
  canWrite: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onAdjust: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const archived = Boolean(account.archivedAt);
  return (
    <Card className={cn("group relative flex flex-col overflow-hidden p-5 transition hover:border-ring/40", archived && "opacity-75")}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: account.color }} aria-hidden />
      <div className="flex items-start gap-3">
        <AccountIcon type={account.type} icon={account.icon} color={account.color} />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onOpen} className="block max-w-full truncate text-left font-semibold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline">
            {account.name}
          </button>
          <p className="truncate text-xs text-muted-foreground">{[account.institution, labelOf(ACCOUNT_TYPE_LABELS, account.type)].filter(Boolean).join(" · ")}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="relative z-10 -mr-1 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ações da conta ${account.name}`}>
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>
              <Eye /> Ver detalhes
            </DropdownMenuItem>
            {canWrite && (
              <>
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilLine /> Editar
                </DropdownMenuItem>
                {!archived && (
                  <DropdownMenuItem onSelect={onAdjust}>
                    <Scale /> Ajustar saldo
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={onArchive}>
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
      <div className="mt-5">
        <p className="text-xs text-muted-foreground">Saldo atual</p>
        <p className={cn("text-2xl font-semibold tracking-tight tabular", account.balanceCents < 0 && "text-negative")}>{formatBRL(account.balanceCents)}</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {account.visibility === "PRIVATE" ? (
          <Badge variant="muted" title="Somente o titular (e quem tem permissão) vê esta conta">
            <Lock aria-hidden /> Privada
          </Badge>
        ) : (
          <Badge variant="muted">
            <Users aria-hidden /> Compartilhada
          </Badge>
        )}
        {account.ownerName && <Badge variant="outline">Titular: {account.ownerName}</Badge>}
        {!account.includeInTotals && (
          <Badge variant="warning" title="Não soma no saldo disponível">
            <EyeOff aria-hidden /> Fora dos totais
          </Badge>
        )}
        {archived && (
          <Badge variant="muted">
            <Archive aria-hidden /> Arquivada
          </Badge>
        )}
      </div>
      <p className="mt-auto pt-4 text-xs text-muted-foreground">
        {account.transactionsCount === 0 ? "Sem movimentações" : `${account.transactionsCount} ${account.transactionsCount === 1 ? "movimentação" : "movimentações"}`}
      </p>
    </Card>
  );
}

export function AccountsView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canWrite = useCan("accounts:write");
  const [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    try {
      setShowArchived(localStorage.getItem(SHOW_ARCHIVED_KEY) === "1");
    } catch {
      // armazenamento indisponível
    }
  }, []);
  const accounts = useAccounts({ includeArchived: true });
  const { archive, remove } = useAccountMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AccountDTO | null>(null);
  const [adjusting, setAdjusting] = useState<AccountDTO | null>(null);
  const [deleting, setDeleting] = useState<AccountDTO | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const all = useMemo(() => accounts.data ?? [], [accounts.data]);
  const active = all.filter((a) => !a.archivedAt);
  const archivedCount = all.length - active.length;
  const shown = showArchived ? all : active;
  const inTotals = active.filter((a) => a.includeInTotals);
  const totalCents = inTotals.reduce((s, a) => s + a.balanceCents, 0);
  const investCents = inTotals.filter((a) => a.type === "INVESTMENT").reduce((s, a) => s + a.balanceCents, 0);
  const outside = active.filter((a) => !a.includeInTotals);
  const outsideCents = outside.reduce((s, a) => s + a.balanceCents, 0);

  // ?id= abre o detalhe da conta.
  const detailId = searchParams.get("id");
  const detailAccount = detailId ? all.find((a) => a.id === detailId) ?? null : null;
  const setDetail = (id: string | null) => {
    const p = new URLSearchParams(searchParams.toString());
    if (id) p.set("id", id);
    else p.delete("id");
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  };

  const toggleArchived = (v: boolean) => {
    setShowArchived(v);
    try {
      localStorage.setItem(SHOW_ARCHIVED_KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  };

  const [integrityOpen, setIntegrityOpen] = useState(false);
  const openEdit = (a: AccountDTO | null) => {
    setEditing(a);
    setFormOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contas"
        description="Contas bancárias, carteiras e investimentos da família"
        actions={
          <>
            <Button variant="outline" onClick={() => setIntegrityOpen(true)}>
              <ShieldCheck /> Verificar integridade
            </Button>
            {canWrite && (
              <Button variant="brand" onClick={() => openEdit(null)}>
                <Plus /> Nova conta
              </Button>
            )}
          </>
        }
      />
      <LedgerIntegrityDialog open={integrityOpen} onOpenChange={setIntegrityOpen} />

      {accounts.isLoading ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[118px] rounded-xl" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[200px] rounded-xl" />
            ))}
          </div>
        </>
      ) : accounts.error ? (
        <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="Nenhuma conta cadastrada"
          description="Cadastre suas contas bancárias e carteiras para acompanhar saldos. Compras no cartão de crédito ficam em Cartões."
          action={
            canWrite && (
              <Button variant="brand" onClick={() => openEdit(null)}>
                <Plus /> Cadastrar conta
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryTile emphasis className="col-span-2 sm:col-span-1" label="Saldo total" value={totalCents} icon={Wallet} hint={`${inTotals.length} ${inTotals.length === 1 ? "conta incluída" : "contas incluídas"} nos totais`} />
            <SummaryTile label="Disponível (sem investimentos)" value={totalCents - investCents} icon={Landmark} hint="Contas correntes, digitais, poupança e carteiras" />
            {outside.length > 0 ? (
              <SummaryTile label="Fora dos totais" value={outsideCents} icon={EyeOff} hint={`${outside.length} ${outside.length === 1 ? "conta acompanhada" : "contas acompanhadas"} separadamente`} />
            ) : (
              <SummaryTile label="Investimentos" value={investCents} icon={TrendingUp} hint="Contas do tipo investimento incluídas nos totais" />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {shown.length} {shown.length === 1 ? "conta" : "contas"}
            </h2>
            {archivedCount > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={showArchived} onCheckedChange={toggleArchived} aria-label="Mostrar contas arquivadas" />
                Mostrar arquivadas ({archivedCount})
              </label>
            )}
          </div>

          {shown.length === 0 ? (
            <EmptyState icon={Archive} title="Todas as contas estão arquivadas" description="Ative “Mostrar arquivadas” para vê-las ou cadastre uma nova conta." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  canWrite={canWrite}
                  onOpen={() => setDetail(a.id)}
                  onEdit={() => openEdit(a)}
                  onAdjust={() => setAdjusting(a)}
                  onArchive={() => archive.mutate({ id: a.id, archived: !a.archivedAt })}
                  onDelete={() => {
                    setDeleteError(null);
                    setDeleting(a);
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      <AccountFormDialog open={formOpen} onOpenChange={setFormOpen} account={editing} />
      <AdjustBalanceDialog open={Boolean(adjusting)} onOpenChange={(o) => !o && setAdjusting(null)} account={adjusting} />
      <AccountDetailSheet
        account={detailAccount}
        open={Boolean(detailId) && !accounts.isLoading}
        onOpenChange={(o) => !o && setDetail(null)}
        canWrite={canWrite}
        onEdit={() => detailAccount && openEdit(detailAccount)}
        onAdjust={() => detailAccount && setAdjusting(detailAccount)}
      />
      <AlertDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir a conta {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Só é possível excluir contas sem movimentações. Contas com histórico devem ser arquivadas: elas saem das listas, mas os lançamentos e relatórios são preservados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            {deleteError && deleting && !deleting.archivedAt && (
              <Button
                variant="outline"
                onClick={() => {
                  archive.mutate({ id: deleting.id, archived: true });
                  setDeleting(null);
                }}
              >
                <Archive /> Arquivar
              </Button>
            )}
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    if (detailId === deleting.id) setDetail(null);
                    setDeleting(null);
                  },
                  onError: (e) => setDeleteError(errorMessage(e)),
                })
              }
            >
              <Trash2 /> Excluir conta
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
