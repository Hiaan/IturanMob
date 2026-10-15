"use client";

import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { todayISO } from "@/lib/dates";
import { ACCOUNT_TYPE_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useMembers } from "@/features/finance/hooks";
import { useMe } from "@/features/me/use-me";
import type { AccountDTO } from "@/features/finance/types";
import { ACCOUNT_COLORS, ACCOUNT_TYPE_ICON, AccountIcon, ColorSwatches } from "./account-icon";
import { useAccountMutations } from "./use-account-mutations";

const NONE = "__none__";

const schema = z.object({
  name: z.string().trim().min(1, "Informe o nome da conta").max(60, "Use no máximo 60 caracteres"),
  institution: z.string().trim().max(60, "Use no máximo 60 caracteres"),
  type: z.enum(["CHECKING", "SAVINGS", "WALLET", "INVESTMENT", "DIGITAL", "OTHER"]),
  visibility: z.enum(["SHARED", "PRIVATE"]),
  ownerMemberId: z.string(),
  initialBalanceCents: z.number().int(),
  initialBalanceDate: z.string().length(10, "Informe a data do saldo inicial"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida"),
  includeInTotals: z.boolean(),
});
type Values = z.infer<typeof schema>;

function defaults(account: AccountDTO | null | undefined, today: string): Values {
  return account
    ? {
        name: account.name,
        institution: account.institution ?? "",
        type: account.type as Values["type"],
        visibility: account.visibility as Values["visibility"],
        ownerMemberId: account.ownerMemberId ?? NONE,
        initialBalanceCents: account.initialBalanceCents,
        initialBalanceDate: account.initialBalanceDate,
        color: account.color,
        includeInTotals: account.includeInTotals,
      }
    : { name: "", institution: "", type: "CHECKING", visibility: "SHARED", ownerMemberId: NONE, initialBalanceCents: 0, initialBalanceDate: today, color: ACCOUNT_COLORS[0]!, includeInTotals: true };
}

export function AccountFormDialog({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account?: AccountDTO | null }) {
  const me = useMe();
  const members = useMembers();
  const { save } = useAccountMutations();
  const today = todayISO(me.data?.household.timezone);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(account, today) });
  const { control, register, handleSubmit, reset, formState } = form;
  const e = formState.errors;
  const [type, color, visibility, initial, name] = useWatch({ control, name: ["type", "color", "visibility", "initialBalanceCents", "name"] });

  useEffect(() => {
    if (open) {
      reset(defaults(account, today));
      setServerError(null);
    }
  }, [open, account, today, reset]);

  const submit = handleSubmit((v) => {
    setServerError(null);
    save.mutate(
      {
        id: account?.id,
        input: {
          name: v.name,
          institution: v.institution.trim() || null,
          type: v.type,
          visibility: v.visibility,
          ownerMemberId: v.ownerMemberId === NONE ? null : v.ownerMemberId,
          initialBalanceCents: v.initialBalanceCents,
          initialBalanceDate: v.initialBalanceDate,
          color: v.color,
          icon: ACCOUNT_TYPE_ICON[v.type]?.name ?? "landmark",
          includeInTotals: v.includeInTotals,
        },
      },
      { onSuccess: () => onOpenChange(false), onError: (err) => setServerError(errorMessage(err)) },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{account ? "Editar conta" : "Nova conta"}</DialogTitle>
          <DialogDescription>Contas bancárias, carteiras e investimentos. O saldo é calculado a partir do saldo inicial e das movimentações.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
            <AccountIcon type={type} color={color} />
            <div className="min-w-0 text-sm">
              <p className="truncate font-medium">{name || "Nova conta"}</p>
              <p className="text-xs text-muted-foreground">{ACCOUNT_TYPE_LABELS[type]}</p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" htmlFor="acc-name" error={e.name?.message} required>
              <Input id="acc-name" placeholder="Ex.: Nubank, Carteira" {...register("name")} aria-invalid={Boolean(e.name)} autoFocus={!account} />
            </Field>
            <Field label="Instituição" htmlFor="acc-inst" error={e.institution?.message} hint="Opcional">
              <Input id="acc-inst" placeholder="Ex.: Banco do Brasil" {...register("institution")} />
            </Field>
            <Field label="Tipo" htmlFor="acc-type">
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="acc-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(ACCOUNT_TYPE_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="Titular" htmlFor="acc-owner" hint={visibility === "PRIVATE" ? "Sem titular: você será o titular" : "Opcional"}>
              <Controller
                control={control}
                name="ownerMemberId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="acc-owner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sem titular definido</SelectItem>
                      {(members.data ?? [])
                        .filter((m) => m.isActive || m.id === account?.ownerMemberId)
                        .map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.displayName}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>

          <Controller
            control={control}
            name="visibility"
            render={({ field }) => (
              <fieldset className="grid gap-2">
                <legend className="mb-1.5 text-[13px] font-medium">Visibilidade</legend>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Visibilidade">
                  {(
                    [
                      ["SHARED", Users, "Compartilhada", "Toda a família vê a conta e o saldo"],
                      ["PRIVATE", Lock, "Privada", "Só o titular (e quem tem permissão) vê"],
                    ] as const
                  ).map(([value, Icon, label, desc]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === value}
                      onClick={() => field.onChange(value)}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border p-3 text-left text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                        field.value === value ? "border-brand bg-accent/60" : "hover:bg-muted/50",
                      )}
                    >
                      <Icon className={cn("mt-0.5 size-4 shrink-0", field.value === value ? "text-brand" : "text-muted-foreground")} aria-hidden />
                      <span>
                        <span className="block font-medium">{label}</span>
                        <span className="block text-xs text-muted-foreground">{desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Saldo inicial"
              htmlFor="acc-initial"
              hint={account ? "Para corrigir o saldo de hoje, prefira “Ajustar saldo”." : initial < 0 ? "Saldo negativo (cheque especial)" : "Use a tecla − para valor negativo"}
            >
              <Controller control={control} name="initialBalanceCents" render={({ field }) => <MoneyInput id="acc-initial" allowNegative value={field.value} onChange={field.onChange} />} />
            </Field>
            <Field label="Data do saldo inicial" htmlFor="acc-initial-date" error={e.initialBalanceDate?.message} required>
              <Input id="acc-initial-date" type="date" {...register("initialBalanceDate")} />
            </Field>
          </div>

          <Field label="Cor" error={e.color?.message}>
            <Controller control={control} name="color" render={({ field }) => <ColorSwatches value={field.value} onChange={field.onChange} colors={ACCOUNT_COLORS} label="Cor da conta" />} />
          </Field>

          <label className="flex items-start justify-between gap-4 rounded-xl border p-3 text-sm">
            <span>
              <span className="block font-medium">Incluir nos totais</span>
              <span className="block text-xs text-muted-foreground">Soma no saldo disponível do dashboard e no histórico de saldo. Desative para contas que você só quer acompanhar.</span>
            </span>
            <Controller control={control} name="includeInTotals" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Incluir nos totais" />} />
          </label>

          {serverError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={save.isPending}>
              {account ? "Salvar alterações" : "Criar conta"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
