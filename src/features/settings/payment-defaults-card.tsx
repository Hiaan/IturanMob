"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Wallet } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
import { useAccounts } from "@/features/finance/hooks";
import { useMe } from "@/features/me/use-me";

const NONE = "__none";
const METHODS = ["PIX", "DEBIT_CARD", "CASH", "BANK_TRANSFER", "BANK_SLIP", "AUTO_DEBIT", "VOUCHER", "OTHER"] as const;

/** Conta e forma de pagamento padrão de quem está logado (gasto sem conta dita sai daqui). */
export function PaymentDefaultsCard() {
  const me = useMe();
  const accounts = useAccounts();
  const qc = useQueryClient();
  const current = me.data?.paymentDefaults ?? null;
  const [accountId, setAccountId] = useState(NONE);
  const [method, setMethod] = useState(NONE);

  useEffect(() => {
    setAccountId(current?.accountId ?? NONE);
    setMethod(current?.paymentMethod ?? NONE);
  }, [current?.accountId, current?.paymentMethod]);

  const save = useMutation({
    mutationFn: () =>
      api.put("/api/v1/me/payment-defaults", {
        accountId: accountId === NONE ? null : accountId,
        paymentMethod: accountId === NONE || method === NONE ? null : method,
      }),
    onSuccess: () => {
      toast.success(accountId === NONE ? "Conta padrão removida." : "Conta padrão salva.");
      void qc.invalidateQueries({ queryKey: qk.me });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const options = (accounts.data ?? []).filter((a) => a.type !== "INVESTMENT" && !a.archivedAt);
  const dirty = accountId !== (current?.accountId ?? NONE) || (accountId !== NONE && method !== (current?.paymentMethod ?? NONE));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="size-4" aria-hidden /> Minha conta padrão de pagamento
        </CardTitle>
        <CardDescription>
          Quando você registrar um gasto sem dizer de onde saiu (no WhatsApp, com a Isa ou no lançamento rápido), ele sai desta conta, com esta forma de pagamento. Cada pessoa da família escolhe a sua.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Conta" htmlFor="default-account">
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="default-account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nenhuma (perguntar)</SelectItem>
                {options.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Forma de pagamento" htmlFor="default-method">
            <Select value={accountId === NONE ? NONE : method} onValueChange={setMethod} disabled={accountId === NONE}>
              <SelectTrigger id="default-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Não definida</SelectItem>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">Compras no cartão de crédito continuam indo para o cartão citado. Entradas (receitas) não usam este padrão.</p>
        <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          Salvar
        </Button>
      </CardContent>
    </Card>
  );
}
