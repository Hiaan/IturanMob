"use client";

import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { LockKeyhole, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { todayISO } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useMe } from "@/features/me/use-me";
import { REMINDER_OPTIONS, durationLabel } from "./format";
import type { AppointmentDTO } from "./types";
import { useAppointmentMutations } from "./use-agenda";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const schema = z
  .object({
    title: z.string().trim().min(1, "Informe o compromisso").max(160, "Use até 160 caracteres"),
    date: z.string().length(10, "Informe a data"),
    time: z.string().refine((v) => v === "" || TIME.test(v), "Hora inválida"),
    endTime: z.string().refine((v) => v === "" || TIME.test(v), "Hora inválida"),
    location: z.string().max(200, "Use até 200 caracteres"),
    notes: z.string().max(2000, "Use até 2000 caracteres"),
    visibility: z.enum(["SHARED", "PRIVATE"]),
    reminder: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.endTime && !v.time) ctx.addIssue({ code: "custom", path: ["endTime"], message: "Informe também a hora de início" });
    else if (v.endTime && v.time && v.endTime <= v.time) ctx.addIssue({ code: "custom", path: ["endTime"], message: "O fim precisa ser depois do início" });
  });
type Values = z.infer<typeof schema>;

function defaults(a: AppointmentDTO | null | undefined, today: string, date?: string): Values {
  return {
    title: a?.title ?? "",
    date: a?.date ?? date ?? today,
    time: a?.time ?? "",
    endTime: a?.endTime ?? "",
    location: a?.location ?? "",
    notes: a?.notes ?? "",
    visibility: a?.visibility ?? "SHARED",
    reminder: a ? (a.reminderMinutes === null ? "none" : String(a.reminderMinutes)) : "60",
  };
}

const VISIBILITY = [
  { value: "SHARED", title: "Compartilhado com a família", hint: "Todos veem; pode ir para o grupo do WhatsApp.", icon: Users },
  { value: "PRIVATE", title: "Privado", hint: "Só você vê; nunca vai para o grupo do WhatsApp.", icon: LockKeyhole },
] as const;

/** Compromisso da agenda — criação e edição. */
export function AppointmentFormDialog({
  open,
  onOpenChange,
  appointment,
  defaultDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment?: AppointmentDTO | null;
  defaultDate?: string;
}) {
  const me = useMe();
  const today = todayISO(me.data?.household.timezone);
  const { create, update } = useAppointmentMutations();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(appointment, today, defaultDate) });
  const { control, register, handleSubmit, reset, formState } = form;
  const e = formState.errors;
  // Só quem criou pode tornar privado um compromisso que já existe.
  const canMakePrivate = !appointment || appointment.visibility === "PRIVATE" || !appointment.owner || appointment.owner.id === me.data?.member.id;

  useEffect(() => {
    if (open) reset(defaults(appointment, today, defaultDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment?.id]);

  const reminderOptions =
    appointment && appointment.reminderMinutes !== null && !REMINDER_OPTIONS.some((o) => o.value === String(appointment.reminderMinutes))
      ? [...REMINDER_OPTIONS, { value: String(appointment.reminderMinutes), label: appointment.reminderMinutes === 0 ? "Na hora" : `${durationLabel(appointment.reminderMinutes)} antes` }]
      : REMINDER_OPTIONS;

  const submit = (v: Values) => {
    const body = {
      title: v.title.trim(),
      date: v.date,
      time: v.time || null,
      endTime: v.time && v.endTime ? v.endTime : null,
      location: v.location.trim() || null,
      notes: v.notes.trim() || null,
      visibility: v.visibility,
      reminderMinutes: v.reminder === "none" ? null : Number(v.reminder),
    };
    const done = { onSuccess: () => onOpenChange(false) };
    if (appointment) update.mutate({ id: appointment.id, ...body }, done);
    else create.mutate(body, done);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{appointment ? "Editar compromisso" : "Novo compromisso"}</DialogTitle>
          <DialogDescription>Sem hora, o compromisso vale para o dia todo.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={handleSubmit(submit)}>
          <Field label="Título" htmlFor="appt-title" error={e.title?.message} required>
            <Input id="appt-title" placeholder="Ex.: Dentista" autoComplete="off" {...register("title")} aria-invalid={Boolean(e.title)} />
          </Field>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-3">
            <Field label="Data" htmlFor="appt-date" error={e.date?.message} required>
              <Input id="appt-date" type="date" {...register("date")} aria-invalid={Boolean(e.date)} />
            </Field>
            <div className="grid grid-cols-2 items-start gap-4 sm:col-span-2">
              <Field label="Hora" htmlFor="appt-time" error={e.time?.message} hint="Vazio: dia todo">
                <Input id="appt-time" type="time" {...register("time")} aria-invalid={Boolean(e.time)} />
              </Field>
              <Field label="Fim" htmlFor="appt-end" error={e.endTime?.message} hint="Opcional">
                <Input id="appt-end" type="time" {...register("endTime")} aria-invalid={Boolean(e.endTime)} />
              </Field>
            </div>
          </div>
          <Field label="Local" htmlFor="appt-location" error={e.location?.message}>
            <Input id="appt-location" placeholder="Opcional" {...register("location")} />
          </Field>
          <Field label="Observações" htmlFor="appt-notes" error={e.notes?.message}>
            <Textarea id="appt-notes" rows={2} placeholder="Opcional" {...register("notes")} />
          </Field>
          <Controller
            control={control}
            name="visibility"
            render={({ field }) => (
              <div className="grid gap-1.5">
                <span id="appt-visibility-label" className="text-[13px] font-medium">
                  Visibilidade
                </span>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="appt-visibility-label">
                  {VISIBILITY.map((o) => {
                    const checked = field.value === o.value;
                    const disabled = o.value === "PRIVATE" && !canMakePrivate;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-label={o.title}
                        aria-describedby={`appt-vis-${o.value}`}
                        disabled={disabled}
                        onClick={() => field.onChange(o.value)}
                        className={cn(
                          "flex items-start gap-2.5 rounded-xl border p-3 text-left text-sm transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
                          checked ? "border-brand bg-brand/5" : "hover:bg-muted/50",
                        )}
                      >
                        <o.icon className={cn("mt-0.5 size-4 shrink-0", checked ? "text-brand" : "text-muted-foreground")} aria-hidden />
                        <span className="min-w-0">
                          <span className="block font-medium">{o.title}</span>
                          <span id={`appt-vis-${o.value}`} className="block text-xs text-muted-foreground">
                            {o.hint}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {!canMakePrivate && <p className="text-xs text-muted-foreground">Só quem criou pode tornar este compromisso privado.</p>}
              </div>
            )}
          />
          <Field label="Lembrete" htmlFor="appt-reminder" hint="Compartilhado: no app e no grupo do WhatsApp. Privado: só no app, para você.">
            <Controller
              control={control}
              name="reminder"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="appt-reminder">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {reminderOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="brand" loading={create.isPending || update.isPending}>
              {appointment ? "Salvar alterações" : "Marcar compromisso"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
