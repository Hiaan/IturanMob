"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { isISODate, todayISO } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";
import type { AccountDTO } from "@/features/finance/types";
import { useAccountMutations } from "./use-account-mutations";

const BANK_NOTE = "Ajuste ao saldo do banco";

/**
 * Ajuste de saldo: informa o saldo real e o sistema cria um lançamento de ajuste pela diferença.
 * `bank`: variante do painel de rendimento, para conferir o saldo com o extrato do banco.
 */
export function AdjustBalanceDialog({
  open,
  onOpenChange,
  account,
  variant = "default",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: AccountDTO | null;
  variant?: "default" | "bank";
}) {
  const bank = variant === "bank";
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const { adjust } = useAccountMutations();
  const [target, setTarget] = useState(0);
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && account) {
      setTarget(account.balanceCents);
      setDate(today);
      setNote(bank ? BANK_NOTE : "");
      setError(null);
    }
  }, [open, account, today, bank]);

  if (!account) return null;
  const diff = target - account.balanceCents;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bank ? "Ajustar ao saldo do banco" : "Ajustar saldo"}</DialogTitle>
          <DialogDescription>
            {account.name} · saldo no sistema <span className="font-medium text-foreground tabular">{formatBRL(account.balanceCents)}</span>
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!isISODate(date)) return setError("Informe uma data válida.");
            setError(null);
            adjust.mutate(
              { id: account.id, targetBalanceCents: target, date, note: note.trim() || undefined },
              { onSuccess: () => onOpenChange(false), onError: (err) => setError(errorMessage(err)) },
            );
          }}
        >
          <Field
            label={bank ? "Saldo informado pelo banco" : "Saldo real da conta"}
            htmlFor="adj-target"
            hint={bank ? "O saldo bruto que aparece no aplicativo ou extrato do banco hoje." : "Confira no aplicativo do banco. Use a tecla − para saldo negativo."}
          >
            <MoneyInput id="adj-target" size="lg" allowNegative value={target} onChange={setTarget} autoFocus />
          </Field>
          <div
            className={cn(
              "rounded-xl border px-4 py-3 text-sm",
              diff === 0 ? "bg-muted/40 text-muted-foreground" : diff > 0 ? "border-positive/30 bg-positive/5" : "border-negative/30 bg-negative/5",
            )}
            aria-live="polite"
          >
            {diff === 0 ? (
              "O saldo informado é igual ao do sistema — nenhum ajuste será criado."
            ) : (
              <>
                Será lançado um ajuste de{" "}
                <strong className={cn("tabular", diff > 0 ? "text-positive" : "text-negative")}>
                  {diff > 0 ? "+" : "−"}
                  {formatBRL(Math.abs(diff))}
                </strong>{" "}
                ({diff > 0 ? "entrada" : "saída"}) para que o saldo fique em <strong className="tabular">{formatBRL(target)}</strong>.
              </>
            )}
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Data do ajuste" htmlFor="adj-date" required>
              <Input id="adj-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Observação" htmlFor="adj-note" hint="Opcional">
              <Input id="adj-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ex.: Conferência com extrato" />
            </Field>
          </div>
          <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-info">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {bank
              ? "O ajuste corrige só o saldo (não entra como receita nem despesa). Os rendimentos seguintes passam a considerar o saldo corrigido."
              : "O ajuste corrige apenas o saldo: ele não é contado como receita nem como despesa nos relatórios e orçamentos."}
          </p>
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={adjust.isPending} disabled={diff === 0}>
              Ajustar saldo
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
