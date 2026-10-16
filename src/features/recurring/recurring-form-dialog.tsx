"use client";

import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Briefcase, TrendingDown, TrendingUp, User } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { todayISO } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS, RECURRENCE_FREQUENCY_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";
import { AccountSelect, CardSelect, CategoryPicker, NONE, PayWithToggle, categoryValue, parseCategoryValue } from "./pickers";
import { FREQUENCIES, type Frequency, type RecurringDTO } from "./types";
import { useRecurringMutations } from "./use-recurring";

const MONTH_BASED: Frequency[] = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY", "CUSTOM_MONTHS"];
const ACCOUNT_METHODS = ["AUTO_DEBIT", "PIX", "BANK_SLIP", "DEBIT_CARD", "BANK_TRANSFER", "CASH", "OTHER"] as const;

const schema = z
  .object({
    type: z.enum(["EXPENSE", "INCOME"]),
    description: z.string().trim().min(1, "Informe uma descrição").max(200),
    amountCents: z.number().int().positive("Informe um valor maior que zero"),
    isVariableAmount: z.boolean(),
    category: z.string(),
    merchantName: z.string().max(120).optional(),
    payWith: z.enum(["account", "card"]),
    accountId: z.string(),
    creditCardId: z.string(),
    paymentMethod: z.string(),
    frequency: z.enum(FREQUENCIES),
    interval: z.number({ error: "Informe o intervalo" }).int().min(1, "Mínimo 1").max(366),
    dayOfMonth: z.number({ error: "Informe o dia" }).int().min(1, "Entre 1 e 31").max(31, "Entre 1 e 31"),
    startDate: z.string().length(10, "Informe a data de início"),
    endDate: z.string().optional(),
    autoPost: z.boolean(),
    reminderDaysBefore: z.number({ error: "Informe os dias" }).int().min(0, "Entre 0 e 30").max(30, "Entre 0 e 30"),
    /** Natureza dos lançamentos gerados: Pessoal ou Empresa (só muda relatórios). */
    scope: z.enum(["PERSONAL", "BUSINESS"]),
  })
  .superRefine((v, ctx) => {
    const card = v.type === "EXPENSE" && v.payWith === "card";
    if (card && v.creditCardId === NONE) ctx.addIssue({ code: "custom", path: ["creditCardId"], message: "Escolha o cartão" });
    if (v.autoPost && !card && v.accountId === NONE) ctx.addIssue({ code: "custom", path: ["accountId"], message: "Para lançar automaticamente, escolha a conta" });
    if (v.endDate && v.endDate < v.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "A data final deve ser igual ou posterior ao início" });
  });
type Values = z.infer<typeof schema>;

function defaults(rec: RecurringDTO | null | undefined, today: string): Values {
  return {
    type: rec?.type ?? "EXPENSE",
    description: rec?.description ?? "",
    amountCents: rec?.amountCents ?? 0,
    isVariableAmount: rec?.isVariableAmount ?? false,
    category: categoryValue(rec?.category?.id, rec?.subcategory?.id),
    merchantName: rec?.merchant?.name ?? "",
    payWith: rec?.creditCard ? "card" : "account",
    accountId: rec?.account?.id ?? NONE,
    creditCardId: rec?.creditCard?.id ?? NONE,
    paymentMethod: rec?.paymentMethod && rec.paymentMethod !== "CREDIT_CARD" ? rec.paymentMethod : NONE,
    frequency: rec?.frequency ?? "MONTHLY",
    interval: rec?.interval ?? 1,
    dayOfMonth: rec?.dayOfMonth ?? Number((rec?.startDate ?? today).slice(8, 10)),
    startDate: rec?.startDate ?? today,
    endDate: rec?.endDate ?? "",
    autoPost: rec?.autoPost ?? false,
    reminderDaysBefore: rec?.reminderDaysBefore ?? 3,
    scope: rec?.scope ?? "PERSONAL",
  };
}

/** Criação e edição de recorrência (despesa ou receita, valor fixo ou estimado). */
export function RecurringFormDialog({ open, onOpenChange, recurring }: { open: boolean; onOpenChange: (open: boolean) => void; recurring?: RecurringDTO | null }) {
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const { create, update } = useRecurringMutations();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(recurring, today) });
  const { control, register, handleSubmit, reset, setValue, formState } = form;
  const type = useWatch({ control, name: "type" });
  const payWith = useWatch({ control, name: "payWith" });
  const frequency = useWatch({ control, name: "frequency" });
  const autoPost = useWatch({ control, name: "autoPost" });
  const e = formState.errors;
  const monthBased = MONTH_BASED.includes(frequency);
  const custom = frequency === "CUSTOM_DAYS" || frequency === "CUSTOM_MONTHS";

  useEffect(() => {
    if (open) reset(defaults(recurring, today));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recurring?.id]);

  const submit = (v: Values) => {
    const card = v.type === "EXPENSE" && v.payWith === "card";
    const { categoryId, subcategoryId } = parseCategoryValue(v.category);
    const body = {
      type: v.type,
      description: v.description.trim(),
      amountCents: v.amountCents,
      isVariableAmount: v.isVariableAmount,
      categoryId,
      subcategoryId,
      merchantName: v.merchantName?.trim() || null,
      paymentMethod: card ? "CREDIT_CARD" : v.paymentMethod === NONE ? null : v.paymentMethod,
      accountId: card || v.accountId === NONE ? null : v.accountId,
      creditCardId: card ? v.creditCardId : null,
      frequency: v.frequency,
      interval: custom ? v.interval : 1,
      dayOfMonth: monthBased ? v.dayOfMonth : null,
      startDate: v.startDate,
      endDate: v.endDate || null,
      autoPost: v.autoPost,
      reminderDaysBefore: v.reminderDaysBefore,
      scope: v.scope,
    };
    const done = { onSuccess: () => onOpenChange(false) };
    if (recurring) update.mutate({ id: recurring.id, ...body }, done);
    else create.mutate(body, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{recurring ? "Editar recorrência" : "Nova recorrência"}</DialogTitle>
          <DialogDescription>
            {recurring
              ? "As mudanças valem para as próximas ocorrências previstas. Ocorrências já pagas não são alteradas."
              : "Contas e receitas que se repetem geram ocorrências previstas em Contas a pagar para os próximos 60 dias."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={handleSubmit(submit)}>
          <Controller
            control={control}
            name="type"
            render={({ field }) => (
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Tipo">
                {(
                  [
                    ["EXPENSE", "Despesa", TrendingDown],
                    ["INCOME", "Receita", TrendingUp],
                  ] as const
                ).map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={field.value === value}
                    onClick={() => {
                      if (field.value === value) return;
                      field.onChange(value);
                      setValue("category", NONE);
                      if (value === "INCOME") setValue("payWith", "account");
                    }}
                    className={cn(
                      "flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition",
                      field.value === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden /> {label}
                  </button>
                ))}
              </div>
            )}
          />

          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Descrição" htmlFor="rec-description" error={e.description?.message} required>
              <Input id="rec-description" placeholder={type === "INCOME" ? "Ex.: Salário" : "Ex.: Internet"} {...register("description")} aria-invalid={Boolean(e.description)} />
            </Field>
            <Field label="Estabelecimento" htmlFor="rec-merchant" hint="Opcional — ajuda a reconhecer o pagamento no WhatsApp">
              <Input id="rec-merchant" placeholder="Ex.: Vivo" {...register("merchantName")} />
            </Field>
          </div>

          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label={autoPost ? "Valor" : "Valor previsto"} htmlFor="rec-amount" error={e.amountCents?.message} required>
              <Controller control={control} name="amountCents" render={({ field }) => <MoneyInput id="rec-amount" value={field.value} onChange={field.onChange} aria-invalid={Boolean(e.amountCents)} />} />
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm sm:mt-[22px]">
              <span>
                Valor variável
                <span className="block text-xs text-muted-foreground">O valor informado é uma estimativa</span>
              </span>
              <Controller control={control} name="isVariableAmount" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Valor variável" />} />
            </label>
          </div>

          <Field label="Categoria" htmlFor="rec-category">
            <Controller control={control} name="category" render={({ field }) => <CategoryPicker id="rec-category" value={field.value} onChange={field.onChange} kind={type} />} />
          </Field>

          {type === "EXPENSE" && <Controller control={control} name="payWith" render={({ field }) => <PayWithToggle value={field.value} onChange={field.onChange} />} />}
          {type === "EXPENSE" && payWith === "card" ? (
            <Field label="Cartão" htmlFor="rec-card" error={e.creditCardId?.message} required>
              <Controller control={control} name="creditCardId" render={({ field }) => <CardSelect id="rec-card" value={field.value} onChange={field.onChange} />} />
            </Field>
          ) : (
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label={type === "INCOME" ? "Conta que recebe" : "Conta"} htmlFor="rec-account" error={e.accountId?.message}>
                <Controller control={control} name="accountId" render={({ field }) => <AccountSelect id="rec-account" value={field.value} onChange={field.onChange} noneLabel="Definir no pagamento" />} />
              </Field>
              <Field label="Forma" htmlFor="rec-method">
                <Controller
                  control={control}
                  name="paymentMethod"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="rec-method">
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

          <div className="grid gap-1.5">
            <p id="rec-nature-label" className="text-[13px] font-medium">
              Natureza
            </p>
            <Controller
              control={control}
              name="scope"
              render={({ field }) => (
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1 sm:max-w-sm" role="radiogroup" aria-labelledby="rec-nature-label">
                  {(
                    [
                      ["PERSONAL", "Pessoal", User],
                      ["BUSINESS", "Empresa", Briefcase],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === value}
                      onClick={() => field.onChange(value)}
                      className={cn(
                        "flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                        field.value === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className={cn("size-4", field.value === value && value === "BUSINESS" && "text-series-7")} aria-hidden /> {label}
                    </button>
                  ))}
                </div>
              )}
            />
            <p className="text-xs text-muted-foreground">Os lançamentos gerados herdam a natureza (ex.: salário da equipe ou ferramenta da agência = Empresa). Só muda os relatórios: saldo e contas a pagar não mudam.</p>
          </div>

          <fieldset className="grid gap-4 rounded-xl border bg-muted/30 p-4">
            <legend className="px-1 text-[13px] font-medium">Repetição</legend>
            <div className="grid items-start gap-4 sm:grid-cols-3">
              <Field label="Frequência" htmlFor="rec-frequency">
                <Controller
                  control={control}
                  name="frequency"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={(v) => field.onChange(v as Frequency)}>
                      <SelectTrigger id="rec-frequency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FREQUENCIES.map((f) => (
                          <SelectItem key={f} value={f}>
                            {RECURRENCE_FREQUENCY_LABELS[f]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              {custom && (
                <Field label={frequency === "CUSTOM_DAYS" ? "A cada (dias)" : "A cada (meses)"} htmlFor="rec-interval" error={e.interval?.message}>
                  <Input id="rec-interval" type="number" inputMode="numeric" min={1} max={366} {...register("interval", { valueAsNumber: true })} />
                </Field>
              )}
              {monthBased && (
                <Field label="Dia do vencimento" htmlFor="rec-day" error={e.dayOfMonth?.message} hint="Ajustado ao último dia em meses mais curtos">
                  <Input id="rec-day" type="number" inputMode="numeric" min={1} max={31} {...register("dayOfMonth", { valueAsNumber: true })} />
                </Field>
              )}
            </div>
            <div className="grid items-start gap-4 sm:grid-cols-3">
              <Field label="Início" htmlFor="rec-start" error={e.startDate?.message} required>
                <Input id="rec-start" type="date" {...register("startDate")} />
              </Field>
              <Field label="Fim" htmlFor="rec-end" error={e.endDate?.message} hint="Opcional">
                <Input id="rec-end" type="date" {...register("endDate")} />
              </Field>
              <Field label="Lembrete (dias antes)" htmlFor="rec-reminder" error={e.reminderDaysBefore?.message}>
                <Input id="rec-reminder" type="number" inputMode="numeric" min={0} max={30} {...register("reminderDaysBefore", { valueAsNumber: true })} />
              </Field>
            </div>
          </fieldset>

          <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-3 text-sm">
            <span>
              Lançar automaticamente no vencimento
              <span className="block text-xs text-muted-foreground">
                Para débito automático ou assinatura no cartão. {type === "EXPENSE" ? "Valores variáveis entram como “aguardando confirmação”." : ""}
              </span>
            </span>
            <Controller control={control} name="autoPost" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Lançar automaticamente" />} />
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={create.isPending || update.isPending}>
              {recurring ? "Salvar alterações" : "Criar recorrência"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
