"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Ban, MessageCircle, Plus, Sparkles, XCircle } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTimeBR } from "@/lib/dates";
import { useMe } from "@/features/me/use-me";
import { FormatTile, formatLabel } from "@/features/imports/status";
import { Stepper, type StepDef } from "@/features/imports/stepper";
import type { MigrationDTO, MigrationStatus } from "@/server/modules/migration/types";
import { ColumnsStep } from "./columns-step";
import { DiscardMigrationButton } from "./confirm-dialogs";
import { CorrespondencesStep } from "./correspondences-step";
import { DoneStep } from "./done-step";
import { UploadCard } from "./file-step";
import { MigrationHistory } from "./migration-history";
import { PreviewStep } from "./preview-step";
import { SheetsStep } from "./sheets-step";
import { Banner, MigrationStatusBadge, ProgressPanel } from "./status";
import { TemplatesSection } from "./templates-section";
import { migrationKeys, useInvalidateMigrationFinance, useMigration } from "./use-migration";

type StepId = "file" | "sheets" | "columns" | "correspondences" | "preview" | "done";
type EditStep = Extract<StepId, "sheets" | "columns" | "correspondences">;

const STEPS: StepDef[] = [
  { id: "file", label: "Arquivo" },
  { id: "sheets", label: "Abas" },
  { id: "columns", label: "Colunas" },
  { id: "correspondences", label: "Correspondências" },
  { id: "preview", label: "Prévia" },
  { id: "done", label: "Concluído" },
];

function stepOf(status: MigrationStatus, editStep: EditStep): StepId {
  switch (status) {
    case "READING":
    case "FAILED":
    case "DISCARDED":
      return "file";
    case "READY":
      return editStep;
    case "PREVIEWING":
    case "PREVIEW":
      return "preview";
    case "COMMITTING":
    case "IMPORTED":
    case "UNDONE":
      return "done";
  }
}

const scrollTop = () => {
  if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
};

/** Avisos das mudanças de situação que acontecem no servidor (leitura, prévia e gravação terminadas). */
function useStatusTransitions(m: MigrationDTO) {
  const qc = useQueryClient();
  const invalidate = useInvalidateMigrationFinance();
  const prev = useRef<{ id: string; status: MigrationStatus } | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = { id: m.id, status: m.status };
    if (!p || p.id !== m.id || p.status === m.status) return;
    qc.invalidateQueries({ queryKey: migrationKeys.list, exact: true });
    if (m.status === "READY" && p.status === "READING") {
      const selected = m.sheets.filter((s) => s.selected).length;
      toast.success("Planilha lida", { description: `${m.sheets.length} aba(s) encontrada(s), ${selected} selecionada(s) para importar.` });
    } else if (m.status === "PREVIEW" && p.status === "PREVIEWING") {
      toast.success("Prévia pronta", { description: m.summary ? `${m.summary.totals.selected} lançamento(s) para conferir.` : undefined });
    } else if (m.status === "IMPORTED") {
      invalidate();
      qc.invalidateQueries({ queryKey: migrationKeys.templates });
      toast.success("Migração concluída", { description: m.result ? `${m.result.created} lançamento(s) criado(s) · ${m.result.matched} já existiam.` : undefined });
    } else if (m.status === "FAILED") {
      toast.error("A migração falhou", { description: m.error ?? undefined });
    } else if (m.status === "READY" && p.status === "PREVIEWING") {
      toast.error("Não foi possível gerar a prévia", { description: m.error ?? "Confira as abas e as correspondências e tente de novo." });
    } else if (m.status === "PREVIEW" && p.status === "COMMITTING") {
      toast.error("A importação não foi concluída", { description: m.error ?? "Nada foi gravado. Tente de novo." });
    }
    if (m.status !== "READY" && m.status !== "PREVIEW") scrollTop();
  }, [m, qc, invalidate]);
}

function MigrationHeader({ migration: m, timezone }: { migration: MigrationDTO; timezone?: string }) {
  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <FormatTile format={m.format} className="size-10 rounded-xl" />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{m.fileName}</span>
            <Badge variant="outline">{formatLabel(m.format)}</Badge>
            <MigrationStatusBadge status={m.status} />
            {m.origin === "WHATSAPP" && (
              <Badge variant="muted">
                <MessageCircle aria-hidden /> via WhatsApp
              </Badge>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Enviada em {formatDateTimeBR(m.createdAt, timezone)}
            {m.sheets.length ? ` · ${m.sheets.length} aba(s)` : ""}
          </p>
        </div>
      </div>
      {/* Na prévia, "Descartar" fica junto de "Importar tudo". */}
      {m.status === "READY" && <DiscardMigrationButton migration={m} variant="outline" className="self-start sm:self-auto" />}
    </Card>
  );
}

function MigrationFlow({ migration: m, timezone, onReset, onOpen }: { migration: MigrationDTO; timezone?: string; onReset: () => void; onOpen: (id: string) => void }) {
  const [editStep, setEditStep] = useState<EditStep>("sheets");
  useStatusTransitions(m);
  const step = stepOf(m.status, editStep);
  const go = (s: EditStep) => {
    setEditStep(s);
    scrollTop();
  };

  if (m.status === "DISCARDED") {
    return (
      <div className="space-y-4">
        <MigrationHeader migration={m} timezone={timezone} />
        <Banner tone="muted" icon={Ban} title="Migração descartada">
          Nenhum lançamento foi gravado a partir desta planilha. Para migrar, envie a planilha de novo.
        </Banner>
        <UploadCard onUploaded={(dto) => onOpen(dto.id)} title="Enviar outra planilha" />
      </div>
    );
  }

  return (
    <>
      <Stepper steps={STEPS} current={step} label="Etapas da migração" />
      <div className="space-y-4">
        <MigrationHeader migration={m} timezone={timezone} />

        {m.template && (m.status === "READY" || m.status === "READING") && (
          <Banner
            tone="info"
            icon={Sparkles}
            title={`Formato reconhecido: ${m.template.name}`}
            action={
              m.status === "READY" && step !== "correspondences" ? (
                <Button variant="outline" size="sm" onClick={() => go("correspondences")}>
                  Ir para as correspondências <ArrowRight aria-hidden />
                </Button>
              ) : undefined
            }
          >
            Abas, colunas e correspondências já preenchidas; só perguntamos o que for novo.
          </Banner>
        )}

        {m.status === "READING" && (
          <ProgressPanel
            title="Lendo a planilha…"
            progress={m.progress}
            label={m.progressLabel}
            hint="O app identifica as abas, as colunas e os nomes de categorias, contas e cartões. Você pode sair desta tela e voltar por “Migrações anteriores”."
          />
        )}

        {m.status === "FAILED" && (
          <>
            <Banner tone="negative" icon={XCircle} title="Não foi possível ler esta planilha">
              {m.error ?? "Erro inesperado na leitura."} Confira se o arquivo abre normalmente, salve de novo (de preferência em .xlsx) e envie outra vez.
            </Banner>
            <UploadCard onUploaded={(dto) => onOpen(dto.id)} title="Tentar de novo com outro arquivo" />
          </>
        )}

        {m.status === "READY" && step === "sheets" && <SheetsStep migration={m} onNext={() => go("columns")} />}
        {m.status === "READY" && step === "columns" && <ColumnsStep migration={m} onBack={() => go("sheets")} onNext={() => go("correspondences")} />}
        {m.status === "READY" && step === "correspondences" && <CorrespondencesStep migration={m} onBack={() => go("columns")} />}
        {(m.status === "PREVIEWING" || m.status === "PREVIEW") && <PreviewStep migration={m} onBack={() => go("correspondences")} />}
        {(m.status === "COMMITTING" || m.status === "IMPORTED" || m.status === "UNDONE") && <DoneStep migration={m} timezone={timezone} onNewMigration={onReset} />}
      </div>
    </>
  );
}

/** Assistente "Migrar de planilha" (/importacao/migrar, com ?id= para retomar — o link do WhatsApp aponta para cá). */
export function MigrationWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const me = useMe();
  const timezone = me.data?.household.timezone;
  const q = useMigration(id);

  const open = (next: string | null) => {
    router.replace(next ? `/importacao/migrar?id=${encodeURIComponent(next)}` : "/importacao/migrar", { scroll: false });
    scrollTop();
  };

  return (
    <div className="pb-4">
      <PageHeader
        title="Migrar de planilha"
        description="Traga os seus controles de uma planilha (Excel, OpenDocument ou CSV): o app interpreta abas, colunas e categorias, você confirma o “De → Para”, confere a prévia e importa. Dá para desfazer tudo depois."
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href="/importacao">
                <ArrowLeft aria-hidden /> Importação
              </Link>
            </Button>
            {id && (
              <Button variant="outline" onClick={() => open(null)}>
                <Plus aria-hidden /> Nova migração
              </Button>
            )}
          </>
        }
      />

      {!id ? (
        <>
          <Stepper steps={STEPS} current="file" label="Etapas da migração" />
          <UploadCard onUploaded={(dto) => open(dto.id)} />
        </>
      ) : q.isLoading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Carregando migração">
          <Skeleton className="h-8 w-full max-w-xl rounded-lg" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !q.data ? (
        <div className="space-y-4">
          <ErrorState error={q.error ?? new Error("Migração não encontrada.")} onRetry={() => q.refetch()} />
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => open(null)}>
              <Plus aria-hidden /> Começar uma nova migração
            </Button>
          </div>
        </div>
      ) : (
        <MigrationFlow key={q.data.id} migration={q.data} timezone={timezone} onReset={() => open(null)} onOpen={(next) => open(next)} />
      )}

      <div className="mt-8 space-y-4">
        <MigrationHistory activeId={id} onOpen={(next) => open(next)} timezone={timezone} />
        {!id && <TemplatesSection timezone={timezone} />}
      </div>
    </div>
  );
}
