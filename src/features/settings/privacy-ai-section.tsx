"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, FileImage, Mic, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/features/me/use-me";
import { useHousehold, useUpdateSettings } from "./use-household";

export function PrivacyAiSection() {
  const household = useHousehold();
  const canManage = useCan("settings:manage");
  const update = useUpdateSettings();
  const [mediaDays, setMediaDays] = useState(90);
  const [transcriptDays, setTranscriptDays] = useState(365);

  useEffect(() => {
    const s = household.data?.settings;
    if (s) {
      setMediaDays(s.mediaRetentionDays);
      setTranscriptDays(s.transcriptRetentionDays);
    }
  }, [household.data]);

  if (household.isLoading || !household.data) return <Skeleton className="h-80 rounded-xl" />;
  const s = household.data.settings;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-brand" /> Autorização de uso de IA externa
          </CardTitle>
          <CardDescription>
            Sem autorização, tudo é processado pelo motor local (heurístico), sem enviar dados a terceiros. Com autorização, apenas o texto necessário e
            nomes de categorias/contas são enviados ao provedor configurado em{" "}
            <Link href="/integracoes/ia" className="font-medium text-brand hover:underline">
              Integrações → IA
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <label className="flex items-start justify-between gap-3 text-sm">
            <span className="flex gap-3">
              <Bot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">Interpretação de mensagens e assistente</span>
                <span className="block text-xs text-muted-foreground">Permite enviar o texto das mensagens e perguntas ao provedor de IA.</span>
              </span>
            </span>
            <Switch checked={s.aiExternalAllowed} disabled={!canManage || update.isPending} onCheckedChange={(v) => update.mutate({ aiExternalAllowed: v })} />
          </label>
          <label className="flex items-start justify-between gap-3 text-sm">
            <span className="flex gap-3">
              <Mic className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">Transcrição de áudios</span>
                <span className="block text-xs text-muted-foreground">Envia áudios do grupo para transcrição por serviço externo (servidores próprios na rede local não precisam desta autorização).</span>
              </span>
            </span>
            <Switch checked={s.aiAudioAllowed} disabled={!canManage || !s.aiExternalAllowed || update.isPending} onCheckedChange={(v) => update.mutate({ aiAudioAllowed: v })} />
          </label>
          <label className="flex items-start justify-between gap-3 text-sm">
            <span className="flex gap-3">
              <FileImage className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">Leitura de comprovantes</span>
                <span className="block text-xs text-muted-foreground">Envia imagens de comprovantes para extração de dados. Números de cartão nunca são armazenados.</span>
              </span>
            </span>
            <Switch checked={s.aiImageAllowed} disabled={!canManage || !s.aiExternalAllowed || update.isPending} onCheckedChange={(v) => update.mutate({ aiImageAllowed: v })} />
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Retenção de mídias</CardTitle>
          <CardDescription>Áudios e imagens originais são criptografados e apagados após o prazo. Os lançamentos e dados extraídos permanecem.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Manter áudios e comprovantes por (dias)" htmlFor="ret-media" hint="0 = apagar logo após o processamento.">
            <Input id="ret-media" type="number" min={0} max={3650} value={mediaDays} onChange={(e) => setMediaDays(Number(e.target.value))} disabled={!canManage} />
          </Field>
          <Field label="Manter transcrições por (dias)" htmlFor="ret-tr" hint="0 = não armazenar transcrições.">
            <Input id="ret-tr" type="number" min={0} max={3650} value={transcriptDays} onChange={(e) => setTranscriptDays(Number(e.target.value))} disabled={!canManage} />
          </Field>
          {canManage && (
            <div className="flex justify-end">
              <Button variant="brand" loading={update.isPending} onClick={() => update.mutate({ mediaRetentionDays: mediaDays, transcriptRetentionDays: transcriptDays })}>
                Salvar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
