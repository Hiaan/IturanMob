"use client";

import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/features/finance/hooks";
import { GOAL_COLORS, GOAL_ICONS } from "./goal-icons";
import type { GoalDTO } from "./types";
import { useGoalMutations } from "./use-goals";

const NONE = "__none__";

const schema = z.object({
  name: z.string().trim().min(1, "Informe o nome da meta").max(80),
  targetCents: z.number().int().positive("Informe o valor desejado"),
  deadline: z.string().optional(),
  accountId: z.string(),
  color: z.string(),
  icon: z.string(),
  notes: z.string().max(1000).optional(),
});
type Values = z.infer<typeof schema>;

function defaults(goal: GoalDTO | null | undefined): Values {
  return {
    name: goal?.name ?? "",
    targetCents: goal?.targetCents ?? 0,
    deadline: goal?.deadline ?? "",
    accountId: goal?.accountId ?? NONE,
    color: goal?.color ?? GOAL_COLORS[0]!,
    icon: goal?.icon ?? "target",
    notes: goal?.notes ?? "",
  };
}

/** Criação e edição de meta (nome, valor desejado, prazo, conta vinculada, cor e ícone). */
export function GoalFormDialog({ open, onOpenChange, goal }: { open: boolean; onOpenChange: (open: boolean) => void; goal?: GoalDTO | null }) {
  const accounts = useAccounts();
  const { create, update } = useGoalMutations();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(goal) });
  const { control, register, handleSubmit, reset, formState } = form;
  const color = useWatch({ control, name: "color" });
  const e = formState.errors;
  const pending = create.isPending || update.isPending;

  // Reinicia ao abrir ou trocar de meta (recargas em segundo plano não apagam a edição).
  useEffect(() => {
    if (open) reset(defaults(goal));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goal?.id, reset]);

  const submit = (v: Values) => {
    const body = {
      name: v.name.trim(),
      targetCents: v.targetCents,
      deadline: v.deadline || null,
      accountId: v.accountId === NONE ? null : v.accountId,
      color: v.color,
      icon: v.icon,
      notes: v.notes?.trim() || null,
    };
    const done = { onSuccess: () => onOpenChange(false) };
    if (goal) update.mutate({ id: goal.id, ...body }, done);
    else create.mutate(body, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{goal ? "Editar meta" : "Nova meta"}</DialogTitle>
          <DialogDescription>Defina quanto deseja juntar e, se quiser, um prazo e a conta onde o dinheiro fica guardado.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={handleSubmit(submit)}>
          <Field label="Nome" htmlFor="goal-name" error={e.name?.message} required>
            <Input id="goal-name" placeholder="Ex.: Viagem de férias" {...register("name")} aria-invalid={Boolean(e.name)} autoFocus={!goal} />
          </Field>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Valor desejado" htmlFor="goal-target" error={e.targetCents?.message} required>
              <Controller
                control={control}
                name="targetCents"
                render={({ field }) => <MoneyInput id="goal-target" value={field.value} onChange={field.onChange} aria-invalid={Boolean(e.targetCents)} />}
              />
            </Field>
            <Field label="Prazo" htmlFor="goal-deadline" hint="Opcional — usado para calcular o valor mensal necessário">
              <Input id="goal-deadline" type="date" {...register("deadline")} />
            </Field>
          </div>
          <Field label="Conta vinculada" htmlFor="goal-account" hint="Opcional. Com conta vinculada, contribuições a partir de outra conta viram transferências.">
            <Controller
              control={control}
              name="accountId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="goal-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sem conta vinculada</SelectItem>
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

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-[13px] font-medium">Cor</legend>
            <Controller
              control={control}
              name="color"
              render={({ field }) => (
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cor da meta">
                  {GOAL_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={field.value === c}
                      aria-label={`Cor ${c}`}
                      onClick={() => field.onChange(c)}
                      className={cn("flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition outline-none focus-visible:ring-2 focus-visible:ring-ring", field.value === c && "ring-2 ring-foreground/60")}
                      style={{ backgroundColor: c }}
                    >
                      {field.value === c && <Check className="size-4 text-white" />}
                    </button>
                  ))}
                </div>
              )}
            />
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-[13px] font-medium">Ícone</legend>
            <Controller
              control={control}
              name="icon"
              render={({ field }) => (
                <div className="grid grid-cols-6 gap-2 sm:grid-cols-12" role="radiogroup" aria-label="Ícone da meta">
                  {GOAL_ICONS.map(({ name, label, Icon }) => (
                    <button
                      key={name}
                      type="button"
                      role="radio"
                      aria-checked={field.value === name}
                      aria-label={label}
                      title={label}
                      onClick={() => field.onChange(name)}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-lg border transition outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                        field.value === name ? "border-transparent" : "text-muted-foreground",
                      )}
                      style={field.value === name ? { backgroundColor: `${color}1f`, color, borderColor: color } : undefined}
                    >
                      <Icon className="size-4" />
                    </button>
                  ))}
                </div>
              )}
            />
          </fieldset>

          <Field label="Observações" htmlFor="goal-notes">
            <Textarea id="goal-notes" rows={2} placeholder="Opcional" {...register("notes")} />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={pending}>
              {goal ? "Salvar alterações" : "Criar meta"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
