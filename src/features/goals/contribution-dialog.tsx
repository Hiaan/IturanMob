"use client";

import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRightLeft, Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { formatBRL } from "@/lib/money";
import { todayISO } from "@/lib/dates";
import { useAccounts } from "@/features/finance/hooks";
import { useMe } from "@/features/me/use-me";
import type { GoalDTO } from "./types";
import { useGoalMutations } from "./use-goals";

const NONE = "__none__";

export type ContributionMode = "contribute" | "withdraw";

/** Explica o efeito da operação: alocação interna (sem movimento) ou transferência (nunca despesa). */
export function contributionEffect(goal: GoalDTO, accountId: string | null, accountName: string | null, mode: ContributionMode): { transfer: boolean; text: string } {
  if (!accountId) {
    return {
      transfer: false,
      text:
        mode === "contribute"
          ? "Alocação interna: o valor fica reservado para a meta, sem movimentar saldos e sem gerar despesa."
          : "Resgate interno: o valor deixa de estar reservado para a meta, sem movimentar saldos.",
    };
  }
  if (!goal.accountId) {
    return { transfer: false, text: "Esta meta não tem conta vinculada, então será uma alocação interna (sem movimentar saldos). Vincule uma conta à meta para registrar transferências." };
  }
  if (goal.accountId === accountId) {
    return { transfer: false, text: "O dinheiro já está na conta da meta: será registrada uma alocação interna, sem movimentação." };
  }
  const goalAccount = goal.account?.name ?? "conta da meta";
  return {
    transfer: true,
    text:
      mode === "contribute"
        ? `Será registrada uma transferência de ${accountName} para ${goalAccount}. Os saldos mudam, mas transferências não contam como despesa.`
        : `Será registrada uma transferência de ${goalAccount} para ${accountName}. Os saldos mudam, mas transferências não contam como receita.`,
  };
}

/** Contribuição (valor positivo) ou resgate (valor negativo) de uma meta. */
export function ContributionDialog({ goal, mode, onOpenChange }: { goal: GoalDTO | null; mode: ContributionMode; onOpenChange: (open: boolean) => void }) {
  const me = useMe();
  const accounts = useAccounts();
  const { contribute } = useGoalMutations();
  const maxWithdraw = goal?.savedCents ?? 0;
  const schema = z.object({
    amountCents: z
      .number()
      .int()
      .positive("Informe um valor maior que zero")
      .refine((v) => mode === "contribute" || v <= maxWithdraw, `O resgate não pode passar do acumulado (${formatBRL(maxWithdraw)})`),
    date: z.string().length(10, "Informe a data"),
    accountId: z.string(),
    note: z.string().max(500).optional(),
  });
  type Values = z.infer<typeof schema>;
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { amountCents: 0, date: todayISO(me.data?.household.timezone), accountId: NONE, note: "" } });
  const { control, register, handleSubmit, reset, formState } = form;
  const accountId = useWatch({ control, name: "accountId" });
  const e = formState.errors;

  const goalId = goal?.id;
  useEffect(() => {
    if (goalId) reset({ amountCents: 0, date: todayISO(me.data?.household.timezone), accountId: NONE, note: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId, mode, reset]);

  if (!goal) return null;
  const selected = accountId === NONE ? null : accountId;
  const accountName = (accounts.data ?? []).find((a) => a.id === selected)?.name ?? null;
  const effect = contributionEffect(goal, selected, accountName, mode);
  const withdraw = mode === "withdraw";

  return (
    <Dialog open={Boolean(goal)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{withdraw ? "Resgatar da meta" : "Contribuir para a meta"}</DialogTitle>
          <DialogDescription>
            {goal.name} · acumulado {formatBRL(goal.savedCents)} de {formatBRL(goal.targetCents)}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit((v) =>
            contribute.mutate(
              {
                goalId: goal.id,
                amountCents: withdraw ? -v.amountCents : v.amountCents,
                date: v.date,
                fromAccountId: v.accountId === NONE ? null : v.accountId,
                note: v.note?.trim() || null,
              },
              { onSuccess: () => onOpenChange(false) },
            ),
          )}
        >
          <Field label={withdraw ? "Valor do resgate" : "Valor"} htmlFor="contrib-amount" error={e.amountCents?.message} required>
            <Controller
              control={control}
              name="amountCents"
              render={({ field }) => <MoneyInput id="contrib-amount" size="lg" value={field.value} onChange={field.onChange} autoFocus aria-invalid={Boolean(e.amountCents)} />}
            />
          </Field>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Data" htmlFor="contrib-date" error={e.date?.message} required>
              <Input id="contrib-date" type="date" {...register("date")} />
            </Field>
            <Field label={withdraw ? "Conta que recebe" : "Conta de origem"} htmlFor="contrib-account" hint="Opcional">
              <Controller
                control={control}
                name="accountId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="contrib-account">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Nenhuma</SelectItem>
                      {(accounts.data ?? []).map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <div className="flex gap-2.5 rounded-lg border bg-muted/40 p-3 text-sm" role="note">
            {effect.transfer ? <ArrowRightLeft className="mt-0.5 size-4 shrink-0 text-info" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <p className="text-muted-foreground">{effect.text}</p>
          </div>
          <Field label="Observação" htmlFor="contrib-note">
            <Input id="contrib-note" placeholder="Opcional" {...register("note")} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={contribute.isPending}>
              {withdraw ? "Registrar resgate" : "Registrar contribuição"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
