"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTimeBR } from "@/lib/dates";
import { useCan } from "@/features/me/use-me";

interface IntegrityResult {
  ok: boolean;
  issues: string[];
  checkedAt: string;
}

interface RebuildResult {
  rebuiltTransactions: number;
  before: IntegrityResult;
  after: IntegrityResult;
}

/**
 * Verificação do ledger: transferências somam zero, parcelas fecham o total, compras no crédito não
 * movimentam caixa e lançamentos excluídos/pendentes não deixam movimentos. O recálculo regenera
 * os registros derivados (idempotente) sem alterar as transações.
 */
export function LedgerIntegrityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const canRebuild = useCan("settings:manage");
  const check = useQuery({
    queryKey: ["accounts", "integrity"],
    queryFn: () => api.get<IntegrityResult>("/api/v1/accounts/integrity"),
    enabled: open,
    staleTime: 0,
  });
  const rebuild = useMutation({
    mutationFn: () => api.post<RebuildResult>("/api/v1/accounts/integrity"),
    onSuccess: (res) => {
      qc.setQueryData(["accounts", "integrity"], res.after);
      ["accounts", "transactions", "cards", "analytics"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(`Saldos recalculados a partir de ${res.rebuiltTransactions} lançamento(s).`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const data = check.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Integridade dos saldos</DialogTitle>
          <DialogDescription>
            Confere se os saldos batem com os lançamentos: transferências somam zero, parcelas fecham o valor da compra e compras no crédito não movimentam a
            conta.
          </DialogDescription>
        </DialogHeader>

        {check.isLoading ? (
          <Skeleton className="h-20 rounded-lg" />
        ) : check.error ? (
          <p className="text-sm text-destructive">{errorMessage(check.error)}</p>
        ) : data ? (
          <div className="grid gap-2 rounded-lg border p-4 text-sm">
            {data.ok ? (
              <p className="flex items-center gap-2 font-medium text-positive">
                <CheckCircle2 className="size-4" /> Tudo certo: nenhuma inconsistência encontrada.
              </p>
            ) : (
              <>
                <p className="flex items-center gap-2 font-medium text-warning">
                  <CircleAlert className="size-4" /> {data.issues.length} inconsistência(s) encontrada(s)
                </p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {data.issues.slice(0, 20).map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-xs text-muted-foreground">Verificado em {formatDateTimeBR(data.checkedAt)}</p>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => check.refetch()} loading={check.isFetching && !check.isLoading}>
            <ShieldCheck /> Verificar de novo
          </Button>
          {canRebuild && (
            <Button variant="brand" onClick={() => rebuild.mutate()} loading={rebuild.isPending}>
              <RefreshCw /> Recalcular saldos
            </Button>
          )}
        </DialogFooter>
        {canRebuild && <p className="text-xs text-muted-foreground">O recálculo refaz só os movimentos derivados. Nenhum lançamento é alterado ou excluído.</p>}
      </DialogContent>
    </Dialog>
  );
}
