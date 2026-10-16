"use client";

import { useEffect, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Info, Lock, TrendingUp, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { isISODate, todayISO } from "@/lib/dates";
import { ACCOUNT_TYPE_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useMembers } from "@/features/finance/hooks";
import { useMe } from "@/features/me/use-me";
import type { AccountDTO } from "@/features/finance/types";
import { ACCOUNT_COLORS, ACCOUNT_TYPE_ICON, AccountIcon, ColorSwatches } from "./account-icon";
import { useAccountMutations, type AccountInput } from "./use-account-mutations";
import { CURRENCY_OPTIONS, isForeignCurrency, type CurrencyCode } from "./currency";
import { YIELD_INDEXES, YIELD_RATE_UNIT, bpsToPercentText, isPercentOfIndex, percentTextToBps, supportsYield, type YieldIndex } from "./yield";

const NONE = "__none__";

const schema = z
  .object({
    name: z.string().trim().min(1, "Informe o nome da conta").max(60, "Use no máximo 60 caracteres"),
    institution: z.string().trim().max(60, "Use no máximo 60 caracteres"),
    type: z.enum(["CHECKING", "SAVINGS", "WALLET", "INVESTMENT", "DIGITAL", "OTHER"]),
    visibility: z.enum(["SHARED", "PRIVATE"]),
    ownerMemberId: z.string(),
    initialBalanceCents: z.number().int(),
    initialBalanceDate: z.string().length(10, "Informe a data do saldo inicial"),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida"),
    includeInTotals: z.boolean(),
    currency: z.enum(["BRL", "USD", "EUR", "GBP"]),
    yieldEnabled: z.boolean(),
    yieldIndex: z.enum(["CDI", "SELIC", "IPCA", "PREFIXED"]),
    yieldRate: z.string(),
    yieldStartDate: z.string(),
  })
  .superRefine((v, ctx) => {
    if (!v.yieldEnabled || !supportsYield(v.type) || v.currency !== "BRL") return;
    const bps = percentTextToBps(v.yieldRate);
    if (!v.yieldRate.trim()) ctx.addIssue({ code: "custom", path: ["yieldRate"], message: isPercentOfIndex(v.yieldIndex) ? "Informe o percentual (ex.: 100)" : "Informe a taxa ao ano" });
    else if (bps === null) ctx.addIssue({ code: "custom", path: ["yieldRate"], message: "Use um número com até 2 casas decimais (ex.: 101,5)" });
    else if (bps < 1 || bps > 100_000) ctx.addIssue({ code: "custom", path: ["yieldRate"], message: "Informe uma taxa entre 0,01 e 1.000" });
    if (!isISODate(v.yieldStartDate)) ctx.addIssue({ code: "custom", path: ["yieldStartDate"], message: "Informe a data de início do rendimento" });
  });
type Values = z.infer<typeof schema>;

/** Taxa padrão ao trocar de indexador: volta à da conta se for do mesmo tipo; senão 100% (CDI/Selic) ou vazio. */
function rateFor(index: YieldIndex, account: AccountDTO | null | undefined): string {
  if (account?.yieldIndex && isPercentOfIndex(account.yieldIndex) === isPercentOfIndex(index)) return bpsToPercentText(account.yieldRateBps);
  return isPercentOfIndex(index) ? "100" : "";
}

function defaults(account: AccountDTO | null | undefined, today: string, enableYield = false): Values {
  const yieldIndex: YieldIndex = account?.yieldIndex ?? "CDI";
  const yieldValues = {
    yieldEnabled: Boolean(account?.yieldIndex) || enableYield,
    yieldIndex,
    yieldRate: rateFor(yieldIndex, account),
    yieldStartDate: account?.yieldStartDate ?? account?.initialBalanceDate ?? today,
  };
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
        currency: (account.currency ?? "BRL") as CurrencyCode,
        ...yieldValues,
      }
    : { name: "", institution: "", type: "CHECKING", visibility: "SHARED", ownerMemberId: NONE, initialBalanceCents: 0, initialBalanceDate: today, color: ACCOUNT_COLORS[0]!, includeInTotals: true, currency: "BRL", ...yieldValues };
}

const YIELD_FIELDS = ["yieldIndex", "yieldRateBps", "yieldStartDate"] as const;
/** Só vão no PATCH quando mudam: rendimento (reapura os meses) e moeda (travada depois dos lançamentos). */
const SEND_IF_CHANGED = [...YIELD_FIELDS, "currency"] as const;

/**
 * Corpo do PATCH na edição. Os campos básicos vão sempre (a rota ainda aplica os padrões do schema
 * aos campos ausentes); os do rendimento e a moeda só quando mudam.
 * `null` quando nada mudou.
 */
function editPayload(account: AccountDTO, next: AccountInput): Partial<AccountInput> | null {
  const before: AccountInput = {
    name: account.name,
    institution: account.institution,
    type: account.type,
    visibility: account.visibility as AccountInput["visibility"],
    ownerMemberId: account.ownerMemberId,
    initialBalanceCents: account.initialBalanceCents,
    initialBalanceDate: account.initialBalanceDate,
    color: account.color,
    icon: account.icon,
    includeInTotals: account.includeInTotals,
    currency: account.currency ?? "BRL",
    yieldIndex: account.yieldIndex,
    yieldRateBps: account.yieldRateBps,
    yieldStartDate: account.yieldStartDate,
  };
  const changed = (Object.keys(next) as Array<keyof AccountInput>).filter((k) => next[k] !== before[k]);
  if (!changed.length) return null;
  const out: Partial<AccountInput> = { ...next };
  for (const k of SEND_IF_CHANGED) if (!changed.includes(k)) delete out[k];
  // Desligar basta enviar o indexador nulo: taxa e início são limpos pelo servidor.
  if (next.yieldIndex === null && changed.includes("yieldIndex")) {
    delete out.yieldRateBps;
    delete out.yieldStartDate;
  }
  return out;
}

export function AccountFormDialog({
  open,
  onOpenChange,
  account,
  focusYield = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account?: AccountDTO | null;
  /** Abre já com o rendimento automático ligado e o foco na taxa (atalho do detalhe da conta). */
  focusYield?: boolean;
}) {
  const me = useMe();
  const members = useMembers();
  const { save } = useAccountMutations();
  const today = todayISO(me.data?.household.timezone);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(account, today, focusYield) });
  const { control, register, handleSubmit, reset, setValue, formState } = form;
  const e = formState.errors;
  const [type, color, visibility, initial, name, initialDate, yieldEnabled, yieldIndex, currency] = useWatch({
    control,
    name: ["type", "color", "visibility", "initialBalanceCents", "name", "initialBalanceDate", "yieldEnabled", "yieldIndex", "currency"],
  });
  const yieldSectionRef = useRef<HTMLElement | null>(null);
  const yieldRateRef = useRef<HTMLInputElement | null>(null);
  // Início do rendimento acompanha a data do saldo inicial até a pessoa escolher outra.
  const startTouched = useRef(false);
  const foreign = isForeignCurrency(currency);
  const yieldEligible = supportsYield(type) && !foreign;
  // A moeda não muda depois que a conta tem lançamentos (o servidor recusa).
  const currencyLocked = Boolean(account && account.transactionsCount > 0);
  const unit = YIELD_RATE_UNIT[yieldIndex];

  useEffect(() => {
    if (!open) return;
    reset(defaults(account, today, focusYield));
    setServerError(null);
    startTouched.current = Boolean(account?.yieldStartDate);
    if (!focusYield) return;
    const t = window.setTimeout(() => {
      yieldSectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      yieldRateRef.current?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(t);
  }, [open, account, today, reset, focusYield]);

  useEffect(() => {
    if (open && !startTouched.current && isISODate(initialDate)) setValue("yieldStartDate", initialDate);
  }, [open, initialDate, setValue]);

  const { ref: yieldRateRegisterRef, ...yieldRateField } = register("yieldRate");
  const { onChange: onStartChange, ...yieldStartField } = register("yieldStartDate");

  const submit = handleSubmit((v) => {
    setServerError(null);
    const yieldOn = v.yieldEnabled && supportsYield(v.type) && v.currency === "BRL";
    const full: AccountInput = {
      name: v.name,
      institution: v.institution.trim() || null,
      type: v.type,
      visibility: v.visibility,
      ownerMemberId: v.ownerMemberId === NONE ? null : v.ownerMemberId,
      initialBalanceCents: v.initialBalanceCents,
      initialBalanceDate: v.initialBalanceDate,
      color: v.color,
      icon: account && account.type === v.type ? account.icon : (ACCOUNT_TYPE_ICON[v.type]?.name ?? "landmark"),
      includeInTotals: v.includeInTotals,
      currency: v.currency,
      ...(yieldOn
        ? { yieldIndex: v.yieldIndex, yieldRateBps: percentTextToBps(v.yieldRate), yieldStartDate: v.yieldStartDate }
        : account
          ? { yieldIndex: null, yieldRateBps: null, yieldStartDate: null }
          : {}),
    };
    const input = account ? editPayload(account, full) : full;
    if (!input) return onOpenChange(false);
    save.mutate({ id: account?.id, input }, { onSuccess: () => onOpenChange(false), onError: (err) => setServerError(errorMessage(err)) });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" onOpenAutoFocus={focusYield ? (ev) => ev.preventDefault() : undefined}>
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
          <div className="grid items-start gap-4 sm:grid-cols-2">
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
            <Field
              label="Moeda"
              htmlFor="acc-currency"
              hint={currencyLocked ? "A conta já tem lançamentos: a moeda não muda. Para outra moeda, crie outra conta." : !account && !foreign ? "Conta no exterior (ex.: Wise em dólar)? Escolha a moeda dela." : undefined}
            >
              <Controller
                control={control}
                name="currency"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={currencyLocked}>
                    <SelectTrigger id="acc-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCY_OPTIONS.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            {foreign && (
              <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-info sm:mt-[26px]">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  Saldo e lançamentos em {currency}. Nos totais e relatórios, o valor entra em reais pela PTAX do Banco Central. Rendimento automático só existe em contas em reais.
                </span>
              </p>
            )}
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

          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field
              label="Saldo inicial"
              htmlFor="acc-initial"
              hint={account ? "Para corrigir o saldo de hoje, prefira “Ajustar saldo”." : initial < 0 ? "Saldo negativo (cheque especial)" : "Use a tecla − para valor negativo"}
            >
              <Controller control={control} name="initialBalanceCents" render={({ field }) => <MoneyInput id="acc-initial" allowNegative currency={currency} value={field.value} onChange={field.onChange} />} />
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

          {yieldEligible ? (
            <section ref={yieldSectionRef} aria-labelledby="acc-yield-title" className={cn("grid gap-4 rounded-xl border p-3", yieldEnabled && "border-brand/40 bg-accent/20")}>
              <label className="flex items-start justify-between gap-4 text-sm">
                <span>
                  <span id="acc-yield-title" className="flex items-center gap-1.5 font-medium">
                    <TrendingUp className="size-4 text-brand" aria-hidden /> Rendimento automático
                  </span>
                  <span className="block text-xs text-muted-foreground">Lança todo mês o rendimento pelo CDI, Selic, IPCA+ ou taxa prefixada.</span>
                </span>
                <Controller control={control} name="yieldEnabled" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Rendimento automático" />} />
              </label>
              {yieldEnabled ? (
                <>
                  <div className="grid items-start gap-4 sm:grid-cols-2">
                    <Field label="Indexador" htmlFor="acc-yield-index">
                      <Controller
                        control={control}
                        name="yieldIndex"
                        render={({ field }) => (
                          <Select
                            value={field.value}
                            onValueChange={(raw) => {
                              const v = raw as YieldIndex;
                              if (isPercentOfIndex(v) !== isPercentOfIndex(field.value)) setValue("yieldRate", rateFor(v, account));
                              field.onChange(v);
                            }}
                          >
                            <SelectTrigger id="acc-yield-index">
                              <SelectValue>{YIELD_INDEXES.find((i) => i.value === field.value)?.label}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {YIELD_INDEXES.map((i) => (
                                <SelectItem key={i.value} value={i.value}>
                                  {i.label}
                                  <span className="text-xs text-muted-foreground"> · {i.hint}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </Field>
                    <Field label={unit.label} htmlFor="acc-yield-rate" error={e.yieldRate?.message} hint={unit.example} required>
                      <div
                        className={cn(
                          "flex h-10 items-center rounded-lg border border-input bg-card text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
                          e.yieldRate && "border-destructive",
                        )}
                      >
                        {unit.prefix && <span className="shrink-0 whitespace-nowrap pl-3 text-muted-foreground">{unit.prefix}</span>}
                        <input
                          id="acc-yield-rate"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder={isPercentOfIndex(yieldIndex) ? "100" : "0,00"}
                          className="w-full min-w-0 bg-transparent px-3 text-right outline-none tabular placeholder:text-muted-foreground/70"
                          aria-invalid={Boolean(e.yieldRate)}
                          {...yieldRateField}
                          ref={(el) => {
                            yieldRateRegisterRef(el);
                            yieldRateRef.current = el;
                          }}
                        />
                        <span className="shrink-0 whitespace-nowrap pr-3 text-muted-foreground">{unit.suffix}</span>
                      </div>
                    </Field>
                    <Field label="Início do rendimento" htmlFor="acc-yield-start" error={e.yieldStartDate?.message} hint="Rende sobre o saldo de cada dia útil a partir desta data" required>
                      <Input
                        id="acc-yield-start"
                        type="date"
                        aria-invalid={Boolean(e.yieldStartDate)}
                        {...yieldStartField}
                        onChange={(ev) => {
                          startTouched.current = true;
                          return onStartChange(ev);
                        }}
                      />
                    </Field>
                  </div>
                  <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2 text-xs text-info">
                    <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span>
                      O sistema busca as taxas oficiais no Banco Central e lança o rendimento bruto todo mês em Investimentos › Rendimentos. Confira com o extrato e ajuste se houver diferença.
                      {account?.yieldIndex && " Ao alterar a configuração, os meses já lançados são recalculados."}
                    </span>
                  </p>
                </>
              ) : (
                account?.yieldIndex && <p className="text-xs text-muted-foreground">Ao salvar, o rendimento automático será desligado. Os rendimentos já lançados continuam na conta.</p>
              )}
            </section>
          ) : (
            account?.yieldIndex && (
              <p className="flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {foreign ? "O rendimento automático só vale para contas em reais" : "O rendimento automático só vale para investimento e poupança"}: com {foreign ? "esta moeda" : "este tipo"}, ele será desligado ao salvar. Os rendimentos já lançados continuam na conta.
              </p>
            )
          )}

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
