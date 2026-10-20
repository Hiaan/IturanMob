"use client";

import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { CategoryPicker, categoryValue, parseCategoryValue } from "@/features/recurring/pickers";
import { REPORT_SCOPE_LABELS } from "@/features/transactions/nature";
import { useHousehold } from "@/features/settings/use-household";
import type { IncomeGoalProgress, IncomeGoalScope } from "./types";
import { useIncomeGoalMutations } from "./use-income-goals";

const SCOPES: IncomeGoalScope[] = ["ALL", "PERSONAL", "BUSINESS"];
const MAX_THRESHOLDS = 8;

const schema = z
  .object({
    scope: z.enum(["ALL", "PERSONAL", "BUSINESS"]),
    category: z.string(),
    targetCents: z.number().int().positive("Informe o valor da meta"),
    thresholdMode: z.enum(["budget", "custom"]),
    thresholds: z.array(z.number().int().min(1).max(200)).max(MAX_THRESHOLDS),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.thresholdMode === "custom" && !v.thresholds.length) ctx.addIssue({ code: "custom", path: ["thresholds"], message: "Adicione ao menos uma faixa ou use as do orçamento" });
  });
type Values = z.infer<typeof schema>;

function defaults(goal: IncomeGoalProgress | null | undefined): Values {
  return {
    scope: goal?.scope ?? "ALL",
    category: categoryValue(goal?.categoryId),
    targetCents: goal?.targetCents ?? 0,
    thresholdMode: goal?.alertThresholds.length ? "custom" : "budget",
    thresholds: goal?.alertThresholds ?? [],
    active: goal?.active ?? true,
  };
}

const percentList = (values: number[]) => values.map((t) => `${t}%`).join(", ");

/** Criação e edição de meta de ganho: recorte, categoria de receita (opcional), valor e faixas de aviso. */
export function IncomeGoalFormDialog({ open, onOpenChange, goal }: { open: boolean; onOpenChange: (open: boolean) => void; goal?: IncomeGoalProgress | null }) {
  const household = useHousehold();
  const { create, update } = useIncomeGoalMutations();
  const [serverError, setServerError] = useState<string | null>(null);
  const [newThreshold, setNewThreshold] = useState("");
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(goal) });
  const { control, handleSubmit, reset, setValue, formState } = form;
  const mode = useWatch({ control, name: "thresholdMode" });
  const thresholds = useWatch({ control, name: "thresholds" });
  const e = formState.errors;
  const pending = create.isPending || update.isPending;
  const budgetBands = household.data?.settings.budgetAlertThresholds ?? [];

  // Reinicia ao abrir ou trocar de meta (recargas em segundo plano não apagam a edição).
  useEffect(() => {
    if (!open) return;
    reset(defaults(goal));
    setServerError(null);
    setNewThreshold("");
    setThresholdError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goal?.id, reset]);

  const addThreshold = () => {
    const n = Number(newThreshold);
    if (!newThreshold.trim() || !Number.isInteger(n) || n < 1 || n > 200) return setThresholdError("Use um número inteiro de 1 a 200");
    if (thresholds.includes(n)) return setThresholdError(`${n}% já está na lista`);
    if (thresholds.length >= MAX_THRESHOLDS) return setThresholdError(`Até ${MAX_THRESHOLDS} faixas`);
    setValue("thresholds", [...thresholds, n].sort((a, b) => a - b), { shouldValidate: formState.isSubmitted });
    setNewThreshold("");
    setThresholdError(null);
  };

  const submit = (v: Values) => {
    setServerError(null);
    const body = {
      scope: v.scope,
      categoryId: parseCategoryValue(v.category).categoryId,
      targetCents: v.targetCents,
      alertThresholds: v.thresholdMode === "custom" ? v.thresholds : [],
      active: v.active,
    };
    const callbacks = { onSuccess: () => onOpenChange(false), onError: (err: unknown) => setServerError(errorMessage(err)) };
    if (goal) update.mutate({ id: goal.id, ...body }, callbacks);
    else create.mutate(body, callbacks);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{goal ? "Editar meta de ganho" : "Nova meta de ganho"}</DialogTitle>
          <DialogDescription>Quanto a família quer ganhar por mês. Conta a receita reconhecida no regime da família; repasses ficam de fora.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={handleSubmit(submit)}>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Recorte" htmlFor="income-goal-scope" required>
              <Controller
                control={control}
                name="scope"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="income-goal-scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCOPES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {REPORT_SCOPE_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label="Categoria de receita" htmlFor="income-goal-category" hint="Opcional">
              <Controller
                control={control}
                name="category"
                render={({ field }) => (
                  <CategoryPicker
                    id="income-goal-category"
                    value={field.value}
                    onChange={field.onChange}
                    kind="INCOME"
                    withSubcategories={false}
                    current={goal?.categoryId && goal.categoryName ? { value: categoryValue(goal.categoryId), label: goal.categoryName } : null}
                  />
                )}
              />
            </Field>
          </div>

          <Field label="Valor da meta no mês" htmlFor="income-goal-target" error={e.targetCents?.message} required>
            <Controller
              control={control}
              name="targetCents"
              render={({ field }) => <MoneyInput id="income-goal-target" value={field.value} onChange={field.onChange} aria-invalid={Boolean(e.targetCents)} autoFocus={!goal} />}
            />
          </Field>

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-[13px] font-medium">Faixas de aviso</legend>
            <Controller
              control={control}
              name="thresholdMode"
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Faixas de aviso">
                  {(
                    [
                      ["budget", "Usar as do orçamento", budgetBands.length ? percentList(budgetBands) : "As mesmas dos alertas de orçamento"],
                      ["custom", "Personalizar", "Percentuais próprios (até 8)"],
                    ] as const
                  ).map(([value, label, desc]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={field.value === value}
                      onClick={() => {
                        // Ao personalizar, parte das faixas do orçamento.
                        if (value === "custom" && !thresholds.length && budgetBands.length) setValue("thresholds", budgetBands.slice(0, MAX_THRESHOLDS));
                        field.onChange(value);
                      }}
                      className={cn(
                        "min-w-0 rounded-xl border p-3 text-left text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                        field.value === value ? "border-brand bg-accent/60" : "hover:bg-muted/50",
                      )}
                    >
                      <span className="block font-medium">{label}</span>
                      <span className="block break-words text-xs text-muted-foreground">{desc}</span>
                    </button>
                  ))}
                </div>
              )}
            />
            {mode === "custom" && (
              <div className="grid gap-2 rounded-xl border bg-muted/30 p-3">
                <div className="flex flex-wrap gap-2" aria-live="polite">
                  {thresholds.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full border bg-card px-3 py-1 text-sm font-medium tabular">
                      {t}%
                      <button
                        type="button"
                        aria-label={`Remover ${t}%`}
                        onClick={() => setValue("thresholds", thresholds.filter((x) => x !== t), { shouldValidate: formState.isSubmitted })}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ))}
                  {!thresholds.length && <span className="text-sm text-muted-foreground">Nenhuma faixa ainda.</span>}
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    inputMode="numeric"
                    placeholder="Ex.: 80"
                    value={newThreshold}
                    onChange={(ev) => {
                      setNewThreshold(ev.target.value);
                      setThresholdError(null);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        addThreshold();
                      }
                    }}
                    className="w-28"
                    aria-label="Nova faixa em %"
                    aria-invalid={Boolean(thresholdError)}
                  />
                  <Button type="button" variant="outline" onClick={addThreshold} disabled={thresholds.length >= MAX_THRESHOLDS}>
                    Adicionar
                  </Button>
                </div>
                {(thresholdError || e.thresholds?.message) && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {thresholdError ?? e.thresholds?.message}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">De 1% a 200% da meta. Cada faixa avisa uma vez por mês.</p>
              </div>
            )}
          </fieldset>

          <label className="flex items-start justify-between gap-3 text-sm">
            <span>
              <span className="font-medium">Meta ativa</span>
              <span className="block text-xs text-muted-foreground">Vale todo mês até ser desativada. Só uma meta ativa por recorte e categoria.</span>
            </span>
            <Controller control={control} name="active" render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Meta ativa" />} />
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
            <Button type="submit" variant="brand" loading={pending}>
              {goal ? "Salvar alterações" : "Criar meta de ganho"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
