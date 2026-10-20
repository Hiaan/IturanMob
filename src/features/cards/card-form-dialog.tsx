"use client";

import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { BellRing, CalendarDays, Lock, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { addDays, daysInMonth, formatDateBR, makeISO, todayISO } from "@/lib/dates";
import { useMe } from "@/features/me/use-me";
import { purchaseReferenceMonth } from "@/features/transactions/installments";
import { useAccounts, useMembers } from "@/features/finance/hooks";
import type { CardDTO } from "@/features/finance/types";
import { ColorSwatches } from "@/features/accounts/account-icon";
import { CreditCardVisual } from "./credit-card-visual";
import { CARD_BRANDS } from "./types";
import { useCardMutations } from "./use-card-mutations";

const NONE = "__none__";
/** Antecedência padrão do lembrete da fatura (igual à do servidor). */
const DEFAULT_REMINDER_DAYS = 3;
const CARD_COLORS = ["#1e3a5f", "#0b2545", "#7c3aed", "#820ad1", "#ec7000", "#cc092f", "#0f766e", "#059669", "#2563eb", "#111827", "#475569", "#b45309"];

const day = z.number({ error: "Informe o dia" }).int("Dia inválido").min(1, "Entre 1 e 31").max(31, "Entre 1 e 31");
const schema = z.object({
  name: z.string().trim().min(1, "Informe o nome do cartão").max(60),
  issuer: z.string().trim().max(60),
  brand: z.string(),
  last4: z.string().trim().regex(/^(\d{4})?$/, "Informe apenas os 4 últimos dígitos"),
  holderMemberId: z.string(),
  visibility: z.enum(["SHARED", "PRIVATE"]),
  limitCents: z.number().int().min(0),
  closingDay: day,
  dueDay: day,
  dueReminderDays: z.number({ error: "Informe os dias" }).int("Use um número inteiro").min(0, "Entre 0 e 15").max(15, "Entre 0 e 15"),
  paymentAccountId: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida"),
});
type Values = z.infer<typeof schema>;

function defaults(card?: CardDTO | null): Values {
  return card
    ? {
        name: card.name,
        issuer: card.issuer ?? "",
        brand: card.brand ?? NONE,
        last4: card.last4 ?? "",
        holderMemberId: card.holderMemberId ?? NONE,
        visibility: card.visibility as Values["visibility"],
        limitCents: card.limitCents,
        closingDay: card.closingDay,
        dueDay: card.dueDay,
        dueReminderDays: card.dueReminderDays ?? DEFAULT_REMINDER_DAYS,
        paymentAccountId: card.paymentAccountId ?? NONE,
        color: card.color,
      }
    : { name: "", issuer: "", brand: NONE, last4: "", holderMemberId: NONE, visibility: "SHARED", limitCents: 0, closingDay: 1, dueDay: 10, dueReminderDays: DEFAULT_REMINDER_DAYS, paymentAccountId: NONE, color: CARD_COLORS[0]! };
}

/** Exemplo concreto da regra de fechamento no mês atual: compra na véspera e no dia do fechamento. */
function billingExample(today: string, closingDay: number, dueDay: number) {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const onClosing = makeISO(y, m, Math.min(closingDay, daysInMonth(y, m)));
  const dueOf = (purchase: string) => {
    const [ry, rm] = purchaseReferenceMonth(purchase, { closingDay, dueDay }).split("-").map(Number) as [number, number];
    return makeISO(ry, rm, Math.min(dueDay, daysInMonth(ry, rm)));
  };
  const before = addDays(onClosing, -1);
  return { before: { purchase: before, due: dueOf(before) }, on: { purchase: onClosing, due: dueOf(onClosing) } };
}

export function CardFormDialog({ open, onOpenChange, card }: { open: boolean; onOpenChange: (o: boolean) => void; card?: CardDTO | null }) {
  const members = useMembers();
  const accounts = useAccounts();
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const { save } = useCardMutations();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(card) });
  const { control, register, handleSubmit, reset, formState } = form;
  const e = formState.errors;
  const w = useWatch({ control });

  useEffect(() => {
    if (open) {
      reset(defaults(card));
      setServerError(null);
    }
  }, [open, card, reset]);

  const closing = Number(w.closingDay) || 0;
  const due = Number(w.dueDay) || 0;
  const daysChanged = card && (closing !== card.closingDay || due !== card.dueDay);
  const example = closing >= 1 && closing <= 31 && due >= 1 && due <= 31 ? billingExample(today, closing, due) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{card ? "Editar cartão" : "Novo cartão de crédito"}</DialogTitle>
          <DialogDescription>As compras no cartão viram parcelas nas faturas; o saldo da conta só muda quando a fatura é paga.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={handleSubmit((v) => {
            setServerError(null);
            save.mutate(
              {
                id: card?.id,
                input: {
                  name: v.name,
                  issuer: v.issuer.trim() || null,
                  brand: v.brand === NONE ? null : v.brand,
                  last4: v.last4.trim() || null,
                  holderMemberId: v.holderMemberId === NONE ? null : v.holderMemberId,
                  visibility: v.visibility,
                  limitCents: v.limitCents,
                  closingDay: v.closingDay,
                  dueDay: v.dueDay,
                  dueReminderDays: v.dueReminderDays,
                  paymentAccountId: v.paymentAccountId === NONE ? null : v.paymentAccountId,
                  color: v.color,
                },
              },
              { onSuccess: () => onOpenChange(false), onError: (err) => setServerError(errorMessage(err)) },
            );
          })}
        >
          <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
            <div className="grid gap-4">
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <Field label="Nome" htmlFor="card-name" error={e.name?.message} required>
                  <Input id="card-name" placeholder="Ex.: Nubank Roxinho" {...register("name")} aria-invalid={Boolean(e.name)} autoFocus={!card} />
                </Field>
                <Field label="Emissor" htmlFor="card-issuer" hint="Banco ou instituição">
                  <Input id="card-issuer" placeholder="Ex.: Nubank" {...register("issuer")} />
                </Field>
                <Field label="Bandeira" htmlFor="card-brand">
                  <Controller
                    control={control}
                    name="brand"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="card-brand">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Não informada</SelectItem>
                          {CARD_BRANDS.map((b) => (
                            <SelectItem key={b} value={b}>
                              {b}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
                <Field label="4 últimos dígitos" htmlFor="card-last4" error={e.last4?.message} hint="Opcional — nunca informe o número completo">
                  <Input id="card-last4" inputMode="numeric" maxLength={4} placeholder="1234" autoComplete="off" {...register("last4")} aria-invalid={Boolean(e.last4)} />
                </Field>
              </div>
            </div>
            <div className="hidden sm:block">
              <CreditCardVisual
                name={w.name || "Novo cartão"}
                issuer={w.issuer || null}
                brand={w.brand && w.brand !== NONE ? w.brand : null}
                last4={/^\d{4}$/.test(w.last4 ?? "") ? w.last4! : null}
                holderName={members.data?.find((m) => m.id === w.holderMemberId)?.displayName ?? null}
                color={w.color ?? CARD_COLORS[0]!}
                privateCard={w.visibility === "PRIVATE"}
                className="p-4 [&_p.text-lg]:text-base"
              />
            </div>
          </div>

          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Titular" htmlFor="card-holder" hint={w.visibility === "PRIVATE" ? "Sem titular: você será o titular" : undefined}>
              <Controller
                control={control}
                name="holderMemberId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="card-holder">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sem titular definido</SelectItem>
                      {(members.data ?? [])
                        .filter((m) => m.isActive || m.id === card?.holderMemberId)
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
            <Field label="Limite total" htmlFor="card-limit" hint="R$ 0,00 = não informado">
              <Controller control={control} name="limitCents" render={({ field }) => <MoneyInput id="card-limit" value={field.value} onChange={field.onChange} />} />
            </Field>
          </div>

          <Controller
            control={control}
            name="visibility"
            render={({ field }) => (
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Visibilidade">
                {(
                  [
                    ["SHARED", Users, "Compartilhado", "Toda a família vê as faturas"],
                    ["PRIVATE", Lock, "Privado", "Só o titular (e quem tem permissão) vê"],
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
            )}
          />

          <div className="grid gap-4 rounded-xl border bg-muted/30 p-4">
            <div className="grid items-start grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Dia de fechamento" htmlFor="card-closing" error={e.closingDay?.message} required>
                <Input id="card-closing" type="number" min={1} max={31} inputMode="numeric" {...register("closingDay", { valueAsNumber: true })} aria-invalid={Boolean(e.closingDay)} />
              </Field>
              <Field label="Dia de vencimento" htmlFor="card-due" error={e.dueDay?.message} required>
                <Input id="card-due" type="number" min={1} max={31} inputMode="numeric" {...register("dueDay", { valueAsNumber: true })} aria-invalid={Boolean(e.dueDay)} />
              </Field>
              <Field label="Conta de pagamento" htmlFor="card-account" className="col-span-2 sm:col-span-1" hint="Sugerida ao pagar a fatura">
                <Controller
                  control={control}
                  name="paymentAccountId"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="card-account">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Nenhuma</SelectItem>
                        {/* A fatura é paga em reais: contas em moeda estrangeira ficam de fora. */}
                        {(accounts.data ?? []).filter((a) => (a.currency ?? "BRL") === "BRL" || a.id === field.value).map((a) => (
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
            <p className="flex gap-2 text-xs text-muted-foreground">
              <CalendarDays className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
              <span>
                Compras feitas <strong className="font-medium text-foreground">a partir do dia de fechamento</strong> entram na fatura seguinte.
                {example && (
                  <>
                    {" "}
                    Ex.: compra em {formatDateBR(example.before.purchase)} → fatura que vence em {formatDateBR(example.before.due)}; compra em {formatDateBR(example.on.purchase)} → vence em{" "}
                    {formatDateBR(example.on.due)}.
                  </>
                )}
              </span>
            </p>
            {daysChanged && <p className="text-xs font-medium text-warning">Alterar os dias de fechamento/vencimento recalcula as faturas existentes deste cartão.</p>}
            <Field htmlFor="card-reminder" error={e.dueReminderDays?.message} hint="0 = só no dia do vencimento">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <BellRing className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <label htmlFor="card-reminder">Lembrar da fatura</label>
                <Input
                  id="card-reminder"
                  type="number"
                  min={0}
                  max={15}
                  inputMode="numeric"
                  className="h-9 w-20"
                  {...register("dueReminderDays", { valueAsNumber: true })}
                  aria-invalid={Boolean(e.dueReminderDays)}
                  aria-describedby="card-reminder-suffix"
                />
                <span id="card-reminder-suffix">dias antes do vencimento</span>
              </span>
            </Field>
          </div>

          <Field label="Cor" error={e.color?.message}>
            <Controller control={control} name="color" render={({ field }) => <ColorSwatches value={field.value} onChange={field.onChange} colors={CARD_COLORS} label="Cor do cartão" />} />
          </Field>

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
              {card ? "Salvar alterações" : "Cadastrar cartão"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
