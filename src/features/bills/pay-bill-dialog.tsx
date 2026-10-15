"use client";

import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { formatBRL } from "@/lib/money";
import { formatDateBR, todayISO } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
import { useMe } from "@/features/me/use-me";
import { AccountSelect, CardSelect, NONE, PayWithToggle } from "@/features/recurring/pickers";
import type { BillDTO } from "./types";
import { useBillMutations } from "./use-bills";

const schema = z
  .object({
    date: z.string().length(10, "Informe a data"),
    payWith: z.enum(["account", "card"]),
    accountId: z.string(),
    creditCardId: z.string(),
    amountCents: z.number().int().positive("Informe um valor maior que zero"),
    paymentMethod: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.payWith === "card" && v.creditCardId === NONE) ctx.addIssue({ code: "custom", path: ["creditCardId"], message: "Escolha o cartão" });
  });
type Values = z.infer<typeof schema>;

const ACCOUNT_METHODS = ["PIX", "BANK_SLIP", "DEBIT_CARD", "AUTO_DEBIT", "BANK_TRANSFER", "CASH", "OTHER"] as const;

/** Registro do pagamento (ou recebimento) de uma conta prevista — cria a transação vinculada. */
export function PayBillDialog({ bill, onOpenChange }: { bill: BillDTO | null; onOpenChange: (open: boolean) => void }) {
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const { pay } = useBillMutations();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { date: today, payWith: "account", accountId: NONE, creditCardId: NONE, amountCents: 0, paymentMethod: NONE },
  });
  const { control, register, handleSubmit, reset, formState } = form;
  const payWith = useWatch({ control, name: "payWith" });
  const e = formState.errors;
  const billId = bill?.id;

  useEffect(() => {
    if (!bill) return;
    reset({
      date: today,
      payWith: bill.creditCard ? "card" : "account",
      accountId: bill.account?.id ?? NONE,
      creditCardId: bill.creditCard?.id ?? NONE,
      amountCents: bill.amountCents,
      paymentMethod: NONE,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billId]);

  if (!bill) return null;
  const income = bill.type === "INCOME";

  return (
    <Dialog open={Boolean(bill)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{income ? "Registrar recebimento" : "Registrar pagamento"}</DialogTitle>
          <DialogDescription>
            {bill.description} · vencimento {formatDateBR(bill.dueDate)} · {bill.isEstimate ? "valor estimado " : ""}
            {formatBRL(bill.amountCents)}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit((v) => {
            const card = !income && v.payWith === "card";
            pay.mutate(
              {
                id: bill.id,
                date: v.date,
                amountCents: v.amountCents,
                accountId: card || v.accountId === NONE ? null : v.accountId,
                creditCardId: card ? v.creditCardId : null,
                paymentMethod: card ? "CREDIT_CARD" : v.paymentMethod === NONE ? null : v.paymentMethod,
              },
              { onSuccess: () => onOpenChange(false) },
            );
          })}
        >
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label={income ? "Valor recebido" : "Valor pago"} htmlFor="pay-amount" error={e.amountCents?.message} hint={bill.isEstimate ? "Informe o valor real da conta" : undefined} required>
              <Controller control={control} name="amountCents" render={({ field }) => <MoneyInput id="pay-amount" value={field.value} onChange={field.onChange} aria-invalid={Boolean(e.amountCents)} />} />
            </Field>
            <Field label="Data" htmlFor="pay-date" error={e.date?.message} required>
              <Input id="pay-date" type="date" {...register("date")} />
            </Field>
          </div>
          {!income && <Controller control={control} name="payWith" render={({ field }) => <PayWithToggle value={field.value} onChange={field.onChange} />} />}
          {!income && payWith === "card" ? (
            <Field label="Cartão" htmlFor="pay-card" error={e.creditCardId?.message} hint="A compra entra na fatura do cartão (a conta fica como Lançada)." required>
              <Controller control={control} name="creditCardId" render={({ field }) => <CardSelect id="pay-card" value={field.value} onChange={field.onChange} />} />
            </Field>
          ) : (
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label={income ? "Conta que recebeu" : "Conta"} htmlFor="pay-account" hint="Define qual saldo é afetado">
                <Controller control={control} name="accountId" render={({ field }) => <AccountSelect id="pay-account" value={field.value} onChange={field.onChange} noneLabel="Não informar" />} />
              </Field>
              <Field label="Forma" htmlFor="pay-method">
                <Controller
                  control={control}
                  name="paymentMethod"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="pay-method">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Não informada</SelectItem>
                        {ACCOUNT_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {PAYMENT_METHOD_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {income ? "A receita será lançada e vinculada a esta previsão." : "A despesa será lançada e vinculada a esta conta — sem duplicar o lançamento."} É possível desfazer depois.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={pay.isPending}>
              {income ? "Confirmar recebimento" : "Confirmar pagamento"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
