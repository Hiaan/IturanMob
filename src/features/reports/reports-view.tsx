"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, Download, FileBarChart2 } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMe } from "@/features/me/use-me";
import { PassthroughCard } from "@/features/transactions/passthrough-card";
import { ScopeBar } from "@/features/transactions/scope-bar";
import { ReportGenerator } from "./report-generator";
import { ReportHistory } from "./report-history";
import { ReportViewer } from "./report-viewer";
import { SchedulesCard } from "./schedules-card";
import { ExportTransactionsCard } from "./export-transactions-card";
import { useReport, useReportList } from "./use-reports";

function ViewerSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Carregando relatório">
      <Skeleton className="h-28 rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}

const TABS = ["relatorios", "agendamentos", "exportar"] as const;
type Tab = (typeof TABS)[number];

export function ReportsView() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const timezone = me.data?.household.timezone;
  const list = useReportList();
  const [selectedId, setSelectedId] = useState<string | null>(params.get("id"));
  const tabParam = params.get("tab");
  const [tab, setTab] = useState<Tab>(TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "relatorios");
  const report = useReport(selectedId);

  // Sem seleção: abre o relatório mais recente.
  useEffect(() => {
    if (!selectedId && list.data?.length) setSelectedId(list.data[0]!.id);
  }, [selectedId, list.data]);

  const select = (id: string) => {
    setSelectedId(id);
    const sp = new URLSearchParams(params.toString());
    sp.set("id", id);
    sp.delete("tab");
    router.replace(`/relatorios?${sp.toString()}`, { scroll: false });
    if (typeof window !== "undefined" && window.innerWidth < 1280) document.getElementById("report-viewer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const changeTab = (value: string) => {
    setTab(value as Tab);
    const sp = new URLSearchParams(params.toString());
    if (value === "relatorios") sp.delete("tab");
    else sp.set("tab", value);
    router.replace(`/relatorios${sp.toString() ? `?${sp.toString()}` : ""}`, { scroll: false });
  };

  return (
    <div>
      <ScopeBar />
      <PageHeader title="Relatórios" description="Resumos semanais e mensais com comparativos, projeções e exportação em PDF, Excel e CSV." />
      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="relatorios">
            <FileBarChart2 aria-hidden /> Relatórios
          </TabsTrigger>
          <TabsTrigger value="agendamentos">
            <CalendarClock aria-hidden /> Agendamentos
          </TabsTrigger>
          <TabsTrigger value="exportar">
            <Download aria-hidden /> Exportar dados
          </TabsTrigger>
        </TabsList>

        <TabsContent value="relatorios" className="space-y-4">
          <ReportGenerator timezone={timezone} onGenerated={(r) => select(r.id)} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div id="report-viewer" className="min-w-0 scroll-mt-20 space-y-4">
              {report.data ? (
                <ReportViewer report={report.data} isFetching={report.isFetching && report.isPlaceholderData} />
              ) : report.error ? (
                <ErrorState error={report.error} onRetry={() => report.refetch()} />
              ) : report.isLoading || list.isLoading || (selectedId && !report.data) ? (
                <ViewerSkeleton />
              ) : (
                <EmptyState
                  icon={FileBarChart2}
                  title="Nenhum relatório ainda"
                  description="Escolha o mês ou a semana acima e gere o primeiro relatório. Os relatórios programados também aparecem aqui."
                />
              )}
              {/* Repasses de clientes (desconsiderados): só aparece para quem tem algum. */}
              {!report.isLoading && (
                <PassthroughCard
                  period={report.data ? report.data.data.period : null}
                  description="Repasses de clientes ficam fora das receitas e despesas deste relatório, mas continuam no saldo e na fatura."
                />
              )}
            </div>
            <div className="min-w-0 xl:sticky xl:top-[calc(4rem+var(--safe-top)+5rem)] xl:self-start">
              <ReportHistory items={list.data} isLoading={list.isLoading} error={list.error} onRetry={() => list.refetch()} selectedId={selectedId} onSelect={select} timezone={timezone} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="agendamentos">
          <SchedulesCard timezone={timezone} />
        </TabsContent>

        <TabsContent value="exportar">
          <ExportTransactionsCard timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
