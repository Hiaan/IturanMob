"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, FlaskConical, MessagesSquare, Plug } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";
import { useWhatsAppStatus } from "./hooks";
import { StatusHero } from "./status-hero";
import { ProviderCard, ProviderNotice } from "./provider-panel";
import { QrPanel } from "./qr-panel";
import { GroupsPanel } from "./groups-panel";
import { ParticipantsPanel } from "./participants-panel";
import { EventsPanel } from "./events-panel";
import { ProcessingPanel } from "./processing-panel";
import { SimulatorPanel } from "./simulator-panel";

const TABS = ["conexao", "mensagens", "simulador"] as const;
type Tab = (typeof TABS)[number];

function LoadingSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-52 rounded-xl" />
      <Skeleton className="h-20 rounded-xl" />
      <Skeleton className="h-10 w-72 rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}

export function WhatsAppView() {
  const status = useWhatsAppStatus();
  const canManage = useCan("integrations:manage");
  const timezone = useMe().data?.household.timezone;
  const params = useSearchParams();
  const router = useRouter();
  const requested = params.get("tab") as Tab | null;
  const data = status.data;
  const isSimulator = data?.provider === "SIMULATOR";
  const tab: Tab = requested && TABS.includes(requested) && (requested !== "simulador" || isSimulator) ? requested : "conexao";
  const setTab = (v: string) => router.replace(`/integracoes/whatsapp?tab=${v}`, { scroll: false });

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp"
        description="Conexão, grupo autorizado, participantes e processamento das mensagens da família."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/integracoes">
              <ArrowLeft /> Integrações
            </Link>
          </Button>
        }
      />

      {status.isLoading ? (
        <LoadingSkeleton />
      ) : status.isError || !data ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <>
          <StatusHero status={data} canManage={canManage} timezone={timezone} />
          {!(isSimulator && tab === "simulador") && <ProviderNotice status={data} />}
          {data.status === "QR_PENDING" && <QrPanel canManage={canManage} />}

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className={cn("grid w-full sm:inline-flex sm:w-auto", isSimulator ? "grid-cols-3" : "grid-cols-2")}>
              <TabsTrigger value="conexao">
                <Plug aria-hidden /> Conexão
              </TabsTrigger>
              <TabsTrigger value="mensagens">
                <MessagesSquare aria-hidden /> Mensagens
              </TabsTrigger>
              {isSimulator && (
                <TabsTrigger value="simulador">
                  <FlaskConical aria-hidden /> Simulador
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="conexao">
              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <div className="min-w-0 space-y-4">
                  <GroupsPanel status={data} canManage={canManage} timezone={timezone} />
                  <ProviderCard status={data} canManage={canManage} />
                </div>
                <div className="min-w-0 space-y-4">
                  <ParticipantsPanel status={data} timezone={timezone} />
                  <EventsPanel status={data} timezone={timezone} />
                </div>
              </div>
            </TabsContent>
            <TabsContent value="mensagens">
              <ProcessingPanel status={data} canManage={canManage} timezone={timezone} />
            </TabsContent>
            {isSimulator && (
              <TabsContent value="simulador">
                <SimulatorPanel status={data} canManage={canManage} timezone={timezone} onGoToConnection={() => setTab("conexao")} />
              </TabsContent>
            )}
          </Tabs>
        </>
      )}
    </div>
  );
}
