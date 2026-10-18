"use client";

import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Split, TrendingDown, TrendingUp, ArrowLeftRight } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/client/api";
import { formatDayMonthBR, todayISO } from "@/lib/dates";
import { formatBRL, formatMoney } from "@/lib/money";
import { PAYMENT_METHOD_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/shared/money-input";
import { useAccounts, useCards, useMembers } from "@/features/finance/hooks";
import { CategoryPicker } from "@/features/recurring/pickers";
import { useMe } from "@/features/me/use-me";
import type { AccountDTO, TransactionDTO } from "@/features/finance/types";
import { describeExchange, formatRate, isForeignCurrency } from "@/features/accounts/currency";

const NONE = "__none__";

const formSchema = z
  .object({
    type: z.enum(["EXPENSE", "INCOME", "TRANSFER"]),
    amountCents: z.number().int().positive("Informe um valor maior que zero"),
    description: z.string().trim().min(1, "Informe uma descrição").max(200),
    date: z.string().length(10, "Informe a data"),
    category: z.string().optional(),
    paymentMethod: z.string().optional(),
    accountId: z.string().optional(),
    destinationAccountId: z.string().optional(),
    /** Transferência entre moedas: valor creditado no destino (0 = não informado). */
    destinationAmountCents: z.number().int().min(0),
    creditCardId: z.string().optional(),
    installmentCount: z.number().int().min(1).max(72),
    payerMemberId: z.string().optional(),
    ownership: z.enum(["SHARED", "INDIVIDUAL"]),
    responsibleMemberId: z.string().optional(),
    merchantName: z.string().max(120).optional(),
    notes: z.string().max(2000).optional(),
    split: z.boolean(),
    allocations: z.record(z.string(), z.number().int().min(0)),
  })
  .superRefine((v, ctx) => {
    if (v.type === "TRANSFER") {
      if (!v.accountId || v.accountId === NONE) ctx.addIssue({ code: "custom", path: ["accountId"], message: "Escolha a conta de origem" });
      if (!v.destinationAccountId || v.destinationAccountId === NONE) ctx.addIssue({ code: "custom", path: ["destinationAccountId"], message: "Escolha a conta de destino" });
      if (v.accountId && v.accountId === v.destinationAccountId) ctx.addIssue({ code: "custom", path: ["destinationAccountId"], message: "As contas devem ser diferentes" });
    }
    if (v.type === "EXPENSE" && v.paymentMethod === "CREDIT_CARD" && (!v.creditCardId || v.creditCardId === NONE)) {
      ctx.addIssue({ code: "custom", path: ["creditCardId"], message: "Escolha o cartão" });
    }
    if (v.split) {
      const sum = Object.values(v.allocations).reduce((s, n) => s + n, 0);
      if (sum !== v.amountCents) ctx.addIssue({ code: "custom", path: ["allocations"], message: `O rateio soma ${formatBRL(sum)}; deve somar ${formatBRL(v.amountCents)}` });
    }
  });

type FormValues = z.infer<typeof formSchema>;

function toFormValues(tx: TransactionDTO | null | undefined, defaults: Partial<FormValues>): FormValues {
  if (!tx) {
    return {
      type: "EXPENSE",
      amountCents: 0,
      description: "",
      date: todayISO(),
      category: NONE,
      paymentMethod: NONE,
      accountId: NONE,
      destinationAccountId: NONE,
      destinationAmountCents: 0,
      creditCardId: NONE,
      installmentCount: 1,
      payerMemberId: NONE,
      ownership: "SHARED",
      responsibleMemberId: NONE,
      merchantName: "",
      notes: "",
      split: false,
      allocations: {},
      ...defaults,
    };
  }
  return {
    type: tx.type === "INCOME" ? "INCOME" : tx.type === "TRANSFER" ? "TRANSFER" : "EXPENSE",
    amountCents: tx.amountCents,
    description: tx.description,
    date: tx.date,
    category: tx.subcategory ? `sub:${tx.subcategory.id}` : tx.category ? `cat:${tx.category.id}` : NONE,
    paymentMethod: tx.paymentMethod ?? NONE,
    accountId: tx.account?.id ?? NONE,
    destinationAccountId: tx.destinationAccount?.id ?? NONE,
    destinationAmountCents: tx.destinationAmountCents ?? 0,
    creditCardId: tx.creditCard?.id ?? NONE,
    installmentCount: tx.installmentCount,
    payerMemberId: tx.payer?.id ?? NONE,
    ownership: tx.ownership,
    responsibleMemberId: tx.responsible?.id ?? NONE,
    merchantName: tx.merchant?.name ?? "",
    notes: tx.notes ?? "",
    split: tx.allocations.length > 1,
    allocations: Object.fromEntries(tx.allocations.map((a) => [a.memberId, a.amountCents])),
  };
}

const val = (v: string | undefined) => (v && v !== NONE ? v : null);

/** Nome da conta com a moeda quando não é real ("Wise · USD"). */
function AccountOption({ account }: { account: AccountDTO }) {
  return (
    <>
      {account.name}
      {isForeignCurrency(account.currency) && <span className="text-muted-foreground"> · {account.currency}</span>}
    </>
  );
}

export function TransactionForm({
  transaction,
  defaults,
  onSaved,
  onCancel,
}: {
  transaction?: TransactionDTO | null;
  defaults?: Partial<FormValues>;
  onSaved?: (tx: TransactionDTO) => void;
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const accounts = useAccounts();
  const cards = useCards();
  const members = useMembers();
  const editing = Boolean(transaction);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toFormValues(transaction, defaults ?? {}),
  });
  const { control, register, handleSubmit, setValue, formState } = form;
  const type = useWatch({ control, name: "type" });
  const paymentMethod = useWatch({ control, name: "paymentMethod" });
  const ownership = useWatch({ control, name: "ownership" });
  const split = useWatch({ control, name: "split" });
  const amountCents = useWatch({ control, name: "amountCents" });
  const allocations = useWatch({ control, name: "allocations" });
  const installmentCount = useWatch({ control, name: "installmentCount" });
  const accountId = useWatch({ control, name: "accountId" });
  const destinationAccountId = useWatch({ control, name: "destinationAccountId" });
  const destinationAmountCents = useWatch({ control, name: "destinationAmountCents" });

  useEffect(() => {
    if (!editing && me.data && form.getValues("payerMemberId") === NONE) setValue("payerMemberId", me.data.member.id);
  }, [me.data, editing, form, setValue]);

  const isCredit = type === "EXPENSE" && paymentMethod === "CREDIT_CARD";
  // Moeda: a da conta (cartão é em reais). Na edição, conta fora da lista (arquivada) mantém a moeda do lançamento.
  const accountById = (id: string | undefined) => (accounts.data ?? []).find((a) => a.id === id) ?? null;
  const currencyOf = (id: string | undefined, fallback: string | null): string | null => {
    if (!val(id)) return null;
    return accountById(id)?.currency ?? fallback;
  };
  const sourceAccount = accountById(accountId);
  const currency = isCredit ? "BRL" : (currencyOf(accountId, transaction && accountId === transaction.account?.id ? transaction.currency : "BRL") ?? "BRL");
  const destinationCurrency = type === "TRANSFER" ? currencyOf(destinationAccountId, "BRL") : null;
  const crossCurrency = type === "TRANSFER" && Boolean(val(accountId)) && Boolean(destinationCurrency) && destinationCurrency !== currency;
  const money = (cents: number) => formatMoney(cents, currency);
  const foreignAccount = crossCurrency ? (isForeignCurrency(currency) ? sourceAccount : accountById(destinationAccountId)) : null;
  const kind = type === "INCOME" ? "INCOME" : "EXPENSE";
  const activeMembers = (members.data ?? []).filter((m) => m.isActive);

  const mutation = useMutation({
    mutationFn: async (v: FormValues) => {
      const cat = val(v.category);
      const body: Record<string, unknown> = {
        type: v.type,
        amountCents: v.amountCents,
        description: v.description,
        date: v.date,
        categoryId: v.type === "TRANSFER" ? null : cat?.startsWith("cat:") ? cat.slice(4) : null,
        subcategoryId: v.type === "TRANSFER" ? null : cat?.startsWith("sub:") ? cat.slice(4) : null,
        merchantName: v.merchantName?.trim() || null,
        notes: v.notes?.trim() || null,
        payerMemberId: val(v.payerMemberId),
      };
      if (v.type === "TRANSFER") {
        Object.assign(body, {
          accountId: val(v.accountId),
          destinationAccountId: val(v.destinationAccountId),
          paymentMethod: val(v.paymentMethod),
          destinationAmountCents: crossCurrency ? v.destinationAmountCents : null,
        });
      } else {
        const credit = v.type === "EXPENSE" && v.paymentMethod === "CREDIT_CARD";
        Object.assign(body, {
          paymentMethod: val(v.paymentMethod),
          accountId: credit ? null : val(v.accountId),
          creditCardId: credit ? val(v.creditCardId) : null,
          installmentCount: credit ? v.installmentCount : 1,
          ownership: v.split ? "SHARED" : v.ownership,
          responsibleMemberId: !v.split && v.ownership === "INDIVIDUAL" ? val(v.responsibleMemberId) ?? val(v.payerMemberId) : null,
          allocations: v.split ? Object.entries(v.allocations).filter(([, n]) => n > 0).map(([memberId, n]) => ({ memberId, amountCents: n })) : [],
        });
      }
      if (transaction) {
        return api.patch<TransactionDTO>(`/api/v1/transactions/${transaction.id}`, { ...body, expectedVersion: transaction.version });
      }
      const res = await api.post<{ transaction: TransactionDTO }>("/api/v1/transactions", body);
      return res.transaction;
    },
    onSuccess: (tx) => {
      toast.success(editing ? "Lançamento atualizado" : "Lançamento registrado", { description: `${tx.description} · ${formatMoney(tx.amountCents, tx.currency)}` });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["cards"] });
      qc.invalidateQueries({ queryKey: ["analytics"] });
      qc.invalidateQueries({ queryKey: ["pending"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      onSaved?.(tx);
    },
    onError: (err) => {
      setServerError(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) toast.error(err.message);
    },
  });

  const allocationSum = Object.values(allocations ?? {}).reduce((s, n) => s + (n || 0), 0);
  const e = formState.errors;

  return (
    <form
      onSubmit={handleSubmit((v) => {
        setServerError(null);
        if (crossCurrency && !v.destinationAmountCents) {
          form.setError("destinationAmountCents", { message: `Informe quanto chegou em ${destinationCurrency}` });
          return;
        }
        mutation.mutate(v);
      })}
      className="grid gap-4"
      noValidate
    >
      <Controller
        control={control}
        name="type"
        render={({ field }) => (
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Tipo de lançamento">
            {(
              [
                ["EXPENSE", "Despesa", TrendingDown],
                ["INCOME", "Receita", TrendingUp],
                ["TRANSFER", "Transferência", ArrowLeftRight],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={field.value === value}
                disabled={editing && transaction?.type !== value && (transaction?.type === "TRANSFER" || value === "TRANSFER")}
                onClick={() => {
                  field.onChange(value);
                  setValue("category", NONE);
                }}
                className={cn(
                  "flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition disabled:opacity-40",
                  field.value === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        )}
      />

      <Field
        label={crossCurrency ? `Valor enviado (${currency})` : isForeignCurrency(currency) ? `Valor (${currency})` : "Valor"}
        htmlFor="amount"
        error={e.amountCents?.message}
        required
        hint={
          isForeignCurrency(currency) && type !== "TRANSFER" && sourceAccount?.fx && amountCents > 0
            ? `≈ ${formatBRL(Math.round(amountCents * sourceAccount.fx.rate))} pela PTAX de ${formatDayMonthBR(sourceAccount.fx.date)}. Nos relatórios, entra em reais pela PTAX da data.`
            : undefined
        }
      >
        <Controller
          control={control}
          name="amountCents"
          render={({ field }) => <MoneyInput id="amount" size="lg" currency={currency} value={field.value} onChange={field.onChange} autoFocus={!editing} aria-invalid={Boolean(e.amountCents)} />}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Descrição" htmlFor="description" error={e.description?.message} required>
          <Input id="description" placeholder={type === "INCOME" ? "Ex.: Salário" : "Ex.: Supermercado"} {...register("description")} aria-invalid={Boolean(e.description)} />
        </Field>
        <Field label="Data" htmlFor="date" error={e.date?.message} required>
          <Input id="date" type="date" {...register("date")} />
        </Field>
      </div>

      {type !== "TRANSFER" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Categoria" htmlFor="category">
            <Controller control={control} name="category" render={({ field }) => <CategoryPicker id="category" value={field.value ?? NONE} onChange={field.onChange} kind={kind} />} />
          </Field>
          <Field label="Estabelecimento" htmlFor="merchant" hint="Opcional">
            <Input id="merchant" placeholder="Ex.: Atacadão" {...register("merchantName")} />
          </Field>
        </div>
      )}

      {type === "TRANSFER" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="De (origem)" htmlFor="from" error={e.accountId?.message} required>
            <Controller
              control={control}
              name="accountId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="from">
                    <SelectValue placeholder="Conta de origem" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Selecione…</SelectItem>
                    {(accounts.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <AccountOption account={a} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field label="Para (destino)" htmlFor="to" error={e.destinationAccountId?.message} required>
            <Controller
              control={control}
              name="destinationAccountId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="to">
                    <SelectValue placeholder="Conta de destino" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Selecione…</SelectItem>
                    {(accounts.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <AccountOption account={a} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          {crossCurrency && destinationCurrency && (
            <Field
              label={`Valor recebido (${destinationCurrency})`}
              htmlFor="destination-amount"
              error={e.destinationAmountCents?.message}
              required
              className="sm:col-span-2"
              hint={
                <>
                  {describeExchange({ cents: amountCents, currency }, { cents: destinationAmountCents, currency: destinationCurrency }) ? (
                    <>
                      Câmbio efetivo: <strong className="font-medium text-foreground tabular">{describeExchange({ cents: amountCents, currency }, { cents: destinationAmountCents, currency: destinationCurrency })}</strong>
                    </>
                  ) : (
                    "Quanto chegou na conta de destino, já descontadas as tarifas."
                  )}
                  {foreignAccount?.fx && (
                    <span className="block">
                      Referência: PTAX de {formatDayMonthBR(foreignAccount.fx.date)}, 1 {foreignAccount.currency} = {formatRate(foreignAccount.fx.rate)}.
                    </span>
                  )}
                </>
              }
            >
              <Controller
                control={control}
                name="destinationAmountCents"
                render={({ field }) => (
                  <MoneyInput
                    id="destination-amount"
                    currency={destinationCurrency}
                    value={field.value}
                    onChange={(n) => {
                      field.onChange(n);
                      if (n) form.clearErrors("destinationAmountCents");
                    }}
                    aria-invalid={Boolean(e.destinationAmountCents)}
                  />
                )}
              />
            </Field>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Transferências entre contas próprias não contam como receita nem despesa.
            {crossCurrency && " Entre moedas diferentes, a diferença de cotação aparece como variação cambial na conta em moeda estrangeira."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={type === "INCOME" ? "Forma de recebimento" : "Forma de pagamento"} htmlFor="method">
            <Controller
              control={control}
              name="paymentMethod"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="method">
                    <SelectValue placeholder="Não informada" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Não informada</SelectItem>
                    {Object.entries(PAYMENT_METHOD_LABELS)
                      .filter(([k]) => type === "EXPENSE" || k !== "CREDIT_CARD")
                      .map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          {isCredit ? (
            <Field label="Cartão" htmlFor="card" error={e.creditCardId?.message} required>
              <Controller
                control={control}
                name="creditCardId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="card">
                      <SelectValue placeholder="Selecione o cartão" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Selecione…</SelectItem>
                      {(cards.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          ) : (
            <Field label={type === "INCOME" ? "Conta de destino" : "Conta"} htmlFor="account" hint="Define qual saldo é afetado">
              <Controller
                control={control}
                name="accountId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="account">
                      <SelectValue placeholder="Sem conta" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sem conta</SelectItem>
                      {(accounts.data ?? []).map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <AccountOption account={a} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          )}
          {isCredit && (
            <Field label="Parcelas" htmlFor="installments" hint={amountCents > 0 && installmentCount > 1 ? `${installmentCount}× de aprox. ${formatBRL(Math.floor(amountCents / installmentCount))}` : "À vista = 1"}>
              <Input id="installments" type="number" min={1} max={72} inputMode="numeric" {...register("installmentCount", { valueAsNumber: true })} />
            </Field>
          )}
        </div>
      )}

      {type !== "TRANSFER" && (
        <div className="grid gap-4 rounded-xl border bg-muted/30 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={type === "INCOME" ? "Quem recebeu" : "Quem pagou"} htmlFor="payer">
              <Controller
                control={control}
                name="payerMemberId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="payer">
                      <SelectValue placeholder="Não informado" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Não informado</SelectItem>
                      {activeMembers.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            {!split && (
              <Field label="Responsável econômico" htmlFor="ownership" hint="Quem pagou não é necessariamente o responsável">
                <Controller
                  control={control}
                  name="ownership"
                  render={({ field }) => (
                    <Select
                      value={field.value === "SHARED" ? "SHARED" : `IND:${form.getValues("responsibleMemberId")}`}
                      onValueChange={(v) => {
                        if (v === "SHARED") {
                          field.onChange("SHARED");
                          setValue("responsibleMemberId", NONE);
                        } else {
                          field.onChange("INDIVIDUAL");
                          setValue("responsibleMemberId", v.slice(4));
                        }
                      }}
                    >
                      <SelectTrigger id="ownership">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SHARED">Família (compartilhada)</SelectItem>
                        {activeMembers.map((m) => (
                          <SelectItem key={m.id} value={`IND:${m.id}`}>
                            Individual — {m.displayName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            )}
          </div>
          {type === "EXPENSE" && activeMembers.length > 1 && (
            <div className="grid gap-3">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Split className="size-4 text-muted-foreground" /> Ratear entre pessoas
                </span>
                <Controller control={control} name="split" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} />} />
              </label>
              {split && (
                <div className="grid gap-2">
                  {activeMembers.map((m) => (
                    <div key={m.id} className="flex items-center gap-3">
                      <span className="w-28 truncate text-sm">{m.displayName}</span>
                      <Controller
                        control={control}
                        name={`allocations.${m.id}` as const}
                        render={({ field }) => <MoneyInput className="flex-1" currency={currency} value={field.value ?? 0} onChange={field.onChange} />}
                      />
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-xs">
                    <span className={cn(allocationSum === amountCents ? "text-positive" : "text-muted-foreground")}>
                      Rateado: {money(allocationSum)} de {money(amountCents)}
                    </span>
                    <button
                      type="button"
                      className="font-medium text-brand hover:underline"
                      onClick={() => {
                        const n = activeMembers.length;
                        const base = Math.floor(amountCents / n);
                        activeMembers.forEach((m, i) => setValue(`allocations.${m.id}` as const, i === 0 ? amountCents - base * (n - 1) : base));
                      }}
                    >
                      Dividir igualmente
                    </button>
                  </div>
                  {e.allocations && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      O rateio soma {money(allocationSum)}; deve somar {money(amountCents)}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Field label="Observações" htmlFor="notes" hint="Opcional">
        <Textarea id="notes" rows={2} {...register("notes")} />
      </Field>

      {serverError && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {serverError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
        )}
        <Button type="submit" variant="brand" loading={mutation.isPending}>
          {editing ? "Salvar alterações" : "Registrar lançamento"}
        </Button>
      </div>
    </form>
  );
}
