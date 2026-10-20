"use client";

import { Sun } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/shared/error-state";
import { useCan } from "@/features/me/use-me";
import { useHousehold, useUpdateSettings } from "./use-household";

const HOURS = [5, 6, 7, 8, 9, 10, 11];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

export const MORNING_SUMMARY_HELP =
  "Compromissos do dia, contas que vencem hoje, contas vencidas e gastos de ontem — no app e no grupo do WhatsApp. Compromissos privados vão só para a pessoa, no app.";

/**
 * "Resumo do dia toda manhã" (configuração da família). Usado nas Configurações → Preferências
 * e na Agenda; `idPrefix` evita ids repetidos quando aparece duas vezes na mesma tela.
 */
export function MorningSummarySettings({ idPrefix = "morning", compact = false }: { idPrefix?: string; compact?: boolean }) {
  const household = useHousehold();
  const canManage = useCan("settings:manage");
  const update = useUpdateSettings();

  const body = (() => {
    if (household.isLoading) return <Skeleton className="h-16 w-full" />;
    if (household.isError || !household.data) return <ErrorState error={household.error} compact onRetry={() => household.refetch()} />;
    const s = household.data.settings;
    const pending = update.isPending ? update.variables : undefined;
    const enabled = pending?.morningSummaryEnabled ?? s.morningSummaryEnabled ?? false;
    const hour = pending?.morningSummaryHour ?? s.morningSummaryHour ?? 7;
    const hours = HOURS.includes(hour) ? HOURS : [...HOURS, hour].sort((a, b) => a - b);
    const disabled = !canManage || update.isPending;
    return (
      <div className="grid gap-4">
        <div className="flex items-start justify-between gap-3 text-sm">
          <span className="min-w-0">
            <Label htmlFor={`${idPrefix}-summary`} className="font-medium">
              Resumo do dia toda manhã
            </Label>
            <span id={`${idPrefix}-summary-help`} className="mt-0.5 block text-xs text-muted-foreground">
              {MORNING_SUMMARY_HELP}
            </span>
          </span>
          <Switch
            id={`${idPrefix}-summary`}
            checked={enabled}
            disabled={disabled}
            aria-describedby={`${idPrefix}-summary-help`}
            onCheckedChange={(v) => update.mutate({ morningSummaryEnabled: v })}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label htmlFor={`${idPrefix}-summary-hour`} className="text-sm">
            Horário do resumo
          </Label>
          <Select value={String(hour)} disabled={disabled || !enabled} onValueChange={(v) => update.mutate({ morningSummaryHour: Number(v) })}>
            <SelectTrigger id={`${idPrefix}-summary-hour`} className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hours.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {hh(h)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!canManage && <p className="text-xs text-muted-foreground">Só quem gerencia as configurações da família pode mudar o resumo.</p>}
      </div>
    );
  })();

  return (
    <Card>
      <CardHeader className={compact ? "pb-0" : undefined}>
        <CardTitle className="flex items-center gap-2">
          <Sun className="size-4 text-warning" aria-hidden /> Resumo da manhã
        </CardTitle>
        {!compact && <CardDescription>Um aviso por dia com o que importa, no horário da família.</CardDescription>}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
