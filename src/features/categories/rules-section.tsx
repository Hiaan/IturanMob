"use client";

import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";
import { ArrowLeftRight, ArrowRight, EyeOff, Info, MoreHorizontal, PencilLine, Play, Plus, Tags, Trash2, Wand2, Zap } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { formatBRL } from "@/lib/money";
import { PAYMENT_METHOD_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAccounts, useCards } from "@/features/finance/hooks";
import { TransferAccountField, suggestInvestmentAccount } from "@/features/accounts/transfer-account-field";
import { useCan } from "@/features/me/use-me";
import { EXCLUSION_KEEPS_BALANCE, EXCLUSION_REASON_LABELS } from "@/features/transactions/report-exclusion";
import { ExclusionReasonPicker, PARTY_LABELS, PartySuggestions } from "@/features/transactions/report-exclusion-dialog";
import { CategoryPicker } from "./category-picker";
import { MATCH_FIELD_LABELS, MATCH_TYPE_LABELS, RULE_SOURCE_LABELS, type RuleDTO } from "./types";
import { useRuleMutations, useRules } from "./use-category-mutations";

const ANY = "__any__";
const NONE = "__none__";

const schema = z
  .object({
    name: z.string().trim().min(1, "Dê um nome à regra").max(80),
    matchField: z.enum(["ANY", "DESCRIPTION", "MERCHANT"]),
    matchType: z.enum(["CONTAINS", "EQUALS", "STARTS_WITH", "REGEX"]),
    pattern: z.string().trim().min(1, "Informe o texto a procurar").max(200),
    minAmountCents: z.number().int().min(0),
    maxAmountCents: z.number().int().min(0),
    transactionType: z.string(),
    categoryId: z.string(),
    subcategoryId: z.string(),
    paymentMethod: z.string(),
    accountId: z.string(),
    /** "Então": definir categoria (e afins), desconsiderar nos relatórios ou tratar como transferência com outra conta própria. */
    action: z.enum(["CATEGORY", "EXCLUDE", "TRANSFER"]),
    transferAccountId: z.string(),
    exclusionReason: z.enum(["CLIENT_PASSTHROUGH", "REIMBURSEMENT", "OTHER"]),
    exclusionParty: z.string().trim().max(80, "Use até 80 caracteres"),
    /** Condição "só nesta conta / neste cartão": ANY, acc:<id> ou card:<id>. */
    where: z.string(),
    priority: z.number({ error: "Informe a prioridade" }).int("Use um número inteiro").min(0, "Mínimo 0").max(10000, "Máximo 10000"),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.matchType === "REGEX") {
      try {
        new RegExp(v.pattern);
      } catch {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: "Expressão regular inválida" });
      }
    }
    if (v.minAmountCents > 0 && v.maxAmountCents > 0 && v.minAmountCents > v.maxAmountCents) ctx.addIssue({ code: "custom", path: ["maxAmountCents"], message: "O máximo deve ser maior que o mínimo" });
    if (v.action === "TRANSFER") {
      if (v.transferAccountId === NONE) ctx.addIssue({ code: "custom", path: ["transferAccountId"], message: "Escolha a conta do outro lado da transferência" });
      if (v.where.startsWith("card:")) ctx.addIssue({ code: "custom", path: ["where"], message: "Compras no cartão não viram transferência: escolha uma conta ou “Qualquer conta ou cartão”" });
    } else if (v.action === "CATEGORY" && v.categoryId === NONE && v.paymentMethod === NONE && v.accountId === NONE) {
      ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Defina ao menos uma ação: categoria, forma de pagamento ou conta" });
    }
  });
type Values = z.infer<typeof schema>;

function defaults(rule?: RuleDTO | null): Values {
  return rule
    ? {
        name: rule.name,
        matchField: rule.matchField,
        matchType: rule.matchType,
        pattern: rule.pattern,
        minAmountCents: rule.minAmountCents ?? 0,
        maxAmountCents: rule.maxAmountCents ?? 0,
        transactionType: rule.transactionType ?? ANY,
        categoryId: rule.setCategoryId ?? NONE,
        subcategoryId: rule.setSubcategoryId ?? NONE,
        paymentMethod: rule.setPaymentMethod ?? NONE,
        accountId: rule.setAccountId ?? NONE,
        action: rule.setTransferAccountId ? "TRANSFER" : rule.setExcludeFromReports ? "EXCLUDE" : "CATEGORY",
        transferAccountId: rule.setTransferAccountId ?? NONE,
        exclusionReason: rule.setExclusionReason ?? "CLIENT_PASSTHROUGH",
        exclusionParty: rule.setExclusionParty ?? "",
        where: rule.matchAccountId ? `acc:${rule.matchAccountId}` : rule.matchCreditCardId ? `card:${rule.matchCreditCardId}` : ANY,
        priority: rule.priority,
        active: rule.active,
      }
    : {
        name: "",
        matchField: "ANY",
        matchType: "CONTAINS",
        pattern: "",
        minAmountCents: 0,
        maxAmountCents: 0,
        transactionType: "EXPENSE",
        categoryId: NONE,
        subcategoryId: NONE,
        paymentMethod: NONE,
        accountId: NONE,
        action: "CATEGORY",
        transferAccountId: NONE,
        exclusionReason: "CLIENT_PASSTHROUGH",
        exclusionParty: "",
        where: ANY,
        priority: 100,
        active: true,
      };
}

function conditionText(
  r: Pick<RuleDTO, "matchField" | "matchType" | "pattern" | "minAmountCents" | "maxAmountCents" | "transactionType" | "setTransferAccountId" | "matchAccountId" | "matchCreditCardId" | "matchAccount" | "matchCreditCard">,
): string {
  const parts = [`${MATCH_FIELD_LABELS[r.matchField]} ${MATCH_TYPE_LABELS[r.matchType]} “${r.pattern}”`];
  if (r.setTransferAccountId) parts.push("entradas e saídas");
  else if (r.transactionType) parts.push(r.transactionType === "INCOME" ? "receitas" : "despesas");
  if (r.minAmountCents != null && r.maxAmountCents != null) parts.push(`entre ${formatBRL(r.minAmountCents)} e ${formatBRL(r.maxAmountCents)}`);
  else if (r.minAmountCents != null) parts.push(`a partir de ${formatBRL(r.minAmountCents)}`);
  else if (r.maxAmountCents != null) parts.push(`até ${formatBRL(r.maxAmountCents)}`);
  if (r.matchCreditCardId) parts.push(`só no cartão ${r.matchCreditCard?.name ?? "escolhido"}`);
  else if (r.matchAccountId) parts.push(`só na conta ${r.matchAccount?.name ?? "escolhida"}`);
  return parts.join(" · ");
}

function actionText(r: RuleDTO): string {
  if (r.setTransferAccountId) return `Tratar como transferência com ${r.transferAccount?.name ?? "outra conta"}`;
  const parts: string[] = [];
  if (r.setExcludeFromReports) parts.push(["Desconsiderar", EXCLUSION_REASON_LABELS[r.setExclusionReason ?? "CLIENT_PASSTHROUGH"], r.setExclusionParty].filter(Boolean).join(" · "));
  if (r.category) parts.push(r.subcategory ? `${r.category.name} › ${r.subcategory.name}` : r.category.name);
  if (r.setPaymentMethod) parts.push(labelOf(PAYMENT_METHOD_LABELS, r.setPaymentMethod));
  if (r.account) parts.push(`conta ${r.account.name}`);
  return parts.join(" · ") || "Sem ação definida";
}

export function RuleFormDialog({ open, onOpenChange, rule }: { open: boolean; onOpenChange: (o: boolean) => void; rule?: RuleDTO | null }) {
  const { save } = useRuleMutations();
  const accounts = useAccounts();
  const allAccounts = useAccounts({ includeArchived: true });
  const allCards = useCards({ includeArchived: true });
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(rule) });
  const { control, register, handleSubmit, reset, setValue, formState } = form;
  const e = formState.errors;
  const [transactionType, categoryId, subcategoryId, matchType, action, transferAccountId, pattern, exclusionReason, exclusionParty, where] = useWatch({
    control,
    name: ["transactionType", "categoryId", "subcategoryId", "matchType", "action", "transferAccountId", "pattern", "exclusionReason", "exclusionParty", "where"],
  });
  const transfer = action === "TRANSFER";
  const exclude = action === "EXCLUDE";
  // Contas/cartões da condição: os ativos e o já escolhido (mesmo arquivado).
  const whereAccounts = (allAccounts.data ?? []).filter((a) => !a.archivedAt || where === `acc:${a.id}`);
  const whereCards = (allCards.data ?? []).filter((c) => !c.archivedAt || where === `card:${c.id}`);

  useEffect(() => {
    if (open) {
      reset(defaults(rule));
      setServerError(null);
    }
  }, [open, rule, reset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Editar regra" : "Nova regra automática"}</DialogTitle>
          <DialogDescription>Quando um lançamento atender a todas as condições, as ações são aplicadas. Regras com prioridade menor são avaliadas primeiro.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          noValidate
          onSubmit={handleSubmit((v) => {
            setServerError(null);
            const base = {
              name: v.name,
              matchField: v.matchField,
              matchType: v.matchType,
              pattern: v.pattern,
              minAmountCents: v.minAmountCents > 0 ? v.minAmountCents : null,
              maxAmountCents: v.maxAmountCents > 0 ? v.maxAmountCents : null,
              priority: v.priority,
              active: v.active,
              matchAccountId: v.where.startsWith("acc:") ? v.where.slice(4) : null,
              matchCreditCardId: v.where.startsWith("card:") ? v.where.slice(5) : null,
            };
            const classify = {
              transactionType: v.transactionType === ANY ? null : (v.transactionType as "EXPENSE" | "INCOME"),
              setTransferAccountId: null,
              setCategoryId: v.categoryId === NONE ? null : v.categoryId,
              setSubcategoryId: v.categoryId === NONE || v.subcategoryId === NONE ? null : v.subcategoryId,
              setPaymentMethod: v.paymentMethod === NONE ? null : v.paymentMethod,
              setAccountId: v.accountId === NONE ? null : v.accountId,
            };
            const noExclusion = { setExcludeFromReports: false, setExclusionReason: null, setExclusionParty: null };
            save.mutate(
              {
                id: rule?.id,
                // Transferência não é receita nem despesa: a regra vale para os dois sentidos e não define categoria.
                // Desconsiderar pode vir junto com categoria; nunca com transferência.
                input:
                  v.action === "TRANSFER"
                    ? { ...base, ...noExclusion, transactionType: null, setTransferAccountId: v.transferAccountId, setCategoryId: null, setSubcategoryId: null, setPaymentMethod: null, setAccountId: null }
                    : v.action === "EXCLUDE"
                      ? { ...base, ...classify, setExcludeFromReports: true, setExclusionReason: v.exclusionReason, setExclusionParty: v.exclusionParty.trim() || null }
                      : { ...base, ...classify, ...noExclusion },
              },
              { onSuccess: () => onOpenChange(false), onError: (err) => setServerError(errorMessage(err)) },
            );
          })}
        >
          <Field label="Nome da regra" htmlFor="rule-name" error={e.name?.message} required>
            <Input id="rule-name" placeholder={exclude ? "Ex.: Anúncios do cliente Alfa" : "Ex.: iFood é delivery"} {...register("name")} aria-invalid={Boolean(e.name)} autoFocus={!rule} />
          </Field>

          <fieldset className="grid gap-3 rounded-xl border p-4">
            <legend className="px-1 text-[13px] font-semibold">Quando</legend>
            <div className="grid items-start gap-3 sm:grid-cols-[1fr_1fr]">
              <Field label="Campo" htmlFor="rule-field">
                <Controller
                  control={control}
                  name="matchField"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="rule-field">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(MATCH_FIELD_LABELS).map(([k, label]) => (
                          <SelectItem key={k} value={k}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <Field label="Comparação" htmlFor="rule-type">
                <Controller
                  control={control}
                  name="matchType"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="rule-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(MATCH_TYPE_LABELS).map(([k, label]) => (
                          <SelectItem key={k} value={k}>
                            {label.charAt(0).toUpperCase() + label.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            </div>
            <Field
              label="Texto"
              htmlFor="rule-pattern"
              error={e.pattern?.message}
              hint={matchType === "REGEX" ? "Expressão regular (sem diferenciar maiúsculas). Ex.: ^uber( |$)" : "Sem diferenciar maiúsculas e acentos."}
              required
            >
              <Input id="rule-pattern" placeholder={exclude ? "Ex.: facebk" : "Ex.: ifood"} {...register("pattern")} aria-invalid={Boolean(e.pattern)} className={cn(matchType === "REGEX" && "font-mono")} />
            </Field>
            <div className="grid items-start gap-3 sm:grid-cols-3">
              <Field label="Tipo de lançamento" htmlFor="rule-ttype" hint={transfer ? "Transferência vale para entradas e saídas" : undefined}>
                <Controller
                  control={control}
                  name="transactionType"
                  render={({ field }) => (
                    <Select
                      disabled={transfer}
                      value={transfer ? ANY : field.value}
                      onValueChange={(v) => {
                        field.onChange(v);
                        setValue("categoryId", NONE);
                        setValue("subcategoryId", NONE);
                      }}
                    >
                      <SelectTrigger id="rule-ttype">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ANY}>{transfer ? "Entradas e saídas" : "Qualquer"}</SelectItem>
                        <SelectItem value="EXPENSE">Despesas</SelectItem>
                        <SelectItem value="INCOME">Receitas</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
              <Field label="Valor mínimo" htmlFor="rule-min" hint="R$ 0,00 = sem mínimo">
                <Controller control={control} name="minAmountCents" render={({ field }) => <MoneyInput id="rule-min" value={field.value} onChange={field.onChange} />} />
              </Field>
              <Field label="Valor máximo" htmlFor="rule-max" error={e.maxAmountCents?.message} hint="R$ 0,00 = sem máximo">
                <Controller control={control} name="maxAmountCents" render={({ field }) => <MoneyInput id="rule-max" value={field.value} onChange={field.onChange} aria-invalid={Boolean(e.maxAmountCents)} />} />
              </Field>
            </div>
            <Field label="Conta ou cartão" htmlFor="rule-where" error={e.where?.message} hint={where === ANY ? "Vale para lançamentos de qualquer conta ou cartão." : "Só lançamentos desta conta ou deste cartão."}>
              <Controller
                control={control}
                name="where"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="rule-where" aria-invalid={Boolean(e.where)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Qualquer conta ou cartão</SelectItem>
                      {whereAccounts.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>Só na conta…</SelectLabel>
                          {whereAccounts.map((a) => (
                            <SelectItem key={a.id} value={`acc:${a.id}`}>
                              Só na conta {a.name}
                              {a.archivedAt ? " (arquivada)" : ""}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                      {whereCards.length > 0 && !transfer && (
                        <SelectGroup>
                          <SelectLabel>Só no cartão…</SelectLabel>
                          {whereCards.map((c) => (
                            <SelectItem key={c.id} value={`card:${c.id}`}>
                              Só no cartão {c.name}
                              {c.archivedAt ? " (arquivado)" : ""}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </fieldset>

          <fieldset className="grid gap-3 rounded-xl border p-4">
            <legend className="px-1 text-[13px] font-semibold">Então</legend>
            <Controller
              control={control}
              name="action"
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Ação da regra">
                  {(
                    [
                      ["CATEGORY", Tags, "Definir categoria", "Categoria, forma de pagamento ou conta"],
                      ["EXCLUDE", EyeOff, "Desconsiderar nos relatórios", "Repasse de cliente ou reembolso: saldo e fatura não mudam"],
                      ["TRANSFER", ArrowLeftRight, "Transferência com a conta…", "Aplicação/resgate ou entre contas próprias: não é receita nem despesa"],
                    ] as const
                  ).map(([value, Icon, label, desc]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === value}
                      onClick={() => {
                        field.onChange(value);
                        // Compra no cartão não vira transferência: limpa a condição de cartão.
                        if (value === "TRANSFER" && where.startsWith("card:")) setValue("where", ANY);
                      }}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border p-3 text-left text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                        field.value === value ? "border-brand bg-accent/60" : "hover:bg-muted/50",
                      )}
                    >
                      <Icon className={cn("mt-0.5 size-4 shrink-0", field.value === value ? "text-brand" : "text-muted-foreground")} aria-hidden />
                      <span className="min-w-0">
                        <span className="block font-medium">{label}</span>
                        <span className="block text-xs text-muted-foreground">{desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            />
            {transfer ? (
              <div className="grid gap-2">
                <TransferAccountField
                  id="rule-transfer-account"
                  label="Conta do outro lado"
                  value={transferAccountId === NONE ? null : transferAccountId}
                  onChange={(id) => setValue("transferAccountId", id ?? NONE, { shouldValidate: formState.isSubmitted })}
                  suggestion={suggestInvestmentAccount([pattern], null)}
                  error={e.transferAccountId?.message}
                />
                <p className="text-xs text-muted-foreground">
                  Na importação de extratos e no WhatsApp, a saída vira transferência <strong className="font-medium text-foreground">para</strong> esta conta e a entrada, transferência{" "}
                  <strong className="font-medium text-foreground">vinda</strong> dela. Sem categoria: não conta como receita nem despesa.
                </p>
              </div>
            ) : (
              <>
                {exclude && (
                  <div className="grid gap-3">
                    <div className="grid gap-1.5">
                      <p id="rule-rx-reason-label" className="text-[13px] font-medium">
                        Motivo
                      </p>
                      <ExclusionReasonPicker idPrefix="rule-rx" value={exclusionReason} onChange={(r) => setValue("exclusionReason", r)} />
                    </div>
                    <Field
                      label={`${PARTY_LABELS[exclusionReason]}${exclusionReason === "CLIENT_PASSTHROUGH" ? "" : " (opcional)"}`}
                      htmlFor="rule-party"
                      error={e.exclusionParty?.message}
                      hint={exclusionReason === "CLIENT_PASSTHROUGH" ? "Agrupa o saldo do repasse por cliente (quanto ele pagou e quanto foi gasto para ele)." : undefined}
                    >
                      <Input id="rule-party" maxLength={80} autoComplete="off" placeholder="Ex.: Agência Alfa" {...register("exclusionParty")} aria-invalid={Boolean(e.exclusionParty)} />
                      <PartySuggestions value={exclusionParty} onPick={(v) => setValue("exclusionParty", v)} enabled={open} />
                    </Field>
                    <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2.5 text-xs text-info">
                      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>
                        Lançamentos novos que atenderem à regra (extrato importado, WhatsApp ou manual) já entram desconsiderados. <strong className="font-semibold">{EXCLUSION_KEEPS_BALANCE}</strong> Para os
                        anteriores, use “Aplicar a lançamentos anteriores” na lista de regras.
                      </span>
                    </p>
                    <p className="pt-1 text-[13px] font-semibold">Também classificar (opcional)</p>
                  </div>
                )}
                <Field label="Categoria" htmlFor="rule-category" error={e.categoryId?.message}>
                  <CategoryPicker
                    id="rule-category"
                    kind={transactionType === "INCOME" ? "INCOME" : transactionType === "EXPENSE" ? "EXPENSE" : null}
                    allowNone
                    noneLabel="Não alterar a categoria"
                    value={categoryId === NONE ? null : { categoryId, subcategoryId: subcategoryId === NONE ? null : subcategoryId }}
                    onChange={(c) => {
                      setValue("categoryId", c?.categoryId ?? NONE, { shouldValidate: formState.isSubmitted });
                      setValue("subcategoryId", c?.subcategoryId ?? NONE);
                    }}
                    invalid={Boolean(e.categoryId)}
                  />
                </Field>
                <div className="grid items-start gap-3 sm:grid-cols-2">
                  <Field label="Forma de pagamento" htmlFor="rule-method">
                    <Controller
                      control={control}
                      name="paymentMethod"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id="rule-method">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Não alterar</SelectItem>
                            {Object.entries(PAYMENT_METHOD_LABELS).map(([k, label]) => (
                              <SelectItem key={k} value={k}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>
                  <Field label="Conta" htmlFor="rule-account">
                    <Controller
                      control={control}
                      name="accountId"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger id="rule-account">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Não alterar</SelectItem>
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
              </>
            )}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-[160px_1fr] sm:items-end">
            <Field label="Prioridade" htmlFor="rule-priority" error={e.priority?.message} hint="Menor = avaliada antes">
              <Input id="rule-priority" type="number" min={0} max={10000} inputMode="numeric" {...register("priority", { valueAsNumber: true })} aria-invalid={Boolean(e.priority)} />
            </Field>
            <label className="flex h-10 items-center justify-between gap-3 rounded-lg border px-3 text-sm sm:mb-5">
              Regra ativa
              <Controller control={control} name="active" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Regra ativa" />} />
            </label>
          </div>

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
              {rule ? "Salvar regra" : "Criar regra"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Seção "Regras automáticas" da tela de categorias. */
export function RulesSection() {
  const rules = useRules();
  const canWrite = useCan("rules:write");
  const canApply = useCan("transactions:write");
  const { save, remove, apply, applyTransfer, applyExclusion } = useRuleMutations();
  const [editing, setEditing] = useState<RuleDTO | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<RuleDTO | null>(null);
  const [applyingTransfer, setApplyingTransfer] = useState<RuleDTO | null>(null);
  const [applyingExclusion, setApplyingExclusion] = useState<RuleDTO | null>(null);
  const items = useMemo(() => [...(rules.data ?? [])].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt)), [rules.data]);
  // "Sem categoria" só classifica: regras que desconsideram são aplicadas uma a uma (com confirmação).
  const applicable = items.filter((r) => r.active && r.setCategoryId && !r.setExcludeFromReports);

  const openForm = (r: RuleDTO | null) => {
    setEditing(r);
    setFormOpen(true);
  };

  return (
    <Card id="regras">
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="size-4 text-brand" aria-hidden /> Regras automáticas
          </CardTitle>
          <CardDescription className="mt-1">
            Categorize automaticamente novos lançamentos a partir do texto, do valor, do tipo e da conta ou cartão — desconsidere nos relatórios repasses de clientes e reembolsos, ou trate aplicações e
            resgates como transferência entre contas próprias.
          </CardDescription>
        </div>
        <CardAction className="ml-0 flex-wrap sm:ml-auto">
          {canApply && (
            <Button variant="outline" size="sm" onClick={() => apply.mutate(applicable)} loading={apply.isPending} disabled={!applicable.length}>
              <Play /> Aplicar a lançamentos sem categoria
            </Button>
          )}
          {canWrite && (
            <Button variant="brand" size="sm" onClick={() => openForm(null)}>
              <Plus /> Nova regra
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2.5 text-xs text-info">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Regras são explícitas: só valem quando o lançamento atende exatamente às condições que você definiu. O sistema <strong className="font-semibold">não presume</strong> que todas as compras de um mesmo
            estabelecimento pertencem à mesma categoria (na farmácia, por exemplo, pode haver remédios e itens de higiene). Use valor e tipo para ser mais específico. Ao aplicar, apenas lançamentos ainda sem categoria
            são alterados. Regras de transferência (ex.: “Resgate CDB” com a conta CDB) fazem a importação e o WhatsApp registrarem a movimentação como transferência, sem contar como receita ou despesa. Regras de
            desconsiderar (ex.: “facebk” só no cartão Nubank → repasse do cliente Alfa) tiram o valor das receitas, despesas e relatórios sem mudar o saldo nem a fatura.
          </span>
        </p>
        {rules.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : rules.error ? (
          <ErrorState error={rules.error} onRetry={() => rules.refetch()} compact />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="Nenhuma regra criada"
            description="Ex.: “Estabelecimento contém ifood → Alimentação › Delivery”."
            action={
              canWrite && (
                <Button variant="brand" onClick={() => openForm(null)}>
                  <Plus /> Criar primeira regra
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y rounded-xl border">
            {items.map((r) => (
              <li key={r.id} className={cn("flex flex-col gap-3 p-3 sm:flex-row sm:items-center", !r.active && "bg-muted/30")}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{r.name}</p>
                    <Badge variant="outline" title="Prioridade: menor número é avaliado antes">
                      Prioridade {r.priority}
                    </Badge>
                    {r.setTransferAccountId && (
                      <Badge variant="brand">
                        <ArrowLeftRight aria-hidden /> Transferência
                      </Badge>
                    )}
                    {r.setExcludeFromReports && (
                      <Badge variant="outline" className="border-dashed border-muted-foreground/50 text-muted-foreground" title={EXCLUSION_KEEPS_BALANCE}>
                        <EyeOff aria-hidden /> Desconsidera
                      </Badge>
                    )}
                    {!r.active && <Badge variant="muted">Inativa</Badge>}
                    {r.source !== "USER" && <Badge variant="info">{RULE_SOURCE_LABELS[r.source]}</Badge>}
                  </div>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">Se</span> {conditionText(r)}
                  </p>
                  <p className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
                    {r.setTransferAccountId ? (
                      <ArrowLeftRight className="mt-0.5 size-3 shrink-0" aria-hidden />
                    ) : r.setExcludeFromReports ? (
                      <EyeOff className="mt-0.5 size-3 shrink-0" aria-hidden />
                    ) : (
                      <ArrowRight className="mt-0.5 size-3 shrink-0" aria-hidden />
                    )}
                    <span className="min-w-0 break-words">
                      {r.category && <span className="mr-1 inline-block size-2 rounded-full align-middle" style={{ backgroundColor: r.category.color }} aria-hidden />}
                      <span className="font-medium text-foreground/80">{actionText(r)}</span>
                      <span> · aplicada {r.timesApplied} {r.timesApplied === 1 ? "vez" : "vezes"}</span>
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2 self-end sm:self-center">
                  {canWrite && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="sr-only sm:not-sr-only">{r.active ? "Ativa" : "Inativa"}</span>
                      <Switch
                        checked={r.active}
                        disabled={save.isPending}
                        onCheckedChange={(v) => save.mutate({ id: r.id, input: { active: v } }, { onError: (err) => toast.error(errorMessage(err)) })}
                        aria-label={`${r.active ? "Desativar" : "Ativar"} regra ${r.name}`}
                      />
                    </label>
                  )}
                  {(canWrite || canApply) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ações da regra ${r.name}`}>
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canApply &&
                          (r.setTransferAccountId ? (
                            <DropdownMenuItem onSelect={() => setApplyingTransfer(r)}>
                              <Play /> Aplicar a lançamentos anteriores…
                            </DropdownMenuItem>
                          ) : r.setExcludeFromReports ? (
                            <DropdownMenuItem onSelect={() => setApplyingExclusion(r)}>
                              <Play /> Aplicar a lançamentos anteriores…
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem disabled={!r.setCategoryId} onSelect={() => apply.mutate([r])}>
                              <Play /> Aplicar a lançamentos sem categoria
                            </DropdownMenuItem>
                          ))}
                        {canWrite && (
                          <>
                            <DropdownMenuItem onSelect={() => openForm(r)}>
                              <PencilLine /> Editar
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(r)}>
                              <Trash2 /> Excluir
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <RuleFormDialog open={formOpen} onOpenChange={setFormOpen} rule={editing} />
      <AlertDialog open={Boolean(applyingTransfer)} onOpenChange={(o) => !o && !applyTransfer.isPending && setApplyingTransfer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Converter lançamentos anteriores em transferência?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  As receitas e despesas já registradas que atendem à regra “{applyingTransfer?.name}” viram transferência com{" "}
                  <strong className="text-foreground">{applyingTransfer?.transferAccount?.name ?? "a conta da regra"}</strong>: a despesa passa a ser saída para essa conta e a receita, entrada vinda
                  dela. Elas deixam de contar como receita ou despesa e os saldos são recalculados.
                </p>
                <p>
                  Se o outro lado do mesmo movimento já estiver lançado nessa conta, os dois são unidos: o repetido vai para a Lixeira (dá para restaurar) e tudo fica no histórico. Compras no
                  cartão e lançamentos parcelados não são alterados. São convertidos até 500 por vez.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applyTransfer.isPending}>Cancelar</AlertDialogCancel>
            <Button variant="brand" loading={applyTransfer.isPending} onClick={() => applyingTransfer && applyTransfer.mutate(applyingTransfer, { onSettled: () => setApplyingTransfer(null) })}>
              <ArrowLeftRight /> Converter em transferência
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(applyingExclusion)} onOpenChange={(o) => !o && !applyExclusion.isPending && setApplyingExclusion(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconsiderar lançamentos anteriores?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  As receitas e despesas já registradas que atendem à regra “{applyingExclusion?.name}” passam a ser desconsideradas nos relatórios como{" "}
                  <strong className="text-foreground">
                    {EXCLUSION_REASON_LABELS[applyingExclusion?.setExclusionReason ?? "CLIENT_PASSTHROUGH"].toLowerCase()}
                    {applyingExclusion?.setExclusionParty ? ` (${applyingExclusion.setExclusionParty})` : ""}
                  </strong>
                  .
                </p>
                <p>
                  <strong className="font-medium text-foreground">{EXCLUSION_KEEPS_BALANCE}</strong> O valor só sai de receitas, despesas, categorias, orçamentos e relatórios. Dá para voltar a considerar
                  cada lançamento depois.
                  {applyingExclusion?.setCategoryId ? " Os que ainda não têm categoria também recebem a categoria da regra." : ""}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applyExclusion.isPending}>Cancelar</AlertDialogCancel>
            <Button variant="brand" loading={applyExclusion.isPending} onClick={() => applyingExclusion && applyExclusion.mutate(applyingExclusion, { onSettled: () => setApplyingExclusion(null) })}>
              <EyeOff /> Desconsiderar
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir a regra “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.setExcludeFromReports
                ? "Lançamentos já categorizados ou desconsiderados por ela continuam como estão. Novos lançamentos deixam de seguir esta regra."
                : "Lançamentos já categorizados por ela não são alterados. Novos lançamentos deixam de ser categorizados por esta regra."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button variant="destructive" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}>
              <Trash2 /> Excluir regra
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
