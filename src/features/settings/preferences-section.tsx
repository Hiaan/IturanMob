"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/features/me/use-me";
import { useHousehold, useUpdateSettings } from "./use-household";

export function PreferencesSection() {
  const household = useHousehold();
  const canManage = useCan("settings:manage");
  const update = useUpdateSettings();
  const [high, setHigh] = useState(85);
  const [medium, setMedium] = useState(60);
  const [thresholds, setThresholds] = useState<number[]>([]);
  const [newThreshold, setNewThreshold] = useState("");
  const [dupHours, setDupHours] = useState(48);

  useEffect(() => {
    const s = household.data?.settings;
    if (!s) return;
    setHigh(Math.round(s.confidenceHigh * 100));
    setMedium(Math.round(s.confidenceMedium * 100));
    setThresholds(s.budgetAlertThresholds);
    setDupHours(s.duplicateWindowHours);
  }, [household.data]);

  if (household.isLoading || !household.data) return <Skeleton className="h-80 rounded-xl" />;
  const s = household.data.settings;
  const invalidConfidence = medium > high;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Interpretação automática</CardTitle>
          <CardDescription>Limites de confiança usados pelo motor ao registrar mensagens.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field label={`Registro automático a partir de ${high}%`} htmlFor="conf-high" hint="Acima deste valor, o lançamento é registrado e confirmado na hora.">
            <input id="conf-high" type="range" min={50} max={100} value={high} onChange={(e) => setHigh(Number(e.target.value))} disabled={!canManage} className="accent-[var(--brand)]" />
          </Field>
          <Field
            label={`Pendente de confirmação a partir de ${medium}%`}
            htmlFor="conf-medium"
            hint="Entre os dois limites, o lançamento fica pendente até alguém confirmar. Abaixo, o sistema pede esclarecimento."
            error={invalidConfidence ? "Deve ser menor ou igual ao limite de registro automático." : undefined}
          >
            <input id="conf-medium" type="range" min={10} max={100} value={medium} onChange={(e) => setMedium(Number(e.target.value))} disabled={!canManage} className="accent-[var(--brand)]" />
          </Field>
          <Field label="Janela de suspeita de duplicidade (horas)" htmlFor="dup" hint="Lançamentos de mesmo valor e descrição parecida dentro desta janela pedem confirmação.">
            <Input id="dup" type="number" min={1} max={720} value={dupHours} onChange={(e) => setDupHours(Number(e.target.value))} disabled={!canManage} />
          </Field>
          {canManage && (
            <div className="flex justify-end">
              <Button
                variant="brand"
                disabled={invalidConfidence}
                loading={update.isPending}
                onClick={() => update.mutate({ confidenceHigh: high / 100, confidenceMedium: medium / 100, duplicateWindowHours: dupHours })}
              >
                Salvar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Alertas de orçamento</CardTitle>
            <CardDescription>Percentuais do orçamento que geram um aviso (uma vez por mês e categoria).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {thresholds.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-3 py-1 text-sm font-medium tabular">
                  {t}%
                  {canManage && (
                    <button type="button" aria-label={`Remover ${t}%`} onClick={() => setThresholds((p) => p.filter((x) => x !== t))} className="text-muted-foreground hover:text-foreground">
                      <X className="size-3.5" />
                    </button>
                  )}
                </span>
              ))}
              {!thresholds.length && <span className="text-sm text-muted-foreground">Nenhum alerta configurado.</span>}
            </div>
            {canManage && (
              <div className="flex gap-2">
                <Input type="number" min={1} max={200} placeholder="Ex.: 80" value={newThreshold} onChange={(e) => setNewThreshold(e.target.value)} className="w-32" aria-label="Novo percentual" />
                <Button
                  variant="outline"
                  onClick={() => {
                    const n = Number(newThreshold);
                    if (n >= 1 && n <= 200) setThresholds((p) => [...new Set([...p, n])].sort((a, b) => a - b));
                    setNewThreshold("");
                  }}
                >
                  Adicionar
                </Button>
                <Button variant="brand" loading={update.isPending} onClick={() => update.mutate({ budgetAlertThresholds: thresholds })}>
                  Salvar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Respostas no WhatsApp</CardTitle>
            <CardDescription>Como o assistente interage no grupo da família.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <label className="flex items-start justify-between gap-3 text-sm">
              <span>
                <span className="font-medium">Enviar confirmações e perguntas</span>
                <span className="block text-xs text-muted-foreground">Confirma lançamentos e pede esclarecimentos no grupo.</span>
              </span>
              <Switch checked={s.whatsappReplies} disabled={!canManage || update.isPending} onCheckedChange={(v) => update.mutate({ whatsappReplies: v })} />
            </label>
            <label className="flex items-start justify-between gap-3 text-sm">
              <span>
                <span className="font-medium">Responder consultas financeiras</span>
                <span className="block text-xs text-muted-foreground">Ex.: “Quanto gastamos esse mês?” respondido no próprio grupo.</span>
              </span>
              <Switch checked={s.whatsappAnswerQueries} disabled={!canManage || update.isPending} onCheckedChange={(v) => update.mutate({ whatsappAnswerQueries: v })} />
            </label>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
