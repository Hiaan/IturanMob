"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CircleMinus, CirclePlus, Copy, FileSearch, Link2, Plus, Scale, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { TRANSACTION_SOURCE_LABELS, TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { SummaryTile } from "@/features/budgets/summary-tile";
import { RowStatusBadge } from "./status";
import { UndoImportButton } from "./undo-dialog";
import { useReconciliation } from "./use-imports";
import type { ImportPreview, ImportRowDTO } from "./types";

const COLLAPSED = 5;

function Group({
  icon: Icon,
  title,
  explanation,
  tone,
  count,
  children,
  footer,
}: {
  icon: typeof Link2;
  title: string;
  explanation: string;
  tone: "positive" | "info" | "warning" | "muted";
  count: number;
  children: (limit: number) => React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const toneClass = { positive: "bg-positive/10 text-positive", info: "bg-info/10 text-info", warning: "bg-warning/10 text-warning", muted: "bg-muted text-muted-foreground" }[tone];
  return (
    <Card className="flex min-w-0 flex-col p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", toneClass)}>
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {title} <Badge variant="muted">{count}</Badge>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{explanation}</p>
        </div>
      </div>
      {count > 0 ? (
        <div className="mt-3">
          {children(expanded ? 10_000 : COLLAPSED)}
          {count > COLLAPSED && (
            <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Mostrar menos" : `Ver todos (${count})`}
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Nenhum item.</p>
      )}
      {footer}
    </Card>
  );
}

function RowLine({ row, extra }: { row: ImportRowDTO; extra?: React.ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">{row.description ?? "—"}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="tabular">{row.date ? formatDateBR(row.date) : "Sem data"}</span>
          {extra}
        </p>
      </div>
      <span className={cn("shrink-0 font-medium tabular", (row.amountCents ?? 0) > 0 && "text-positive")}>{row.amountCents === null ? "—" : formatBRL(row.amountCents, { signed: true })}</span>
    </li>
  );
}

/** Etapa final: conciliação do extrato com os lançamentos do app. */
export function ReconciliationStep({ preview, onNewImport }: { preview: ImportPreview; onNewImport: () => void }) {
  const q = useReconciliation(preview.batch.id, true);
  const batch = preview.batch;
  const r = preview.result;

  if (q.isLoading)
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    );
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rec = q.data;

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <h2 className="text-[15px] font-semibold">{batch.status === "UNDONE" ? "Importação desfeita" : "Importação concluída"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {batch.status === "UNDONE"
              ? "Os lançamentos criados por este arquivo foram para a lixeira e os saldos foram recalculados."
              : r && !r.alreadyImported
                ? `${r.created ?? 0} lançamento(s) criado(s), ${r.matched ?? 0} vinculado(s) e ${r.divergent ?? 0} divergência(s) enviada(s) para Pendências${r.errors ? `; ${r.errors} linha(s) com erro` : ""}.`
                : `${batch.importedRows} lançamento(s) criado(s) e ${batch.matchedRows} correspondência(s) vinculada(s).`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <UndoImportButton batch={batch} />
          <Button variant="brand" size="sm" onClick={onNewImport}>
            <Plus /> Nova importação
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <SummaryTile label="Período do extrato" value={rec.period ? <span className="text-base sm:text-lg">{`${formatDateBR(rec.period.start)} – ${formatDateBR(rec.period.end)}`}</span> : "—"}>
          {batch.account?.name ?? batch.creditCard?.name ?? "Sem conta vinculada"}
        </SummaryTile>
        <SummaryTile label="Entradas no extrato" value={<span className="tabular text-positive">{formatBRL(rec.totals.statementInflowCents)}</span>}>
          <span className="inline-flex items-center gap-1">
            <ArrowDownLeft className="size-3.5" aria-hidden /> créditos considerados
          </span>
        </SummaryTile>
        <SummaryTile label="Saídas no extrato" value={<span className="tabular">{formatBRL(rec.totals.statementOutflowCents)}</span>}>
          <span className="inline-flex items-center gap-1">
            <ArrowUpRight className="size-3.5" aria-hidden /> débitos considerados
          </span>
        </SummaryTile>
        <SummaryTile label="Saldo informado pelo banco" value={<span className="tabular">{rec.totals.statementLedgerBalanceCents === null ? "—" : formatBRL(rec.totals.statementLedgerBalanceCents)}</span>}>
          {rec.totals.statementLedgerBalanceCents === null ? "Disponível apenas em OFX" : "Compare com o saldo da conta no app"}
        </SummaryTile>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Group icon={Link2} tone="positive" title="Correspondentes" count={rec.matched.length} explanation="Já estavam no app (por exemplo, registrados pelo WhatsApp) — mesmo valor e até 3 dias de diferença. Foram apenas vinculados, sem duplicar.">
          {(limit) => (
            <ul className="divide-y">
              {rec.matched.slice(0, limit).map((row) => (
                <RowLine
                  key={row.id}
                  row={row}
                  extra={
                    row.matchedTransaction && (
                      <span>
                        · no app: {row.matchedTransaction.description} ({labelOf(TRANSACTION_SOURCE_LABELS, row.matchedTransaction.source)})
                      </span>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </Group>
        <Group icon={CirclePlus} tone="info" title="Não registradas no app" count={rec.notInApp.length} explanation="Linhas do extrato que não existiam no app. As selecionadas foram criadas como lançamentos; as desmarcadas ficaram de fora.">
          {(limit) => (
            <ul className="divide-y">
              {rec.notInApp.slice(0, limit).map((row) => (
                <RowLine
                  key={row.id}
                  row={row}
                  extra={
                    batch.status === "UNDONE" && row.status === "IMPORTED" ? (
                      <Badge variant="muted">
                        <Undo2 aria-hidden /> Desfeito (na lixeira)
                      </Badge>
                    ) : (
                      <RowStatusBadge status={row.status} />
                    )
                  }
                />
              ))}
            </ul>
          )}
        </Group>
        <Group
          icon={AlertTriangle}
          tone="warning"
          title="Divergências de valor"
          count={rec.divergent.length}
          explanation="Descrição e data parecidas com um lançamento do app, mas com valor diferente (até 30%). Cada uma virou uma pendência para você decidir qual valor está certo."
          footer={
            rec.divergent.length > 0 && batch.status === "IMPORTED" ? (
              <Link href="/pendencias" className="mt-3 inline-block text-sm font-medium text-brand hover:underline">
                Resolver em Pendências
              </Link>
            ) : null
          }
        >
          {(limit) => (
            <ul className="divide-y">
              {rec.divergent.slice(0, limit).map((row) => (
                <RowLine
                  key={row.id}
                  row={row}
                  extra={
                    row.matchedTransaction && (
                      <span>
                        · no app: <span className="tabular">{formatBRL(row.matchedTransaction.amountCents)}</span>
                        {row.differenceCents !== null && (
                          <>
                            {" "}
                            · diferença <span className="tabular">{formatBRL(row.differenceCents, { signed: true })}</span>
                          </>
                        )}
                      </span>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </Group>
        <Group icon={Copy} tone="muted" title="Duplicidades" count={rec.duplicates.length} explanation="Linhas que já tinham sido importadas antes nesta conta ou cartão (mesmo identificador ou mesma linha). Não foram importadas de novo.">
          {(limit) => (
            <ul className="divide-y">
              {rec.duplicates.slice(0, limit).map((row) => (
                <RowLine key={row.id} row={row} extra={row.message && <span>· {row.message}</span>} />
              ))}
            </ul>
          )}
        </Group>
        <Group
          icon={FileSearch}
          tone="info"
          title="Lançados no app, ausentes no extrato"
          count={rec.missingInStatement.length}
          explanation="Lançamentos do app na mesma conta/cartão e período que não aparecem no arquivo. Confira se foram registrados em dobro, na conta errada ou ainda não compensaram."
        >
          {(limit) => (
            <ul className="divide-y">
              {rec.missingInStatement.slice(0, limit).map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.description}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDateBR(t.date)} · {labelOf(TRANSACTION_TYPE_LABELS, t.type)} · {labelOf(TRANSACTION_SOURCE_LABELS, t.source)}
                    </p>
                  </div>
                  <span className="shrink-0 font-medium tabular">{formatBRL(t.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Group>
        <Group icon={CircleMinus} tone="muted" title="Ignoradas ou com erro" count={rec.ignored.length} explanation="Saldos, valores zerados, pagamentos/créditos de fatura e linhas que não puderam ser lidas.">
          {(limit) => (
            <ul className="divide-y">
              {rec.ignored.slice(0, limit).map((row) => (
                <RowLine key={row.id} row={row} extra={row.message && <span>· {row.message}</span>} />
              ))}
            </ul>
          )}
        </Group>
      </div>
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Scale className="size-3.5" aria-hidden /> Transferências e pagamentos de fatura nunca entram como despesa — evitam dupla contagem.
      </p>
    </div>
  );
}
