"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Cpu, FileSpreadsheet, LockKeyhole, MessageCircle, ShieldCheck, Sparkles, Upload } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { AI_PROVIDER_LABELS, AI_TASK_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useWhatsAppStatus } from "@/features/whatsapp/hooks";
import { ConnectionBadge, PROVIDER_SHORT } from "@/features/whatsapp/status-meta";
import { formatPhone, timeAgo } from "@/features/whatsapp/utils";
import { GoogleCalendarCard } from "@/features/agenda/google-calendar-card";
import { OpenFinanceCard } from "./open-finance-card";

interface AIConfig {
  consent: { aiExternalAllowed: boolean; aiAudioAllowed: boolean; aiImageAllowed: boolean };
  tasks: Array<{ task: string; provider: string; enabled: boolean; effective: { provider: string; model: string; reason?: string | null } | null }>;
}

function HubCard({
  icon: Icon,
  iconClass,
  title,
  description,
  href,
  cta,
  children,
}: {
  icon: typeof MessageCircle;
  iconClass: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-2xl", iconClass)}>
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-4 flex-1">{children}</div>
      <div className="mt-5">
        <Button asChild variant="outline" className="w-full justify-between">
          <Link href={href}>
            {cta} <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  );
}

function WhatsAppCard() {
  const wa = useWhatsAppStatus();
  const d = wa.data;
  return (
    <HubCard
      icon={MessageCircle}
      iconClass="bg-positive/12 text-positive"
      title="WhatsApp"
      description="Registre gastos e consulte as finanças pelo grupo da família."
      href="/integracoes/whatsapp"
      cta="Gerenciar WhatsApp"
    >
      {wa.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : wa.isError || !d ? (
        <ErrorState error={wa.error} compact onRetry={() => wa.refetch()} />
      ) : (
        <div className="divide-y">
          <div className="flex flex-wrap items-center gap-2 pb-2">
            <ConnectionBadge status={d.status} />
            <Badge variant={d.provider === "SIMULATOR" ? "info" : d.official ? "positive" : "warning"}>{PROVIDER_SHORT[d.provider]}</Badge>
          </div>
          <Row label="Número">{d.provider === "SIMULATOR" ? "Simulação" : d.phoneNumber ? formatPhone(d.phoneNumber) : "—"}</Row>
          <Row label={d.groups.filter((g) => g.isAuthorized).length > 1 ? "Grupos autorizados" : "Chat autorizado"}>
            {d.groups.filter((g) => g.isAuthorized).map((g) => g.name).join(", ") || (d.provider === "CLOUD_API" ? "Conversas diretas" : "Nenhum")}
          </Row>
          <Row label="Mensagens (7 dias)">
            {d.stats7d.total}
            {d.stats7d.byStatus.FAILED > 0 && <span className="ml-1 text-negative">· {d.stats7d.byStatus.FAILED} com falha</span>}
          </Row>
          <Row label="Worker">
            {d.worker.online ? <span className="text-positive">Online · {timeAgo(d.worker.lastHeartbeat)}</span> : <span className="text-warning">Offline</span>}
          </Row>
        </div>
      )}
    </HubCard>
  );
}

function AICard() {
  const ai = useQuery({ queryKey: qk.ai({ view: "config" }), queryFn: () => api.get<AIConfig>("/api/v1/ai/config") });
  const d = ai.data;
  return (
    <HubCard
      icon={Sparkles}
      iconClass="bg-info/12 text-info"
      title="Inteligência artificial"
      description="Provedores usados para interpretar mensagens, ler comprovantes e responder perguntas."
      href="/integracoes/ia"
      cta="Configurar"
    >
      {ai.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : ai.isError || !d ? (
        <ErrorState error={ai.error} compact onRetry={() => ai.refetch()} />
      ) : (
        <div className="divide-y">
          <div className="pb-2">
            {d.consent.aiExternalAllowed ? (
              <Badge variant="info">
                <ShieldCheck aria-hidden /> IA externa permitida pela família
              </Badge>
            ) : (
              <Badge variant="muted">
                <LockKeyhole aria-hidden /> Somente motor local (dados não saem do servidor)
              </Badge>
            )}
          </div>
          {d.tasks.map((t) => {
            const provider = t.effective?.provider ?? t.provider;
            // Não existe transcrição nem leitura de imagem locais: sem provedor externo, essas tarefas ficam indisponíveis.
            const unavailable =
              t.task === "TRANSCRIPTION" && (!t.effective || provider === "LOCAL")
                ? "Desativada"
                : t.task === "RECEIPT_EXTRACTION" && provider === "LOCAL"
                  ? "Só a legenda da foto"
                  : null;
            return (
              <Row key={t.task} label={labelOf(AI_TASK_LABELS, t.task)}>
                {!t.enabled || unavailable ? (
                  <span className="text-muted-foreground">{unavailable ?? "Desativado"}</span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Cpu className="size-3.5 text-muted-foreground" aria-hidden />
                    {labelOf(AI_PROVIDER_LABELS, provider).replace(" (heurístico, sem IA externa)", "")}
                  </span>
                )}
              </Row>
            );
          })}
        </div>
      )}
    </HubCard>
  );
}

function ImportCard() {
  return (
    <HubCard
      icon={Upload}
      iconClass="bg-accent text-accent-foreground"
      title="Importação de extratos"
      description="Traga lançamentos de bancos e cartões a partir de arquivos CSV, OFX ou XLSX."
      href="/importacao"
      cta="Importar extratos"
    >
      <ul className="space-y-2 text-sm text-muted-foreground">
        <li className="flex items-start gap-2">
          <FileSpreadsheet className="mt-0.5 size-4 shrink-0 text-foreground/60" aria-hidden /> Pré-visualização antes de importar, com detecção de duplicados.
        </li>
        <li className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground/60" aria-hidden /> Conciliação com lançamentos já registrados pelo WhatsApp.
        </li>
        <li className="flex items-start gap-2">
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-foreground/60" aria-hidden /> Importações podem ser desfeitas.
        </li>
      </ul>
    </HubCard>
  );
}

export function IntegrationsHub() {
  return (
    <div className="space-y-6">
      <PageHeader title="Integrações" description="Conecte o Finance AI ao WhatsApp, aos seus bancos e ao Google Agenda, escolha os provedores de IA e importe extratos." />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-3">
        <WhatsAppCard />
        <AICard />
        <ImportCard />
      </div>
      <section aria-label="Bancos (Open Finance)">
        <OpenFinanceCard />
      </section>
      <section aria-label="Google Agenda">
        <GoogleCalendarCard />
      </section>
    </div>
  );
}
