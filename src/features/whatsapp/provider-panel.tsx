"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BadgeCheck, Check, CheckCircle2, CircleDot, Copy, FlaskConical, Info, ShieldAlert, Webhook, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useUpdateWhatsAppSettings } from "./hooks";
import { PROVIDER_SHORT } from "./status-meta";
import type { WaProvider, WaStatus } from "./types";

/** Aviso destacado do provedor atual (riscos do Baileys, simulador, limitações da API oficial). */
export function ProviderNotice({ status }: { status: WaStatus }) {
  if (status.provider === "BAILEYS") {
    return (
      <div role="note" className="rounded-xl border border-warning/40 bg-warning/8 p-4 sm:p-5">
        <div className="flex gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 space-y-2 text-sm">
            <p className="font-semibold text-warning">Integração NÃO oficial (Baileys) — use com cautela</p>
            <p className="text-foreground/85">
              O Baileys é uma biblioteca de código aberto que imita o WhatsApp Web. Ela <strong>não é oficial nem autorizada pela Meta</strong>. O uso pode levar ao{" "}
              <strong>bloqueio do número</strong>, e a integração pode <strong>parar de funcionar</strong> a qualquer momento após mudanças no WhatsApp.
            </p>
            <ul className="grid gap-1 text-foreground/85 sm:grid-cols-3">
              <li className="flex gap-1.5">
                <Check className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> Use um número dedicado, nunca o seu principal.
              </li>
              <li className="flex gap-1.5">
                <Check className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> Tenha o consentimento de todos no grupo.
              </li>
              <li className="flex gap-1.5">
                <Check className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> Crie um grupo exclusivo para as finanças.
              </li>
            </ul>
            <p className="text-xs text-muted-foreground">Se a família tiver um número comercial, prefira a API oficial (Cloud API).</p>
          </div>
        </div>
      </div>
    );
  }
  if (status.provider === "SIMULATOR") {
    return (
      <div role="note" className="flex gap-3 rounded-xl border border-info/30 bg-info/8 p-4 text-sm">
        <FlaskConical className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold text-info">{status.simulator?.notice ?? "Simulador — nenhuma conexão real com o WhatsApp"}</p>
          <p className="mt-0.5 text-foreground/80">
            As mensagens são criadas na aba <strong>Simulador</strong> e passam pelo mesmo processamento das mensagens reais. As respostas do bot ficam apenas registradas aqui — nada
            é enviado para ninguém.
          </p>
          {status.simulator && !status.simulator.enabled && <p className="mt-1 font-medium text-destructive">O simulador está desabilitado neste ambiente (WHATSAPP_ENABLE_SIMULATOR=false).</p>}
        </div>
      </div>
    );
  }
  return (
    <div role="note" className="flex gap-3 rounded-xl border border-positive/30 bg-positive/8 p-4 text-sm">
      <BadgeCheck className="mt-0.5 size-5 shrink-0 text-positive" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold text-positive">API oficial do WhatsApp Business (Cloud API)</p>
        <p className="mt-0.5 text-foreground/80">
          {status.cloudApi?.note ??
            "As mensagens chegam como conversas diretas com o número comercial: somente as conversas dos membros autorizados (com consentimento) são processadas."}{" "}
          Grupos não são suportados por este provedor.
        </p>
      </div>
    </div>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={value} aria-label={label} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Copiar ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            toast.error("Não foi possível copiar. Selecione e copie manualmente.");
          }
        }}
      >
        {copied ? <Check className="text-positive" /> : <Copy />}
      </Button>
    </div>
  );
}

function CheckItem({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-label="Configurado" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-negative" aria-label="Pendente" />}
      <span className={cn(!ok && "text-foreground/85")}>{children}</span>
    </li>
  );
}

function CloudApiSetup({ status, canManage }: { status: WaStatus; canManage: boolean }) {
  const cloud = status.cloudApi;
  const settings = useUpdateWhatsAppSettings();
  const [phoneNumberId, setPhoneNumberId] = useState(cloud?.phoneNumberId ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!cloud) return null;
  const save = () => {
    const v = phoneNumberId.trim();
    if (v && !/^\d{5,30}$/.test(v)) {
      setError("Informe apenas os dígitos do Phone number ID.");
      return;
    }
    setError(null);
    settings.mutate({ phoneNumberId: v || null });
  };
  return (
    <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <Webhook className="size-4 text-muted-foreground" aria-hidden />
        <p className="text-sm font-semibold">Configuração da API oficial</p>
      </div>
      <ul className="grid gap-1.5">
        <CheckItem ok={cloud.configured}>
          Token de acesso e Phone number ID (<code className="font-mono text-xs">WHATSAPP_CLOUD_ACCESS_TOKEN</code>)
        </CheckItem>
        <CheckItem ok={cloud.verifyTokenConfigured}>
          Token de verificação do webhook (<code className="font-mono text-xs">WHATSAPP_CLOUD_VERIFY_TOKEN</code>)
        </CheckItem>
        <CheckItem ok={cloud.appSecretConfigured}>
          Segredo do app para validar a assinatura (<code className="font-mono text-xs">WHATSAPP_CLOUD_APP_SECRET</code>)
        </CheckItem>
      </ul>
      <Field label="URL do webhook (cadastre no painel da Meta, campo “messages”)" htmlFor="wa-webhook">
        <CopyField value={cloud.webhookUrl} label="URL do webhook" />
      </Field>
      <Field
        label="Phone number ID"
        htmlFor="wa-phone-number-id"
        error={error ?? undefined}
        hint="Opcional: sobrescreve WHATSAPP_CLOUD_PHONE_NUMBER_ID para esta família. Os tokens ficam somente nas variáveis de ambiente do servidor."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="wa-phone-number-id"
            inputMode="numeric"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            disabled={!canManage}
            placeholder="ex.: 109876543210987"
            aria-invalid={Boolean(error)}
          />
          {canManage && (
            <Button variant="outline" onClick={save} loading={settings.isPending} className="sm:w-auto">
              Salvar
            </Button>
          )}
        </div>
      </Field>
      <p className="text-xs text-muted-foreground">
        Fora da janela de 24 horas desde a última mensagem do membro, a Meta exige modelos aprovados (templates); avisos enviados fora dessa janela podem falhar e ficam registrados.
      </p>
    </div>
  );
}

const STEPS: Record<WaProvider, string[]> = {
  SIMULATOR: [
    "Clique em Conectar (opcional: com o worker parado, a simulação é processada direto pela API).",
    "Em “Grupos autorizados”, sincronize e autorize o grupo simulado da família (e, se quiser, o da empresa).",
    "Cada participante cadastra o número em Configurações › Membros e dá o consentimento.",
    "Use a aba Simulador para enviar mensagens como um membro.",
  ],
  BAILEYS: [
    "Clique em Conectar e aguarde o QR Code.",
    "No celular do número dedicado: WhatsApp › Aparelhos conectados › Conectar aparelho.",
    "Depois de conectado, sincronize e autorize só os grupos de finanças (ex.: o da família e o da empresa).",
    "Cada participante dá o consentimento em Configurações › Membros.",
  ],
  CLOUD_API: [
    "Crie um app Business na Meta, adicione o WhatsApp e verifique o número comercial.",
    "Defina as variáveis de ambiente indicadas abaixo e reinicie o servidor e o worker.",
    "Cadastre a URL do webhook e o token de verificação no painel da Meta (campo “messages”).",
    "Clique em Conectar: o worker valida as credenciais. Membros autorizados conversam direto com o número.",
  ],
};

export function ProviderCard({ status, canManage }: { status: WaStatus; canManage: boolean }) {
  const settings = useUpdateWhatsAppSettings();
  const [target, setTarget] = useState<WaProvider | null>(null);
  const targetInfo = status.availableProviders.find((p) => p.type === target);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provedor de conexão</CardTitle>
        <CardDescription>Como o Finance AI se conecta ao WhatsApp. Só um provedor fica ativo por vez.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="radiogroup" aria-label="Provedor de conexão" className="grid gap-2">
          {status.availableProviders.map((p) => {
            const current = p.type === status.provider;
            const disabled = !canManage || !p.enabled || current || settings.isPending;
            return (
              <button
                key={p.type}
                type="button"
                role="radio"
                aria-checked={current}
                disabled={disabled}
                onClick={() => setTarget(p.type)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                  current ? "border-brand/60 bg-accent/60" : "bg-card hover:border-ring/50 disabled:hover:border-border",
                  !p.enabled && "opacity-60",
                  disabled && !current && "cursor-not-allowed",
                )}
              >
                <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2", current ? "border-brand" : "border-input")} aria-hidden>
                  {current && <CircleDot className="size-3 text-brand" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{PROVIDER_SHORT[p.type]}</span>
                    {p.type === "SIMULATOR" ? (
                      <Badge variant="info">Desenvolvimento</Badge>
                    ) : p.official ? (
                      <Badge variant="positive">Oficial</Badge>
                    ) : (
                      <Badge variant="warning">Não oficial</Badge>
                    )}
                    {current && <Badge variant="brand">Em uso</Badge>}
                  </span>
                  <span className="mt-1 block break-words text-xs text-muted-foreground">{p.description}</span>
                  {p.reason && <span className={cn("mt-1 block break-words text-xs", p.enabled ? "text-warning" : "text-destructive")}>{p.reason}</span>}
                </span>
              </button>
            );
          })}
        </div>

        <div className="rounded-xl border border-dashed p-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Info className="size-4 text-muted-foreground" aria-hidden /> Passo a passo — {PROVIDER_SHORT[status.provider]}
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground marker:text-foreground/60">
            {STEPS[status.provider].map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>

        {status.provider === "CLOUD_API" && <CloudApiSetup status={status} canManage={canManage} />}
      </CardContent>

      <AlertDialog open={Boolean(target)} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trocar para {target ? PROVIDER_SHORT[target] : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              A conexão atual será desconectada e a autorização do grupo será removida — depois de conectar, autorize novamente os grupos de finanças. As mensagens e os lançamentos
              já registrados continuam disponíveis.
              {target === "BAILEYS" && " Atenção: o Baileys não é oficial e pode levar ao bloqueio do número."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {targetInfo?.reason && <p className="text-sm text-warning">{targetInfo.reason}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (target) settings.mutate({ provider: target });
                setTarget(null);
              }}
            >
              Trocar provedor
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
