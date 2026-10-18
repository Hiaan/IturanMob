"use client";

import { BellRing, CalendarClock, CalendarDays, CalendarRange, Lock, MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ErrorState } from "@/components/shared/error-state";
import { WEEKDAY_NAMES, formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCan } from "@/features/me/use-me";
import { useHousehold } from "@/features/settings/use-household";
import { REPORT_SCOPE_LABELS } from "@/features/transactions/nature";
import { useReportSchedules, useUpdateSchedule } from "./use-reports";
import type { ReportScheduleDTO } from "./types";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

function ToggleRow({ id, icon: Icon, label, hint, checked, disabled, onChange }: { id: string; icon: typeof BellRing; label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="flex items-center gap-1.5 text-sm">
          <Icon className="size-4 text-muted-foreground" aria-hidden /> {label}
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function ScheduleItem({ s, canEdit, timezone }: { s: ReportScheduleDTO; canEdit: boolean; timezone?: string }) {
  const update = useUpdateSchedule();
  const weekly = s.type === "WEEKLY";
  const disabled = !canEdit || update.isPending;
  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) => update.mutate({ type: s.type, patch: p });
  const Icon = weekly ? CalendarRange : CalendarDays;
  return (
    <Card className={cn("p-4 sm:p-5", !s.enabled && "bg-muted/30")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <Icon className="size-4" aria-hidden />
          </span>
          <div>
            <h3 className="text-[15px] font-semibold">{weekly ? "Relatório semanal" : "Relatório mensal"}</h3>
            <p className="text-xs text-muted-foreground">{weekly ? "Semana anterior completa (segunda a domingo)." : "Mês anterior completo."}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={s.enabled ? "positive" : "muted"}>{s.enabled ? "Ativo" : "Pausado"}</Badge>
          <Switch checked={s.enabled} disabled={disabled} onCheckedChange={(v) => patch({ enabled: v })} aria-label={`${s.enabled ? "Pausar" : "Ativar"} ${weekly ? "relatório semanal" : "relatório mensal"}`} />
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {weekly ? (
          <Field label="Dia da semana" htmlFor={`${s.type}-day`}>
            <Select value={String(s.dayOfWeek ?? 1)} onValueChange={(v) => patch({ dayOfWeek: Number(v) })} disabled={disabled || !s.enabled}>
              <SelectTrigger id={`${s.type}-day`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAY_NAMES.map((name, i) => (
                  <SelectItem key={name} value={String(i)}>
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field label="Dia do mês" htmlFor={`${s.type}-day`}>
            <Select value={String(s.dayOfMonth ?? 1)} onValueChange={(v) => patch({ dayOfMonth: Number(v) })} disabled={disabled || !s.enabled}>
              <SelectTrigger id={`${s.type}-day`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_DAYS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    Dia {d}
                  </SelectItem>
                ))}
                <SelectItem value="31">Último dia do mês</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Horário" htmlFor={`${s.type}-hour`}>
          <Select value={String(s.hour)} onValueChange={(v) => patch({ hour: Number(v) })} disabled={disabled || !s.enabled}>
            <SelectTrigger id={`${s.type}-hour`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {String(h).padStart(2, "0")}:00
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <ToggleRow
          id={`${s.type}-wa`}
          icon={MessageCircle}
          label="Enviar ao WhatsApp"
          hint="Resumo curto no grupo da família."
          checked={s.sendWhatsApp}
          disabled={disabled || !s.enabled}
          onChange={(v) => patch({ sendWhatsApp: v })}
        />
        <ToggleRow
          id={`${s.type}-app`}
          icon={BellRing}
          label="Notificar no app"
          hint="Aviso quando o relatório estiver pronto."
          checked={s.notifyInApp}
          disabled={disabled || !s.enabled}
          onChange={(v) => patch({ notifyInApp: v })}
        />
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CalendarClock className="size-3.5" aria-hidden />
          Próximo: {s.enabled && s.nextRunAt ? formatDateTimeBR(s.nextRunAt, timezone) : "—"}
        </span>
        <span>Último: {s.lastRunAt ? formatDateTimeBR(s.lastRunAt, timezone) : "nunca executado"}</span>
      </p>
    </Card>
  );
}

/** Agendamentos dos relatórios semanal e mensal. */
export function SchedulesCard({ timezone }: { timezone?: string }) {
  const q = useReportSchedules();
  const canEdit = useCan("settings:manage");
  const familyScope = useHousehold().data?.settings.defaultReportScope;
  return (
    <div className="space-y-4">
      {!canEdit && (
        <p className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" aria-hidden /> Somente administradores podem alterar os agendamentos.
        </p>
      )}
      {q.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(q.data ?? []).map((s) => (
            <ScheduleItem key={s.id} s={s} canEdit={canEdit} timezone={timezone} />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Os relatórios programados usam o fuso horário da família, consideram apenas dados compartilhados (sem contas privadas) e nunca são gerados em duplicidade para o mesmo período.
        {familyScope ? ` Eles saem no recorte padrão da família (${REPORT_SCOPE_LABELS[familyScope]}), não no da barra do topo.` : ""}
      </p>
    </div>
  );
}
