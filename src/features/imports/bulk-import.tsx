"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Clock,
  Columns3,
  Copy,
  CreditCard,
  FileCheck2,
  FileSearch,
  Info,
  Landmark,
  Layers,
  Link2,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
  Upload,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { errorMessage } from "@/lib/client/api";
import { formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useAccounts, useCards } from "@/features/finance/hooks";
import { canRetryBulkItem, clearBulkSession, isBulkUploading, recordBulkResults, removeBulkItem, retryBulkItem, type BulkItem, type BulkSession } from "./bulk-store";
import { bankLabel, commonWarnings, formatFileSize, formatFromFileName, isTransferWarning, isUnresolvedTransfer, needsCounterpartAmount, needsMappingReview, needsScopeReview, statementKindLabel } from "./helpers";
import { FormatTile, ROW_STATUS, formatLabel } from "./status";
import { Stepper } from "./stepper";
import { useBulkCommit, useImportPreviews } from "./use-imports";
import { Warnings } from "./warnings";
import type { BulkCommitFileResult, ImportPreview, ImportRowStatus } from "./types";

type Variant = "info" | "positive" | "warning" | "muted" | "negative" | "brand";
type ItemState = "queued" | "uploading" | "error" | "loading" | "load-error" | "ready" | "mapping" | "scope" | "imported" | "undone" | "failed";

const STATE_META: Record<ItemState, { label: string; icon: LucideIcon; variant: Variant; spin?: boolean }> = {
  queued: { label: "Na fila", icon: Clock, variant: "muted" },
  uploading: { label: "Enviando…", icon: LoaderCircle, variant: "info", spin: true },
  loading: { label: "Carregando prévia…", icon: LoaderCircle, variant: "muted", spin: true },
  "load-error": { label: "Erro ao carregar", icon: XCircle, variant: "negative" },
  error: { label: "Erro", icon: XCircle, variant: "negative" },
  ready: { label: "Prévia pronta", icon: FileCheck2, variant: "info" },
  mapping: { label: "Precisa revisar o mapeamento", icon: Columns3, variant: "warning" },
  scope: { label: "Confira o destino", icon: AlertTriangle, variant: "warning" },
  imported: { label: "Importado", icon: CheckCircle2, variant: "positive" },
  undone: { label: "Desfeito", icon: Undo2, variant: "muted" },
  failed: { label: "Falhou", icon: XCircle, variant: "negative" },
};

interface ItemView {
  item: BulkItem;
  state: ItemState;
  preview: ImportPreview | null;
  result: BulkCommitFileResult | null;
  query: UseQueryResult<ImportPreview> | null;
}

interface Stats {
  newRows: number;
  selectedNew: number;
  selectedMatched: number;
  selectedDivergent: number;
  matched: number;
  divergent: number;
  duplicate: number;
  skipped: number;
  error: number;
  /** Transferências entre contas próprias (com a conta do outro lado) que entram na importação. */
  transfers: number;
  /** Parecem aplicação/resgate, mas sem a conta do outro lado: ficam de fora até escolher. */
  unresolvedTransfers: number;
  /** Remessa/câmbio entre moedas sem o valor na outra moeda: fica de fora até informar. */
  awaitingAmount: number;
}

const EMPTY_STATS: Stats = { newRows: 0, selectedNew: 0, selectedMatched: 0, selectedDivergent: 0, matched: 0, divergent: 0, duplicate: 0, skipped: 0, error: 0, transfers: 0, unresolvedTransfers: 0, awaitingAmount: 0 };

function statsOf(p: ImportPreview): Stats {
  const s = { ...EMPTY_STATS, newRows: p.counts.NEW, matched: p.counts.MATCHED, divergent: p.counts.DIVERGENT, duplicate: p.counts.DUPLICATE, skipped: p.counts.SKIPPED, error: p.counts.ERROR };
  for (const r of p.rows) {
    if (r.status === "NEW" && isUnresolvedTransfer(r)) s.unresolvedTransfers++;
    if (needsCounterpartAmount(r)) s.awaitingAmount++;
    if (!r.selected) continue;
    if (r.kind === "TRANSFER" && r.transfer?.accountId && (r.status === "NEW" || r.status === "MATCHED")) s.transfers++;
    if (r.status === "NEW") s.selectedNew++;
    else if (r.status === "MATCHED") s.selectedMatched++;
    else if (r.status === "DIVERGENT") s.selectedDivergent++;
  }
  return s;
}

function sumStats(list: Stats[]): Stats {
  return list.reduce<Stats>((acc, s) => {
    for (const k of Object.keys(acc) as Array<keyof Stats>) acc[k] += s[k];
    return acc;
  }, { ...EMPTY_STATS });
}

function deriveView(item: BulkItem, query: UseQueryResult<ImportPreview> | null, result: BulkCommitFileResult | null): ItemView {
  const base = { item, result, query, preview: query?.data ?? null };
  if (item.phase === "queued") return { ...base, state: "queued" };
  if (item.phase === "uploading") return { ...base, state: "uploading" };
  if (item.phase === "error" || !item.batchId) return { ...base, state: "error" };
  const p = query?.data;
  if (!p) return { ...base, state: query?.isError ? "load-error" : "loading" };
  if (result?.ok || p.batch.status === "IMPORTED") return { ...base, state: "imported" };
  if (p.batch.status === "UNDONE") return { ...base, state: "undone" };
  if (p.batch.status === "FAILED") return { ...base, state: "failed" };
  if (needsMappingReview(p)) return { ...base, state: "mapping" };
  return { ...base, state: needsScopeReview(p) ? "scope" : "ready" };
}

function StateBadge({ state }: { state: ItemState }) {
  const meta = STATE_META[state];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon aria-hidden className={cn(meta.spin && "animate-spin")} /> {meta.label}
    </Badge>
  );
}

const STAT_FIELDS: Array<{ key: keyof Stats; status: ImportRowStatus; label: string; always: boolean }> = [
  { key: "newRows", status: "NEW", label: "Novos", always: true },
  { key: "matched", status: "MATCHED", label: "Já registrados", always: true },
  { key: "divergent", status: "DIVERGENT", label: "Divergências", always: true },
  { key: "duplicate", status: "DUPLICATE", label: "Duplicados", always: true },
  { key: "skipped", status: "SKIPPED", label: "Ignorados", always: true },
  { key: "error", status: "ERROR", label: "Com erro", always: false },
];

function StatGrid({ stats, className }: { stats: Stats; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-3 gap-1.5 sm:grid-cols-6", className)}>
      {STAT_FIELDS.filter((f) => f.always || stats[f.key] > 0).map((f) => {
        const Icon = ROW_STATUS[f.status].icon;
        return (
          <div key={f.key} className="min-w-0 rounded-lg bg-muted/50 px-2 py-1.5" title={ROW_STATUS[f.status].help}>
            <dt className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Icon className="size-3 shrink-0" aria-hidden /> <span className="truncate">{f.label}</span>
            </dt>
            <dd className="text-sm font-semibold tabular">
              {stats[f.key]}
              {f.key === "newRows" && stats.selectedNew !== stats.newRows && <span className="ml-1 text-[11px] font-normal text-muted-foreground">({stats.selectedNew} selec.)</span>}
            </dd>
          </div>
        );
      })}
      {(stats.transfers > 0 || stats.unresolvedTransfers > 0) && (
        <div className="min-w-0 rounded-lg bg-muted/50 px-2 py-1.5" title="Aplicações, resgates e transferências entre contas próprias: não contam como receita nem despesa">
          <dt className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <ArrowLeftRight className="size-3 shrink-0" aria-hidden /> <span className="truncate">Transferências</span>
          </dt>
          <dd className="text-sm font-semibold tabular">
            {stats.transfers}
            {stats.unresolvedTransfers > 0 && <span className="ml-1 text-[11px] font-normal text-warning">(+{stats.unresolvedTransfers} sem conta)</span>}
          </dd>
        </div>
      )}
    </dl>
  );
}

function ResultLine({ result }: { result: BulkCommitFileResult }) {
  if (!result.ok)
    return (
      <p className="flex items-start gap-1.5 text-sm text-destructive">
        <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="min-w-0 break-words">Não foi importado: {result.error ?? "erro inesperado."}</span>
      </p>
    );
  if (result.alreadyImported)
    return (
      <p className="flex items-center gap-1.5 text-sm">
        <CheckCircle2 className="size-4 shrink-0 text-positive" aria-hidden /> Já tinha sido importado antes — nada foi gravado de novo.
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
      <CheckCircle2 className="size-4 shrink-0 text-positive" aria-hidden />
      <span className="font-medium tabular">{result.created} criado(s)</span>
      <span className="text-muted-foreground tabular">· {result.matched} vinculado(s)</span>
      <span className="text-muted-foreground tabular">· {result.divergent} divergência(s)</span>
      <span className={cn("tabular", result.duplicatesAtCommit ? "text-foreground" : "text-muted-foreground")}>· {result.duplicatesAtCommit} duplicado(s) evitado(s) na confirmação</span>
      {result.errors > 0 && <span className="text-destructive tabular">· {result.errors} com erro</span>}
    </p>
  );
}

function ItemRow({ view, hiddenWarnings }: { view: ItemView; hiddenWarnings: string[] }) {
  const qc = useQueryClient();
  const { item, state, preview, result, query } = view;
  const b = preview?.batch;
  const format = b?.format ?? formatFromFileName(item.name);
  const kind = statementKindLabel(b?.statement);
  const bank = b ? bankLabel(b) : null;
  const DestIcon = b?.creditCard ? CreditCard : Landmark;
  const warnings = (b?.warnings ?? []).filter((w) => !hiddenWarnings.includes(w) && !isTransferWarning(w));
  const mappingWarnings = state === "mapping" ? warnings.filter((w) => /mapeamento/i.test(w)) : [];
  // O aviso de destino incompatível (warnings[0]) aparece em destaque, fora da lista.
  const scopeWarning = b?.scopeMismatch && b.status === "PREVIEW" ? (b.warnings[0] ?? null) : null;
  const otherWarnings = warnings.filter((w) => !mappingWarnings.includes(w) && w !== scopeWarning);
  const href = item.batchId ? `/importacao?batch=${item.batchId}` : null;
  const reviewLabel = state === "mapping" ? "Ajustar mapeamento" : state === "ready" || state === "scope" ? "Revisar" : "Ver conciliação";
  const ReviewIcon = state === "mapping" ? Columns3 : FileSearch;
  const unresolvedTransfers = preview && preview.batch.status === "PREVIEW" ? preview.rows.filter((r) => r.status === "NEW" && isUnresolvedTransfer(r)).length : 0;
  const awaitingAmount = preview && preview.batch.status === "PREVIEW" ? preview.rows.filter(needsCounterpartAmount).length : 0;

  return (
    <li className="p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <FormatTile format={format} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 max-w-full truncate text-sm font-medium" title={item.name}>
                  {item.name}
                </span>
                <StateBadge state={state} />
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                <span className="tabular">{formatFileSize(item.size)}</span>
                {format && <span>· {formatLabel(format)}</span>}
                {b?.statement?.source === "AI" && (
                  <span className="inline-flex items-center gap-1 font-medium text-info">
                    · <Sparkles className="size-3" aria-hidden /> lido por IA
                  </span>
                )}
                {b && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    · <DestIcon className="size-3 shrink-0" aria-hidden /> <span className="truncate">{b.account?.name ?? b.creditCard?.name ?? "Sem conta ou cartão"}</span>
                  </span>
                )}
                {kind && <span>· {kind}</span>}
                {bank && <span>· {bank}</span>}
                {b?.statement?.startDate && b.statement.endDate && (
                  <span className="tabular">
                    · {formatDateBR(b.statement.startDate)} a {formatDateBR(b.statement.endDate)}
                  </span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {href && preview && (
                <Link href={href} className={buttonVariants({ variant: state === "mapping" || state === "scope" ? "secondary" : "outline", size: "sm" })}>
                  <ReviewIcon aria-hidden /> {reviewLabel}
                </Link>
              )}
              {state === "load-error" && query && (
                <Button variant="outline" size="sm" onClick={() => query.refetch()}>
                  <RotateCcw /> Tentar de novo
                </Button>
              )}
              {state === "error" && canRetryBulkItem(item) && (
                <Button variant="outline" size="sm" onClick={() => retryBulkItem(qc, item.key)}>
                  <RotateCcw /> Tentar de novo
                </Button>
              )}
              {(state === "queued" || state === "error" || state === "ready" || state === "mapping" || state === "scope" || state === "load-error") && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeBulkItem(item.key)}
                  aria-label={state === "queued" || state === "error" ? `Remover ${item.name} do lote` : `Tirar ${item.name} do lote (a prévia continua no histórico)`}
                  title={state === "queued" || state === "error" ? "Remover do lote" : "Tirar do lote (a prévia continua no histórico)"}
                >
                  <X />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="min-w-0 sm:pl-12">
        {state === "error" && item.error && (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="min-w-0 break-words">{item.error}</span>
          </p>
        )}
        {state === "load-error" && <p className="mt-2 text-sm text-destructive">{errorMessage(query?.error)}</p>}
        {state === "loading" && <Skeleton className="mt-2 h-12 rounded-lg" />}
        {state === "mapping" && (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs">
            <Columns3 className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 space-y-0.5 break-words">
              {(mappingWarnings.length ? mappingWarnings : ["As colunas de data e valor não foram identificadas automaticamente."]).map((w) => (
                <p key={w}>{w}</p>
              ))}
              <p className="font-medium">Este arquivo fica fora do “Confirmar todos” até você ajustar o mapeamento.</p>
            </div>
          </div>
        )}

        {scopeWarning && (
          <div role="note" className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 space-y-0.5 break-words">
              <p className="font-medium text-foreground">{scopeWarning}</p>
              <p>
                {state === "scope"
                  ? "Nenhuma linha veio selecionada, então este arquivo fica fora do “Confirmar todos”. Abra em “Revisar” e selecione as linhas, ou tire do lote e envie de novo com o destino certo."
                  : "Você selecionou linhas deste arquivo: elas entram no “Confirmar todos”. Confira os sinais antes."}
              </p>
            </div>
          </div>
        )}
        {preview && (state === "ready" || state === "scope") && unresolvedTransfers > 0 && (
          <div role="note" className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs">
            <ArrowLeftRight className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 break-words">
              {unresolvedTransfers} linha(s) parecem aplicação/resgate ou transferência entre contas próprias, mas falta a conta do outro lado: ficam fora da importação até você escolher a
              conta em “Revisar”.
            </p>
          </div>
        )}
        {preview && (state === "ready" || state === "scope") && awaitingAmount > 0 && (
          <div role="note" className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs">
            <ArrowLeftRight className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 break-words">
              {awaitingAmount} remessa(s)/câmbio(s) entre contas de moedas diferentes ficam fora da importação até você informar o valor na outra moeda em “Revisar”.
            </p>
          </div>
        )}
        {preview && (state === "ready" || state === "scope" || state === "failed") && <StatGrid stats={statsOf(preview)} className="mt-2" />}
        {result && (
          <div className="mt-2">
            <ResultLine result={result} />
          </div>
        )}
        {!result && preview && state === "imported" && (
          <p className="mt-2 flex items-center gap-1.5 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-positive" aria-hidden /> Importado na revisão do arquivo: {preview.batch.importedRows} criado(s) · {preview.batch.matchedRows} vinculado(s)
            {preview.batch.duplicatesAtCommit ? ` · ${preview.batch.duplicatesAtCommit} duplicado(s) evitado(s) na confirmação` : ""}.
          </p>
        )}
        {preview && state !== "imported" && state !== "undone" && otherWarnings.length > 0 && <Warnings warnings={otherWarnings} compact className="mt-2" />}
      </div>
    </li>
  );
}

function TotalTile({ icon: Icon, label, value, hint, tone }: { icon: LucideIcon; label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "positive" | "warning" | "negative" }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-3 shadow-card">
      <p className="flex min-w-0 items-start gap-1.5 text-xs leading-tight text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden /> <span className="min-w-0 break-words">{label}</span>
      </p>
      <p className={cn("mt-1 text-lg font-semibold tabular sm:text-xl", tone === "positive" && "text-positive", tone === "warning" && "text-warning", tone === "negative" && "text-destructive")}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Lote com vários arquivos: envio sequencial, resumo por arquivo, totais e confirmação em conjunto. */
export function BulkImport({ session }: { session: BulkSession }) {
  const accounts = useAccounts();
  const cards = useCards();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const batchIds = session.items.flatMap((i) => (i.batchId ? [i.batchId] : []));
  const queries = useImportPreviews(batchIds);
  const queryById = new Map(batchIds.map((id, i) => [id, queries[i]]));
  const commit = useBulkCommit((data) => {
    recordBulkResults(data.results);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  const views = session.items.map((item) => deriveView(item, item.batchId ? (queryById.get(item.batchId) ?? null) : null, item.batchId ? (session.results[item.batchId] ?? null) : null));
  const uploading = isBulkUploading(session);
  const total = views.length;
  const processed = views.filter((v) => v.item.phase === "uploaded" || v.item.phase === "error").length;
  const current = views.find((v) => v.state === "uploading");
  const ready = views.filter((v) => v.state === "ready");
  const mapping = views.filter((v) => v.state === "mapping");
  const scope = views.filter((v) => v.state === "scope");
  const failedUploads = views.filter((v) => v.state === "error" || v.state === "load-error");
  const results = views.flatMap((v) => (v.result ? [v.result] : []));
  const readyStats = sumStats(ready.map((v) => statsOf(v.preview!)));
  const shared = commonWarnings(
    views.filter((v) => v.preview && (v.state === "ready" || v.state === "mapping" || v.state === "scope")).map((v) => v.preview!.batch.warnings.filter((w, i) => !(i === 0 && v.preview!.batch.scopeMismatch))),
  );

  const [destKind, destId] = (session.opts.accountId ? `acc:${session.opts.accountId}` : session.opts.creditCardId ? `card:${session.opts.creditCardId}` : "none:").split(":");
  const destName =
    destKind === "acc"
      ? (accounts.data?.find((a) => a.id === destId)?.name ?? "Conta selecionada")
      : destKind === "card"
        ? (cards.data?.find((c) => c.id === destId)?.name ?? "Cartão selecionado")
        : "nenhum escolhido (PDFs usam o banco identificado; os demais não alteram saldos)";
  const DestIcon = destKind === "card" ? CreditCard : Landmark;

  const imported = views.filter((v) => v.state === "imported").length;
  const summaryParts = [
    ready.length || !imported ? `${ready.length} prévia(s) pronta(s)` : null,
    imported ? `${imported} importado(s)` : null,
    mapping.length ? `${mapping.length} precisa(m) revisar o mapeamento` : null,
    scope.length ? `${scope.length} com destino a conferir` : null,
    failedUploads.length ? `${failedUploads.length} com erro` : null,
  ].filter(Boolean);
  const progressText = uploading
    ? `Enviando ${Math.min(processed + 1, total)} de ${total}${current ? `: ${current.item.name}` : ""}…`
    : `${processed} de ${total} arquivo(s) processado(s): ${summaryParts.join(", ")}.`;

  const resultTotals = results.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      matched: acc.matched + r.matched,
      divergent: acc.divergent + r.divergent,
      duplicatesAtCommit: acc.duplicatesAtCommit + r.duplicatesAtCommit,
      errors: acc.errors + r.errors,
      ok: acc.ok + (r.ok ? 1 : 0),
    }),
    { created: 0, matched: 0, divergent: 0, duplicatesAtCommit: 0, errors: 0, ok: 0 },
  );
  const step = uploading ? "upload" : !ready.length && !mapping.length && !scope.length && results.length ? "reconcile" : "review";

  if (!total) {
    return (
      <EmptyState
        icon={Layers}
        title="Nenhum arquivo no lote"
        description="Todos os arquivos foram retirados. As prévias já criadas continuam no histórico abaixo."
        action={
          <Button variant="brand" onClick={clearBulkSession}>
            <Upload /> Enviar arquivos
          </Button>
        }
      />
    );
  }

  const confirm = () => {
    const ids = ready.flatMap((v) => (v.item.batchId ? [v.item.batchId] : []));
    if (!ids.length) return;
    commit.mutate(ids, { onSettled: () => setConfirmOpen(false) });
  };

  return (
    <>
      <Stepper
        steps={[
          { id: "upload", label: "Enviar arquivos" },
          { id: "review", label: "Revisar o lote" },
          { id: "reconcile", label: "Conciliar" },
        ]}
        current={step}
        label="Etapas da importação em lote"
      />
      <div className="space-y-4">
        <Card className="p-4 sm:p-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <Layers className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold">Lote com {total} arquivo(s)</h2>
              <p className="mt-0.5 flex min-w-0 items-start gap-1 text-xs text-muted-foreground">
                <DestIcon className="mt-px size-3.5 shrink-0" aria-hidden /> <span className="min-w-0 break-words">Destino: {destName}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">Os arquivos são enviados um de cada vez e cada um gera a sua prévia.</p>
            </div>
          </div>
          <div className="mt-4">
            <div className="flex items-start justify-between gap-3 text-sm">
              <p role="status" aria-live="polite" className="min-w-0 break-words">
                {uploading && <LoaderCircle className="mr-1.5 inline size-4 animate-spin align-[-3px] text-brand" aria-hidden />}
                {progressText}
              </p>
              <span className="shrink-0 text-xs text-muted-foreground tabular" aria-hidden>
                {processed}/{total}
              </span>
            </div>
            <Progress value={(processed / total) * 100} className="mt-2" aria-label="Progresso do envio dos arquivos" />
          </div>
          {shared.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Avisos para todos os arquivos</p>
              <Warnings warnings={shared} compact />
            </div>
          )}
        </Card>

        {results.length > 0 && (
          <Card className="border-positive/30 p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-positive/10 text-positive">
                <ShieldCheck className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold">Resultado da confirmação</h2>
                <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">
                  {resultTotals.ok} de {results.length} arquivo(s) importado(s). Antes de gravar cada arquivo, as duplicidades foram conferidas de novo com o que os anteriores criaram.
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              <TotalTile icon={CheckCircle2} label="Lançamentos criados" value={resultTotals.created} tone="positive" />
              <TotalTile icon={Copy} label="Duplicados evitados" value={resultTotals.duplicatesAtCommit} hint="Já criados por um arquivo anterior ou registrados depois da prévia" />
              <TotalTile icon={Link2} label="Vinculados" value={resultTotals.matched} hint="Já estavam no app" />
              <TotalTile
                icon={AlertTriangle}
                label="Divergências"
                value={resultTotals.divergent}
                tone={resultTotals.divergent ? "warning" : undefined}
                hint={
                  resultTotals.divergent ? (
                    <Link href="/pendencias" className="font-medium text-brand hover:underline">
                      Resolver em Pendências
                    </Link>
                  ) : (
                    "Viram pendências"
                  )
                }
              />
              <TotalTile icon={XCircle} label="Com erro" value={resultTotals.errors + (results.length - resultTotals.ok)} tone={resultTotals.errors || results.length > resultTotals.ok ? "negative" : undefined} hint="Linhas com erro + arquivos não importados" />
            </div>
          </Card>
        )}

        {(ready.length > 0 || uploading) && (
          <section aria-labelledby="bulk-totals" className="space-y-3">
            <h3 id="bulk-totals" className="text-sm font-semibold">
              Totais {ready.length ? `dos ${ready.length} arquivo(s) prontos para confirmar` : "do lote"}
            </h3>
            <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", readyStats.transfers > 0 || readyStats.unresolvedTransfers > 0 ? "sm:grid-cols-4 xl:grid-cols-7" : "xl:grid-cols-6")}>
              <TotalTile icon={FileCheck2} label="Arquivos prontos" value={`${ready.length} de ${total}`} />
              <TotalTile icon={ROW_STATUS.NEW.icon} label="Novos a criar" value={readyStats.selectedNew} hint={readyStats.selectedNew !== readyStats.newRows ? `de ${readyStats.newRows} novos (só os selecionados)` : "selecionados"} />
              <TotalTile icon={ROW_STATUS.MATCHED.icon} label="Já registrados" value={readyStats.matched} hint="Vinculados sem duplicar" />
              <TotalTile icon={ROW_STATUS.DIVERGENT.icon} label="Divergências" value={readyStats.divergent} hint="Viram pendências" />
              <TotalTile icon={ROW_STATUS.DUPLICATE.icon} label="Duplicados" value={readyStats.duplicate} hint="Não entram de novo" />
              <TotalTile icon={ROW_STATUS.SKIPPED.icon} label="Ignorados" value={readyStats.skipped} hint="Saldos, zeros, pagamentos de fatura" />
              {(readyStats.transfers > 0 || readyStats.unresolvedTransfers > 0) && (
                <TotalTile
                  icon={ArrowLeftRight}
                  label="Transferências"
                  value={readyStats.transfers}
                  tone={readyStats.unresolvedTransfers ? "warning" : undefined}
                  hint={
                    readyStats.unresolvedTransfers
                      ? `Não contam como receita/despesa · ${readyStats.unresolvedTransfers} sem conta (fora até escolher)`
                      : "Não contam como receita nem despesa"
                  }
                />
              )}
            </div>
          </section>
        )}
        {(mapping.length > 0 || scope.length > 0 || failedUploads.length > 0) && (
          <div className="flex gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="space-y-1">
              {mapping.length > 0 && (
                <p>
                  <strong>{mapping.length}</strong> arquivo(s) precisam de revisão do mapeamento de colunas e ficam <strong>fora do “Confirmar todos”</strong> até você ajustar
                  (botão “Ajustar mapeamento” em cada um). Depois de aplicado, o arquivo entra no lote automaticamente.
                </p>
              )}
              {scope.length > 0 && (
                <p>
                  <strong>{scope.length}</strong> PDF(s) parecem ser de outro tipo (extrato × fatura) que o destino escolhido e vieram sem linhas selecionadas: ficam{" "}
                  <strong>fora do “Confirmar todos”</strong> até você revisar e selecionar as linhas (ou enviar de novo com o destino certo).
                </p>
              )}
              {failedUploads.length > 0 && (
                <p>
                  <strong>{failedUploads.length}</strong> arquivo(s) com erro não serão importados.
                </p>
              )}
            </div>
          </div>
        )}

        <Card className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <h3 className="text-sm font-semibold">Arquivos</h3>
            <p className="text-xs text-muted-foreground">Abra um arquivo para revisar linhas, categorias e mapeamento.</p>
          </div>
          <ul className="divide-y">
            {views.map((v) => (
              <ItemRow key={v.item.key} view={v} hiddenWarnings={shared} />
            ))}
          </ul>
        </Card>

        {(ready.length > 0 || uploading) && (
          <Card className="sticky bottom-20 z-10 flex items-center justify-between gap-3 border-brand/30 p-3 shadow-lg sm:p-4 lg:bottom-4">
            <div className="min-w-0 text-sm">
              <p className="font-semibold">
                {uploading ? "Aguardando o envio…" : `${readyStats.selectedNew} novo(s) a criar em ${ready.length} arquivo(s)`}
              </p>
              <p className="hidden text-xs text-muted-foreground sm:block">
                {uploading
                  ? "Você já pode abrir as prévias prontas enquanto os outros arquivos são enviados."
                  : `${readyStats.selectedMatched} vínculo(s) · ${readyStats.selectedDivergent} divergência(s)${mapping.length ? ` · ${mapping.length} fora (mapeamento)` : ""}${scope.length ? ` · ${scope.length} fora (destino)` : ""}`}
              </p>
            </div>
            <Button variant="brand" onClick={() => setConfirmOpen(true)} disabled={uploading || !ready.length} loading={commit.isPending} className="shrink-0">
              <Upload /> {results.length ? "Confirmar restantes" : "Confirmar todos"}
            </Button>
          </Card>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !commit.isPending && setConfirmOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar {ready.length} arquivo(s)?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Serão criados <strong className="text-foreground">{readyStats.selectedNew}</strong> lançamento(s) novo(s) em <strong className="text-foreground">{ready.length}</strong> arquivo(s), vinculadas{" "}
                  <strong className="text-foreground">{readyStats.selectedMatched}</strong> correspondência(s) e abertas <strong className="text-foreground">{readyStats.selectedDivergent}</strong> pendência(s) de
                  divergência.
                </p>
                <p>
                  Os arquivos são gravados um de cada vez. Antes de cada um, o sistema confere de novo as duplicidades com o que os anteriores já criaram — extratos com períodos sobrepostos não
                  duplicam lançamentos. Por isso o número final pode ser menor.
                </p>
                {readyStats.transfers > 0 && (
                  <p>
                    <strong className="text-foreground">{readyStats.transfers}</strong> linha(s) entram como transferência entre contas próprias (aplicação/resgate): não contam como receita nem despesa.
                  </p>
                )}
                {readyStats.unresolvedTransfers > 0 && (
                  <p className="text-foreground">{readyStats.unresolvedTransfers} linha(s) que parecem aplicação/resgate, sem a conta do outro lado, ficam de fora — escolha a conta em “Revisar” para incluí-las.</p>
                )}
                {readyStats.awaitingAmount > 0 && (
                  <p className="text-foreground">{readyStats.awaitingAmount} remessa(s)/câmbio(s) sem o valor na outra moeda ficam de fora — informe o valor em “Revisar” para incluí-las.</p>
                )}
                {mapping.length > 0 && <p className="text-foreground">{mapping.length} arquivo(s) que precisam de revisão do mapeamento ficam de fora.</p>}
                {scope.length > 0 && <p className="text-foreground">{scope.length} PDF(s) com destino a conferir (nenhuma linha selecionada) ficam de fora.</p>}
                <p>Cada importação pode ser desfeita depois, pelo histórico.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={commit.isPending}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirm();
              }}
              disabled={commit.isPending}
            >
              {commit.isPending ? "Importando…" : `Importar ${ready.length} arquivo(s)`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
