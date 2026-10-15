"use client";

import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/shared/money-input";
import { addDays, todayISO } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";
import { AccountSelect, CardSelect, CategoryPicker, NONE, PayWithToggle, categoryValue, parseCategoryValue } from "@/features/recurring/pickers";
import type { BillDTO } from "./types";
import { useBillMutations } from "./use-bills";

const schema = z
  .object({
    type: z.enum(["EXPENSE", "INCOME"]),
    description: z.string().trim().min(1, "Informe uma descrição").max(200),
    amountCents: z.number().int().positive("Informe um valor maior que zero"),
    isEstimate: z.boolean(),
    dueDate: z.string().length(10, "Informe o vencimento"),
    category: z.string(),
    payWith: z.enum(["account", "card"]),
    accountId: z.string(),
    creditCardId: z.string(),
    notes: z.string().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "EXPENSE" && v.payWith === "card" && v.creditCardId === NONE) ctx.addIssue({ code: "custom", path: ["creditCardId"], message: "Escolha o cartão" });
  });
type Values = z.infer<typeof schema>;

function defaults(bill: BillDTO | null | undefined, today: string): Values {
  return {
    type: bill?.type ?? "EXPENSE",
    description: bill?.description ?? "",
    amountCents: bill?.amountCents ?? 0,
    isEstimate: bill?.isEstimate ?? false,
    dueDate: bill?.dueDate ?? addDays(today, 7),
    category: categoryValue(bill?.category?.id),
    payWith: bill?.creditCard ? "card" : "account",
    accountId: bill?.account?.id ?? NONE,
    creditCardId: bill?.creditCard?.id ?? NONE,
    notes: bill?.notes ?? "",
  };
}

/** Conta avulsa (despesa ou receita prevista) — criação e edição. */
export function BillFormDialog({ open, onOpenChange, bill }: { open: boolean; onOpenChange: (open: boolean) => void; bill?: BillDTO | null }) {
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const { create, update } = useBillMutations();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(bill, today) });
  const { control, register, handleSubmit, reset, setValue, formState } = form;
  const type = useWatch({ control, name: "type" });
  const payWith = useWatch({ control, name: "payWith" });
  const e = formState.errors;

  useEffect(() => {
    if (open) reset(defaults(bill, today));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill?.id]);

  const submit = (v: Values) => {
    const card = v.type === "EXPENSE" && v.payWith === "card";
    const body = {
      type: v.type,
      description: v.description.trim(),
      amountCents: v.amountCents,
      isEstimate: v.isEstimate,
      dueDate: v.dueDate,
      categoryId: parseCategoryValue(v.category).categoryId,
      accountId: card || v.accountId === NONE ? null : v.accountId,
      creditCardId: card && v.creditCardId !== NONE ? v.creditCardId : null,
      notes: v.notes?.trim() || null,
    };
    const done = { onSuccess: () => onOpenChange(false) };
    if (bill) update.mutate({ id: bill.id, ...body }, done);
    else create.mutate(body, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{bill ? "Editar conta" : "Nova conta"}</DialogTitle>
          <DialogDescription>
            {bill?.recurring ? "A alteração vale somente para esta ocorrência. Para mudar as próximas, edite a recorrência." : "Conta avulsa a pagar ou receita prevista. Para contas que se repetem, use Recorrências."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={handleSubmit(submit)}>
          {!bill && (
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Tipo">
                  {(
                    [
                      ["EXPENSE", "Conta a pagar", TrendingDown],
                      ["INCOME", "Receita prevista", TrendingUp],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === value}
                      onClick={() => {
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
          )}
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Descrição" htmlFor="bill-description" error={e.description?.message} required>
              <Input id="bill-description" placeholder={type === "INCOME" ? "Ex.: Reembolso" : "Ex.: IPTU"} {...register("description")} aria-invalid={Boolean(e.description)} />
            </Field>
            <Field label="Vencimento" htmlFor="bill-due" error={e.dueDate?.message} required>
              <Input id="bill-due" type="date" {...register("dueDate")} />
            </Field>
          </div>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Valor" htmlFor="bill-amount" error={e.amountCents?.message} required>
              <Controller control={control} name="amountCents" render={({ field }) => <MoneyInput id="bill-amount" value={field.value} onChange={field.onChange} aria-invalid={Boolean(e.amountCents)} />} />
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm sm:mt-[22px]">
              <span>
                Valor estimado
                <span className="block text-xs text-muted-foreground">Ex.: energia, água</span>
              </span>
              <Controller control={control} name="isEstimate" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Valor estimado" />} />
            </label>
          </div>
          <Field label="Categoria" htmlFor="bill-category">
            <Controller control={control} name="category" render={({ field }) => <CategoryPicker id="bill-category" value={field.value} onChange={field.onChange} kind={type} withSubcategories={false} />} />
          </Field>
          {type === "EXPENSE" && (
            <Controller control={control} name="payWith" render={({ field }) => <PayWithToggle value={field.value} onChange={field.onChange} />} />
          )}
          {type === "EXPENSE" && payWith === "card" ? (
            <Field label="Cartão" htmlFor="bill-card" error={e.creditCardId?.message} required>
              <Controller control={control} name="creditCardId" render={({ field }) => <CardSelect id="bill-card" value={field.value} onChange={field.onChange} />} />
            </Field>
          ) : (
            <Field label={type === "INCOME" ? "Conta que recebe" : "Conta de pagamento"} htmlFor="bill-account" hint="Opcional — sugerida ao registrar o pagamento">
              <Controller control={control} name="accountId" render={({ field }) => <AccountSelect id="bill-account" value={field.value} onChange={field.onChange} noneLabel="Definir ao pagar" />} />
            </Field>
          )}
          <Field label="Observações" htmlFor="bill-notes">
            <Textarea id="bill-notes" rows={2} placeholder="Opcional" {...register("notes")} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={create.isPending || update.isPending}>
              {bill ? "Salvar alterações" : "Cadastrar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
