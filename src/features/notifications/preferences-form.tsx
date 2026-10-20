"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, MessageCircle, MoonStar, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ErrorState } from "@/components/shared/error-state";
import { api, errorMessage } from "@/lib/client/api";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { InAppPopupsToggle } from "./popup-preference";

type Frequency = "IMMEDIATE" | "DAILY_DIGEST" | "OFF";

interface PreferenceDTO {
  type: keyof typeof NOTIFICATION_TYPE_LABELS;
  label: string;
  inApp: boolean;
  whatsapp: boolean;
  email: boolean;
  /** Notificação no celular (Web Push). Só é enviada com frequência "Imediata". */
  push: boolean;
  frequency: Frequency;
  quietStart: string | null;
  quietEnd: string | null;
}

const FREQUENCY_LABELS: Record<Frequency, string> = { IMMEDIATE: "Imediata", DAILY_DIGEST: "Resumo diário", OFF: "Desligada" };
const QUERY_KEY = ["notifications", "preferences"] as const;

/** Explicação curta dos tipos cujo nome sozinho não diz quando o aviso chega. */
const TYPE_HINTS: Partial<Record<PreferenceDTO["type"], string>> = {
  CASH_SHORTFALL: "Quando a projeção mostra o saldo das contas ficando negativo nos próximos 30 dias",
  SUBSCRIPTION_FOUND: "Cobrança que se repete todo mês e não está nos gastos fixos, ou que ficou mais cara",
};

function same(a: PreferenceDTO, b: PreferenceDTO) {
  return a.inApp === b.inApp && a.whatsapp === b.whatsapp && a.push === b.push && a.frequency === b.frequency && (a.quietStart ?? "") === (b.quietStart ?? "") && (a.quietEnd ?? "") === (b.quietEnd ?? "");
}

function quietError(p: PreferenceDTO): string | null {
  return Boolean(p.quietStart) !== Boolean(p.quietEnd) ? "Informe início e fim" : null;
}

/**
 * Preferências de notificação do membro logado: uma linha por tipo, com canais (aplicativo,
 * celular/push e WhatsApp), frequência e horário silencioso. Salva via PUT /api/v1/notifications/preferences.
 */
export function NotificationPreferencesForm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.get<PreferenceDTO[]>("/api/v1/notifications/preferences") });
  const [draft, setDraft] = useState<PreferenceDTO[] | null>(null);
  const [bulkStart, setBulkStart] = useState("22:00");
  const [bulkEnd, setBulkEnd] = useState("07:00");

  // Inicializa o rascunho com os dados do servidor (sem sobrescrever alterações não salvas).
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data);
  }, [q.data, draft]);

  const changed = useMemo(() => (draft && q.data ? draft.filter((d) => !same(d, q.data.find((o) => o.type === d.type) ?? d)) : []), [draft, q.data]);
  const invalid = (draft ?? []).some((p) => quietError(p));

  const save = useMutation({
    mutationFn: () =>
      api.put<PreferenceDTO[]>("/api/v1/notifications/preferences", {
        items: changed.map((p) => ({ type: p.type, inApp: p.inApp, whatsapp: p.whatsapp, push: p.push, frequency: p.frequency, quietStart: p.quietStart || null, quietEnd: p.quietEnd || null })),
      }),
    onSuccess: (data) => {
      qc.setQueryData(QUERY_KEY, data);
      setDraft(data);
      toast.success("Preferências de notificação salvas");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const patch = (type: PreferenceDTO["type"], values: Partial<PreferenceDTO>) => setDraft((d) => (d ? d.map((p) => (p.type === type ? { ...p, ...values } : p)) : d));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4 text-brand" aria-hidden /> Notificações
        </CardTitle>
        <CardDescription>
          Escolha o que você quer receber no aplicativo, no celular (push) e no grupo do WhatsApp. As mensagens de WhatsApp vão para o grupo da família (compartilhado) e são limitadas a 6 por hora.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <InAppPopupsToggle />
        {q.isLoading || (!draft && !q.error) ? (
          <div className="grid gap-2" aria-busy="true" aria-label="Carregando preferências">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
        ) : (
          draft && (
            <div className="grid grid-cols-1 gap-4">
              <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <MoonStar className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>Horário silencioso: notificações no celular e mensagens de WhatsApp ficam guardadas e são enviadas depois do fim do período.</span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input type="time" value={bulkStart} onChange={(e) => setBulkStart(e.target.value)} className="h-9 w-28" aria-label="Início do horário silencioso (todos)" />
                  <span className="text-sm text-muted-foreground">até</span>
                  <Input type="time" value={bulkEnd} onChange={(e) => setBulkEnd(e.target.value)} className="h-9 w-28" aria-label="Fim do horário silencioso (todos)" />
                  <Button type="button" size="sm" variant="outline" disabled={!bulkStart || !bulkEnd} onClick={() => setDraft((d) => d?.map((p) => ({ ...p, quietStart: bulkStart, quietEnd: bulkEnd })) ?? d)}>
                    Aplicar a todos
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDraft((d) => d?.map((p) => ({ ...p, quietStart: null, quietEnd: null })) ?? d)}>
                    Limpar
                  </Button>
                </div>
              </div>

              <div className="hidden grid-cols-[minmax(0,1.6fr)_4.5rem_4.5rem_5.5rem_10rem_minmax(0,1.4fr)] items-center gap-3 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground xl:grid">
                <span>Tipo</span>
                <span className="text-center">No app</span>
                <span className="text-center">Celular</span>
                <span className="text-center">WhatsApp</span>
                <span>Frequência</span>
                <span>Horário silencioso</span>
              </div>
              <ul className="grid grid-cols-1 gap-2 xl:gap-0 xl:divide-y xl:rounded-xl xl:border">
                {draft.map((p) => {
                  const off = p.frequency === "OFF";
                  // Push só sai na frequência "Imediata" (o resumo diário não vira notificação no celular).
                  const pushAvailable = p.frequency === "IMMEDIATE";
                  const err = quietError(p);
                  const label = NOTIFICATION_TYPE_LABELS[p.type] ?? p.label;
                  return (
                    <li
                      key={p.type}
                      className="grid grid-cols-1 gap-3 rounded-xl border p-3 xl:grid-cols-[minmax(0,1.6fr)_4.5rem_4.5rem_5.5rem_10rem_minmax(0,1.4fr)] xl:items-center xl:rounded-none xl:border-0 xl:px-3 xl:py-2.5"
                    >
                      <span className={cn("text-sm font-medium", off && "text-muted-foreground")}>
                        {label}
                        {TYPE_HINTS[p.type] && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{TYPE_HINTS[p.type]}</span>}
                      </span>
                      <div className="flex items-center justify-between gap-2 xl:justify-center">
                        <span className="text-xs text-muted-foreground xl:hidden">No aplicativo</span>
                        <Switch checked={p.inApp} disabled={off} onCheckedChange={(v) => patch(p.type, { inApp: v })} aria-label={`${label}: no aplicativo`} />
                      </div>
                      <div className="flex items-center justify-between gap-2 xl:justify-center">
                        <span className="flex items-center gap-1 text-xs text-muted-foreground xl:hidden">
                          <Smartphone className="size-3.5" aria-hidden /> No celular (push){!off && !pushAvailable && " — só na frequência Imediata"}
                        </span>
                        <Switch
                          checked={p.push && pushAvailable}
                          disabled={!pushAvailable}
                          onCheckedChange={(v) => patch(p.type, { push: v })}
                          aria-label={`${label}: no celular (push)${pushAvailable ? "" : ", disponível só na frequência Imediata"}`}
                          title={pushAvailable ? undefined : "Disponível só na frequência Imediata"}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 xl:justify-center">
                        <span className="flex items-center gap-1 text-xs text-muted-foreground xl:hidden">
                          <MessageCircle className="size-3.5" aria-hidden /> WhatsApp (grupo)
                        </span>
                        <Switch checked={p.whatsapp} disabled={off} onCheckedChange={(v) => patch(p.type, { whatsapp: v })} aria-label={`${label}: WhatsApp`} />
                      </div>
                      <Select value={p.frequency} onValueChange={(v) => patch(p.type, { frequency: v as Frequency })}>
                        <SelectTrigger className="h-9" aria-label={`${label}: frequência`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
                            <SelectItem key={f} value={f}>
                              {FREQUENCY_LABELS[f]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={p.quietStart ?? ""}
                            onChange={(e) => patch(p.type, { quietStart: e.target.value || null })}
                            className="h-9 min-w-0 flex-1"
                            aria-label={`${label}: início do horário silencioso`}
                            aria-invalid={Boolean(err)}
                          />
                          <span className="text-xs text-muted-foreground">até</span>
                          <Input
                            type="time"
                            value={p.quietEnd ?? ""}
                            onChange={(e) => patch(p.type, { quietEnd: e.target.value || null })}
                            className="h-9 min-w-0 flex-1"
                            aria-label={`${label}: fim do horário silencioso`}
                            aria-invalid={Boolean(err)}
                          />
                        </div>
                        {err && (
                          <p role="alert" className="mt-1 text-xs font-medium text-destructive">
                            {err}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-muted-foreground">
                “Resumo diário” agrupa as mensagens de WhatsApp do dia em uma só, enviada no início da noite; no aplicativo a notificação aparece na hora. Notificações no celular são enviadas só na frequência “Imediata” e só para aparelhos ativados acima. “Desligada” não gera notificação desse tipo para você.
              </p>
            </div>
          )
        )}
      </CardContent>
      {draft && (
        <CardFooter className="justify-end gap-2">
          {changed.length > 0 && <span className="mr-auto text-xs text-muted-foreground">{changed.length} {changed.length === 1 ? "alteração não salva" : "alterações não salvas"}</span>}
          <Button type="button" variant="outline" disabled={!changed.length || save.isPending} onClick={() => q.data && setDraft(q.data)}>
            Descartar
          </Button>
          <Button type="button" variant="brand" disabled={!changed.length || invalid} loading={save.isPending} onClick={() => save.mutate()}>
            Salvar preferências
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
