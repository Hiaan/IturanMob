"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { formatDateBR, formatMonthBR, isISODate, todayISO } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { useAccounts } from "@/features/finance/hooks";
import { useMe } from "@/features/me/use-me";
import { useCardMutations } from "./use-card-mutations";

export interface PayTarget {
  statementId: string;
  cardName: string;
  referenceMonth: string;
  dueDate: string;
  remainingCents: number;
  paymentAccountId: string | null;
}

/** Registra o pagamento (total ou parcial) de uma fatura a partir de uma conta. */
export function PayStatementDialog({ target, onOpenChange }: { target: PayTarget | null; onOpenChange: (o: boolean) => void }) {
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const accounts = useAccounts();
  const { pay } = useCardMutations();
  const [amount, setAmount] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [date, setDate] = useState(today);
  const [errors, setErrors] = useState<{ amount?: string; account?: string; date?: string; server?: string }>({});

  useEffect(() => {
    if (target) {
      setAmount(target.remainingCents);
      setAccountId(target.paymentAccountId ?? "");
      setDate(today);
      setErrors({});
    }
  }, [target, today]);

  const selectedAccount = accounts.data?.find((a) => a.id === accountId);

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pagar fatura</DialogTitle>
          <DialogDescription>
            {target ? `${target.cardName} · fatura de ${formatMonthBR(target.referenceMonth)} · vence em ${formatDateBR(target.dueDate)}` : ""}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const errs: typeof errors = {};
              if (amount <= 0) errs.amount = "Informe um valor maior que zero";
              if (!accountId) errs.account = "Escolha a conta de onde sai o pagamento";
              if (!isISODate(date)) errs.date = "Informe a data do pagamento";
              setErrors(errs);
              if (Object.keys(errs).length) return;
              pay.mutate(
                { statementId: target.statementId, amountCents: amount, accountId, date },
                { onSuccess: () => onOpenChange(false), onError: (err) => setErrors({ server: errorMessage(err) }) },
              );
            }}
          >
            <Field
              label="Valor do pagamento"
              htmlFor="pay-amount"
              error={errors.amount}
              hint={amount > 0 && amount < target.remainingCents ? `Pagamento parcial: restarão ${formatBRL(target.remainingCents - amount)}` : `Restante da fatura: ${formatBRL(target.remainingCents)}`}
              required
            >
              <MoneyInput id="pay-amount" size="lg" value={amount} onChange={setAmount} aria-invalid={Boolean(errors.amount)} autoFocus />
            </Field>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label="Conta de pagamento" htmlFor="pay-account" error={errors.account} required hint={selectedAccount ? `Saldo atual ${formatBRL(selectedAccount.balanceCents)}` : undefined}>
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger id="pay-account" aria-invalid={Boolean(errors.account)}>
                    <SelectValue placeholder="Selecione a conta" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* A fatura é paga em reais: contas em moeda estrangeira ficam de fora. */}
                    {(accounts.data ?? []).filter((a) => (a.currency ?? "BRL") === "BRL" || a.id === accountId).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Data do pagamento" htmlFor="pay-date" error={errors.date} required>
                <Input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>
            <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-info">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              O pagamento da fatura reduz o saldo da conta, mas não é contado como despesa: as compras já foram registradas como despesas quando aconteceram.
            </p>
            {errors.server && (
              <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {errors.server}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" variant="brand" loading={pay.isPending}>
                Registrar pagamento
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
