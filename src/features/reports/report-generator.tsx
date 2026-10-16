"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { addDays, formatDateBR, formatDayMonthBR, monthKey, startOfWeek, todayISO } from "@/lib/dates";
import { REGIME_DESCRIPTIONS } from "@/lib/labels";
import { MonthSwitcher } from "@/features/budgets/month-switcher";
import { useCan } from "@/features/me/use-me";
import { useHousehold } from "@/features/settings/use-household";
import type { ReportScope as NatureScope } from "@/features/finance/types";
import { ReportScopeSwitch } from "@/features/transactions/nature-control";
import { REPORT_SCOPE_HINTS, REPORT_SCOPE_LABELS } from "@/features/transactions/nature";
import { useGenerateReport } from "./use-reports";
import type { GenerateReportInput, ReportKind, ReportView } from "./types";

function WeekSwitcher({ weekStart, onChange, timezone }: { weekStart: string; onChange: (v: string) => void; timezone?: string }) {
  const current = startOfWeek(todayISO(timezone));
  const end = addDays(weekStart, 6);
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border bg-card p-1 shadow-xs" role="group" aria-label="Selecionar semana">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Semana anterior" onClick={() => onChange(addDays(weekStart, -7))}>
        <ChevronLeft />
      </Button>
      <span className="min-w-36 px-1 text-center text-sm font-medium tabular" aria-live="polite">
        {formatDayMonthBR(weekStart)} a {formatDateBR(end)}
      </span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Próxima semana" onClick={() => onChange(addDays(weekStart, 7))}>
        <ChevronRight />
      </Button>
      {weekStart !== current && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(current)}>
          Atual
        </Button>
      )}
    </div>
  );
}

/** Formulário para gerar um relatório semanal ou mensal. */
export function ReportGenerator({ timezone, onGenerated }: { timezone?: string; onGenerated: (report: ReportView) => void }) {
  const today = todayISO(timezone);
  const [type, setType] = useState<ReportKind>("MONTHLY");
  const [month, setMonth] = useState(monthKey(today));
  const [weekStart, setWeekStart] = useState(startOfWeek(addDays(today, -7)));
  const [scope, setScope] = useState<"AUTO" | "FAMILY" | "PERSONAL">("AUTO");
  const [regime, setRegime] = useState<"DEFAULT" | "ACCRUAL" | "CASH">("DEFAULT");
  const generate = useGenerateReport(onGenerated);
  const household = useHousehold();
  const canManage = useCan("settings:manage");
  const defaultNature = household.data?.settings.defaultReportScope ?? null;
  /** Recorte Pessoal | Empresa | Tudo escolhido aqui (ausente = padrão da família). */
  const [nature, setNature] = useState<NatureScope | null>(null);
  const natureScope = nature ?? defaultNature;

  const submit = () => {
    const input: GenerateReportInput = type === "MONTHLY" ? { type, month } : { type, periodStart: weekStart };
    if (scope !== "AUTO") input.scope = scope;
    if (regime !== "DEFAULT") input.regime = regime;
    if (nature) input.natureScope = nature;
    generate.mutate(input);
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold">Gerar relatório</h2>
            <p className="text-xs text-muted-foreground">Receitas, despesas, categorias, orçamento, metas e projeções do período.</p>
          </div>
          <Tabs value={type} onValueChange={(v) => setType(v as ReportKind)}>
            <TabsList aria-label="Tipo de relatório">
              <TabsTrigger value="MONTHLY">
                <CalendarDays aria-hidden /> Mensal
              </TabsTrigger>
              <TabsTrigger value="WEEKLY">
                <CalendarRange aria-hidden /> Semanal
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <Field label={type === "MONTHLY" ? "Mês" : "Semana (segunda a domingo)"}>
            {type === "MONTHLY" ? <MonthSwitcher month={month} onChange={setMonth} timezone={timezone} /> : <WeekSwitcher weekStart={weekStart} onChange={setWeekStart} timezone={timezone} />}
          </Field>
          <Field label="Escopo" htmlFor="report-scope">
            <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
              <SelectTrigger id="report-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">Automático</SelectItem>
                <SelectItem value="FAMILY">Família (compartilhado)</SelectItem>
                <SelectItem value="PERSONAL">Pessoal (só para mim)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Regime" htmlFor="report-regime">
            <Select value={regime} onValueChange={(v) => setRegime(v as typeof regime)}>
              <SelectTrigger id="report-regime" title={regime === "DEFAULT" ? undefined : REGIME_DESCRIPTIONS[regime]}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DEFAULT">Padrão da família</SelectItem>
                <SelectItem value="ACCRUAL">Competência (data da compra)</SelectItem>
                <SelectItem value="CASH">Caixa (data do pagamento)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Button variant="brand" onClick={submit} loading={generate.isPending} className="sm:col-span-2 lg:col-span-1">
            <Sparkles /> Gerar relatório
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {scope === "PERSONAL"
            ? "Relatório pessoal: inclui suas contas e cartões privados e fica visível somente para você."
            : scope === "FAMILY"
              ? "Relatório da família: visível para todos os membros e sem contas ou cartões privados."
              : "Automático: relatório da família; se você tiver contas privadas, ele será pessoal (visível só para você)."}{" "}
          {regime === "DEFAULT" ? "Regime: o configurado para a família." : REGIME_DESCRIPTIONS[regime]}
        </p>
        {natureScope && (
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:gap-3">
            <p className="text-[13px] font-medium" aria-hidden>
              Recorte
            </p>
            <ReportScopeSwitch value={natureScope} defaultScope={defaultNature} onChange={setNature} className="w-fit" />
            <p className="text-xs text-muted-foreground">
              {REPORT_SCOPE_HINTS[natureScope]}
              {defaultNature === natureScope ? " (padrão da família)" : ""}
              {natureScope !== "BUSINESS" && " No relatório mensal, o resultado da empresa aparece à parte."} Repasses de clientes ficam sempre de fora.{" "}
              {canManage ? (
                <Link href="/configuracoes?tab=familia" className="font-medium text-brand hover:underline">
                  Alterar o padrão{defaultNature ? ` (${REPORT_SCOPE_LABELS[defaultNature]})` : ""}
                </Link>
              ) : null}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
