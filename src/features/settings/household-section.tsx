"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { REGIME_DESCRIPTIONS } from "@/lib/labels";
import { useCan } from "@/features/me/use-me";
import { NATURE_KEEPS_BALANCE, REPORT_SCOPES, REPORT_SCOPE_HINTS, REPORT_SCOPE_LABELS, REPORT_SCOPE_PASSTHROUGH_NOTE } from "@/features/transactions/nature";
import { useHousehold, useUpdateSettings } from "./use-household";

const TIMEZONES = [
  "America/Recife",
  "America/Sao_Paulo",
  "America/Fortaleza",
  "America/Bahia",
  "America/Belem",
  "America/Maceio",
  "America/Manaus",
  "America/Cuiaba",
  "America/Campo_Grande",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/Rio_Branco",
  "America/Noronha",
];

export function HouseholdSection() {
  const household = useHousehold();
  const canManage = useCan("settings:manage");
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Recife");
  const updateSettings = useUpdateSettings();

  useEffect(() => {
    if (household.data) {
      setName(household.data.name);
      setTimezone(household.data.timezone);
    }
  }, [household.data]);

  const save = useMutation({
    mutationFn: () => api.patch("/api/v1/household", { name, timezone }),
    onSuccess: () => {
      toast.success("Dados da família atualizados");
      qc.invalidateQueries({ queryKey: qk.household });
      qc.invalidateQueries({ queryKey: qk.me });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (household.isLoading || !household.data) return <Skeleton className="h-64 rounded-xl" />;
  const s = household.data.settings;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Família</CardTitle>
          <CardDescription>Nome exibido e fuso horário usado para “hoje”, vencimentos e relatórios.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Nome da família" htmlFor="hh-name">
            <Input id="hh-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} maxLength={80} />
          </Field>
          <Field label="Fuso horário" htmlFor="hh-tz">
            <Select value={timezone} onValueChange={setTimezone} disabled={!canManage}>
              <SelectTrigger id="hh-tz">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([timezone, ...TIMEZONES])].map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace("America/", "").replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Moeda">
              <Input value="Real brasileiro (BRL)" disabled />
            </Field>
            <Field label="Idioma">
              <Input value="Português (Brasil)" disabled />
            </Field>
          </div>
          {canManage && (
            <div className="flex justify-end">
              <Button variant="brand" onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
                Salvar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Regime contábil padrão</CardTitle>
          <CardDescription>Usado no dashboard, orçamentos e relatórios (pode ser alternado nos filtros).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {(["ACCRUAL", "CASH"] as const).map((r) => (
            <label key={r} className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${s.defaultRegime === r ? "border-brand/50 bg-accent/50" : "hover:bg-muted/50"}`}>
              <input
                type="radio"
                name="regime"
                className="mt-1 accent-[var(--brand)]"
                checked={s.defaultRegime === r}
                disabled={!canManage || updateSettings.isPending}
                onChange={() => updateSettings.mutate({ defaultRegime: r })}
              />
              <span>
                <span className="block font-medium">{r === "ACCRUAL" ? "Competência" : "Caixa"}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{REGIME_DESCRIPTIONS[r].replace(/^[^:]+:\s*/, "")}</span>
              </span>
            </label>
          ))}
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Recorte padrão dos relatórios</CardTitle>
          <CardDescription>
            O que o painel, os relatórios (inclusive os agendados), os orçamentos e o assistente consideram quando ninguém escolhe outro recorte. No painel dá para alternar a qualquer momento.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Recorte padrão dos relatórios">
            {REPORT_SCOPES.map((v) => (
              <label key={v} className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${s.defaultReportScope === v ? "border-brand/50 bg-accent/50" : "hover:bg-muted/50"}`}>
                <input
                  type="radio"
                  name="report-scope"
                  className="mt-1 accent-[var(--brand)]"
                  checked={s.defaultReportScope === v}
                  disabled={!canManage || updateSettings.isPending}
                  onChange={() => updateSettings.mutate({ defaultReportScope: v })}
                />
                <span>
                  <span className="block font-medium">{REPORT_SCOPE_LABELS[v]}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{REPORT_SCOPE_HINTS[v]}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Cada receita ou despesa tem uma natureza: Pessoal (padrão), Empresa ou Repasse. {REPORT_SCOPE_PASSTHROUGH_NOTE} <strong className="font-medium text-foreground/80">{NATURE_KEEPS_BALANCE}</strong>
          </p>
          {!canManage && <p className="text-xs text-muted-foreground">Só quem administra a família pode mudar o recorte padrão.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
