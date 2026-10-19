"use client";

import Link from "next/link";
import { ArrowRight, BookmarkCheck, CheckCircle2, Landmark, ListOrdered, PiggyBank, Plus, ReceiptText, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBRL } from "@/lib/money";
import { formatDateTimeBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { MigrationDTO, MigrationResultDTO } from "@/server/modules/migration/types";
import { UndoMigrationButton } from "./confirm-dialogs";
import { Banner, ProgressPanel } from "./status";

function ResultStat({ label, value, tone }: { label: string; value: number; tone?: "positive" | "negative" | "muted" }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-3">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 text-xl font-semibold tabular", value > 0 && tone === "positive" && "text-positive", value > 0 && tone === "negative" && "text-negative", !value && "text-muted-foreground")}>
        {value.toLocaleString("pt-BR")}
      </dd>
    </div>
  );
}

function ResultBlock({ result: r }: { result: MigrationResultDTO }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>O que foi gravado</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <ResultStat label="Lançamentos criados" value={r.created} tone="positive" />
          <ResultStat label="Já existiam (vinculados)" value={r.matched} />
          <ResultStat label="Duplicados (não entraram)" value={r.duplicates} />
          <ResultStat label="Com erro" value={r.errors} tone="negative" />
          <ResultStat label="Contas a pagar" value={r.bills} />
          <ResultStat label="Orçamentos" value={r.budgets} />
        </dl>

        {r.balances.length > 0 && (
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Landmark className="size-4 text-muted-foreground" aria-hidden /> Saldos das contas
            </h3>
            <div className="relative mt-2 overflow-x-auto rounded-lg border">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Conta
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Antes
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Depois
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Diferença
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.balances.map((b) => {
                    const diff = b.afterCents - b.beforeCents;
                    return (
                      <tr key={b.accountId} className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium">{b.name}</td>
                        <td className="px-3 py-2 text-right tabular text-muted-foreground">{formatBRL(b.beforeCents)}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular">{formatBRL(b.afterCents)}</td>
                        <td className={cn("px-3 py-2 text-right tabular", diff > 0 && "text-positive", diff === 0 && "text-muted-foreground")}>{formatBRL(diff, { signed: true })}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {r.templateSaved && (
          <p className="flex items-start gap-2 text-sm">
            <BookmarkCheck className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
            <span>Formato salvo: na próxima planilha igual, abas, colunas e correspondências já vêm preenchidas e o app só pergunta o que for novo.</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Etapa 6: concluído (ou desfeito), com links e "Desfazer migração". */
export function DoneStep({ migration: m, timezone, onNewMigration }: { migration: MigrationDTO; timezone?: string; onNewMigration: () => void }) {
  if (m.status === "COMMITTING") {
    return (
      <ProgressPanel
        title="Importando a migração…"
        progress={m.progress}
        label={m.progressLabel}
        hint="Você pode sair desta tela: a gravação continua e o resultado aparece aqui e em “Migrações anteriores”."
      />
    );
  }

  const r = m.result;
  if (m.status === "UNDONE") {
    return (
      <div className="space-y-4">
        <Banner
          tone="muted"
          icon={Undo2}
          title={`Migração desfeita${m.undoneAt ? ` em ${formatDateTimeBR(m.undoneAt, timezone)}` : ""}`}
          action={
            <Button variant="brand" size="sm" onClick={onNewMigration}>
              <Plus aria-hidden /> Nova migração
            </Button>
          }
        >
          Os lançamentos criados foram para a lixeira; contas a pagar, orçamentos e saldos iniciais voltaram ao que eram. Categorias, contas e cartões criados pela migração e sem uso foram removidos.
          A mesma planilha pode ser migrada de novo.
        </Banner>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Banner tone="positive" icon={CheckCircle2} title={`Migração concluída${m.importedAt ? ` em ${formatDateTimeBR(m.importedAt, timezone)}` : ""}`} action={<UndoMigrationButton migration={m} size="sm" />}>
        {r ? `${r.created.toLocaleString("pt-BR")} lançamento(s) criado(s) a partir de “${m.fileName}”.` : `Os dados de “${m.fileName}” foram importados.`} Se algo não ficou como esperado, dá
        para desfazer a migração inteira.
      </Banner>

      {r && <ResultBlock result={r} />}

      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
        <p className="text-sm font-medium sm:mr-auto">Confira nas telas do app:</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/transacoes">
              <ListOrdered aria-hidden /> Transações <ArrowRight aria-hidden />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/contas">
              <Landmark aria-hidden /> Contas <ArrowRight aria-hidden />
            </Link>
          </Button>
          {Boolean(r?.bills) && (
            <Button asChild variant="outline" size="sm">
              <Link href="/contas-a-pagar">
                <ReceiptText aria-hidden /> Contas a pagar <ArrowRight aria-hidden />
              </Link>
            </Button>
          )}
          {Boolean(r?.budgets) && (
            <Button asChild variant="outline" size="sm">
              <Link href="/orcamentos">
                <PiggyBank aria-hidden /> Orçamentos <ArrowRight aria-hidden />
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onNewMigration}>
            <Plus aria-hidden /> Nova migração
          </Button>
        </div>
      </Card>
    </div>
  );
}
