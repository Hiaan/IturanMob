"use client";

import { useState } from "react";
import { ArrowLeft, CalendarClock, CreditCard, PiggyBank, Plus, ReceiptText, TriangleAlert, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatMonthBR } from "@/lib/dates";
import { Warnings } from "@/features/imports/warnings";
import type { MigrationDTO, MigrationDestinationDTO, MigrationSummaryDTO } from "@/server/modules/migration/types";
import { DiscardMigrationButton } from "./confirm-dialogs";
import { DestinationCard } from "./destination-card";
import { plural } from "./labels";
import { DestinationRowsDialog } from "./rows-dialog";
import { ProgressPanel } from "./status";
import { useBackToEdit, useCommitMigration, useMigrationBusy } from "./use-migration";

const LIST_PREVIEW = 8;

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-lg font-semibold tabular">{children}</dd>
    </div>
  );
}

function NameList({ icon: Icon, title, names }: { icon: typeof Plus; title: string; names: string[] }) {
  if (!names.length) return null;
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 break-words">
        <span className="font-medium">{title}:</span> <span className="text-muted-foreground">{names.join(", ")}</span>
      </p>
    </div>
  );
}

/** Lista com "mostrar todas" (contas a pagar, orçamentos). */
function Expandable<T>({ items, render, label }: { items: T[]; render: (item: T, i: number) => React.ReactNode; label: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_PREVIEW);
  return (
    <>
      <ul className="divide-y rounded-lg border" aria-label={label}>
        {shown.map(render)}
      </ul>
      {items.length > LIST_PREVIEW && (
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Mostrar menos" : `Mostrar todas (${items.length})`}
        </Button>
      )}
    </>
  );
}

function SummaryBlock({ summary: s }: { summary: MigrationSummaryDTO }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Resumo da migração</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Metric label="Linhas a importar">
            {s.totals.selected.toLocaleString("pt-BR")} <span className="text-xs font-normal text-muted-foreground">de {s.totals.rows.toLocaleString("pt-BR")}</span>
          </Metric>
          <Metric label="Período">{s.period ? <span className="text-sm">{`${formatDateBR(s.period.start)} a ${formatDateBR(s.period.end)}`}</span> : "—"}</Metric>
          <Metric label="Entradas">
            <span className="text-positive">{formatBRL(s.totals.inCents)}</span>
          </Metric>
          <Metric label="Saídas">{formatBRL(s.totals.outCents)}</Metric>
        </dl>

        <div className="space-y-2">
          <NameList icon={Plus} title="Categorias novas" names={s.createdCategories} />
          <NameList icon={Plus} title="Contas criadas" names={s.createdAccounts} />
          <NameList icon={Plus} title="Cartões criados" names={s.createdCards} />
          {s.matrixTransactions > 0 && (
            <p className="flex items-start gap-2 text-sm">
              <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0">
                <span className="font-medium">{plural(s.matrixTransactions, "lançamento consolidado", "lançamentos consolidados")} por mês</span>{" "}
                <span className="text-muted-foreground">(das abas de categorias × meses, marcados “importado de planilha (total do mês)”).</span>
              </span>
            </p>
          )}
        </div>

        {s.cardStatementsWithoutPayment.length > 0 && (
          <div role="note" className="flex gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
            <CreditCard className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0">
              <p className="font-medium">Faturas passadas sem pagamento registrado</p>
              <ul className="mt-0.5 text-muted-foreground">
                {s.cardStatementsWithoutPayment.map((c) => (
                  <li key={c.cardName}>
                    {c.cardName}: {plural(c.count, "fatura", "faturas")}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">Se a planilha não tem os pagamentos das faturas, registre-os depois em Cartões para o saldo da conta bater.</p>
            </div>
          </div>
        )}

        {(s.bills.length > 0 || s.skippedBills > 0) && (
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <ReceiptText className="size-4 text-muted-foreground" aria-hidden /> Contas a pagar a criar ({s.bills.length})
            </h3>
            {s.skippedBills > 0 && <p className="mt-0.5 text-xs text-muted-foreground">{plural(s.skippedBills, "conta a pagar da planilha ficou", "contas a pagar da planilha ficaram")} de fora.</p>}
            {s.bills.length > 0 && (
              <div className="mt-2">
                <Expandable
                  items={s.bills}
                  label="Contas a pagar a criar"
                  render={(b, i) => (
                    <li key={`${b.description}-${b.dueDate}-${i}`} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <span className="min-w-0 break-words">
                        {b.description}
                        <Badge variant="muted" className="ml-1.5">
                          {b.origin === "FUTURE_INSTALLMENT" ? "parcela futura" : "a pagar na planilha"}
                        </Badge>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular">
                        vence {formatDateBR(b.dueDate)} ·{" "}
                        <span className={b.type === "INCOME" ? "font-medium text-positive" : "font-medium text-foreground"}>
                          {b.type === "INCOME" ? "a receber " : ""}
                          {formatBRL(b.amountCents)}
                        </span>
                      </span>
                    </li>
                  )}
                />
              </div>
            )}
          </div>
        )}

        {s.budgets.length > 0 && (
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <PiggyBank className="size-4 text-muted-foreground" aria-hidden /> Orçamentos ({s.budgets.length})
            </h3>
            <div className="mt-2">
              <Expandable
                items={s.budgets}
                label="Orçamentos a definir"
                render={(b, i) => (
                  <li key={`${b.categoryId}-${b.month}-${i}`} className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0 break-words">
                      {b.categoryLabel} <span className="text-xs text-muted-foreground">· {formatMonthBR(b.month)}</span>
                    </span>
                    <span className="shrink-0 text-xs tabular">
                      <span className="font-medium">{formatBRL(b.limitCents)}</span>
                      <span className="text-muted-foreground">{b.previousCents !== null ? ` (antes: ${formatBRL(b.previousCents)})` : " (novo)"}</span>
                    </span>
                  </li>
                )}
              />
            </div>
          </div>
        )}

        {s.warnings.length > 0 && <Warnings warnings={s.warnings} />}
      </CardContent>
    </Card>
  );
}

/** Contas novas que ainda precisam do saldo inicial (bloqueiam "Importar tudo"). */
function missingBalances(s: MigrationSummaryDTO): string[] {
  return s.destinations.filter((d) => d.kind === "ACCOUNT" && d.balance?.needsInitialBalance && !d.balance.choice).map((d) => d.name);
}

/** Etapa 5: prévia (resumo, destinos, saldos) e "Importar tudo". */
export function PreviewStep({ migration: m, onBack }: { migration: MigrationDTO; onBack: () => void }) {
  const [rowsOf, setRowsOf] = useState<MigrationDestinationDTO | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const back = useBackToEdit(m.id, onBack);
  const commit = useCommitMigration(m.id);
  const busy = useMigrationBusy(m.id);

  if (m.status === "PREVIEWING" || !m.summary) {
    return (
      <ProgressPanel
        title="Gerando a prévia…"
        progress={m.progress}
        label={m.progressLabel}
        hint="O app monta os lançamentos de cada conta e cartão e confere o que já existe no app. Nada é gravado ainda."
      />
    );
  }

  const s = m.summary;
  const missing = missingBalances(s);
  const created = new Set([...s.createdAccounts, ...s.createdCards]);
  const totalBills = s.bills.length;
  const nothingToImport = s.totals.selected === 0 && totalBills === 0 && s.budgets.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold">Prévia</h2>
        <p className="mt-1 text-sm text-muted-foreground">Confira o que vai entrar em cada conta e cartão. Use “Ver linhas” para desmarcar ou ajustar lançamentos — os números são recalculados.</p>
      </div>

      <SummaryBlock summary={s} />

      {s.destinations.length > 0 && (
        <div className="grid gap-3 xl:grid-cols-2">
          {s.destinations.map((d) => (
            <DestinationCard
              key={d.batchId}
              migration={m}
              destination={d}
              isCreated={Boolean(d.balance?.isNew) || (d.kind !== "NONE" && d.kind !== "MATRIX" && created.has(d.name))}
              onViewRows={() => setRowsOf(d)}
            />
          ))}
        </div>
      )}

      <Card className="sticky bottom-20 z-10 flex flex-col gap-3 border-brand/30 p-3 shadow-lg sm:p-4 lg:bottom-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 text-sm">
          <p className="font-semibold">
            {plural(s.totals.selected, "lançamento", "lançamentos")} em {plural(s.destinations.length, "destino", "destinos")}
            <span className="font-normal text-muted-foreground">
              {" "}
              · entradas <span className="tabular">{formatBRL(s.totals.inCents)}</span> · saídas <span className="tabular">{formatBRL(s.totals.outCents)}</span>
            </span>
          </p>
          {nothingToImport ? (
            <p className="mt-0.5 text-xs font-medium text-warning">Nenhuma linha selecionada: use “Ver linhas” para marcar o que importar, ou volte e ajuste.</p>
          ) : missing.length > 0 ? (
            <p className="mt-0.5 flex items-start gap-1 text-xs font-medium text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> Informe o saldo inicial de: {missing.join(", ")}.
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">Nada foi gravado ainda. Depois de importar, dá para desfazer a migração inteira.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => back.mutate()} loading={back.isPending} disabled={busy}>
            <ArrowLeft aria-hidden /> Voltar e ajustar
          </Button>
          <DiscardMigrationButton migration={m} variant="ghost" size="default" className="text-destructive hover:text-destructive" />
          <Button variant="brand" onClick={() => setConfirmOpen(true)} disabled={busy || missing.length > 0 || nothingToImport} className="flex-1 sm:flex-none">
            <Upload aria-hidden /> Importar tudo
          </Button>
        </div>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Importar a migração inteira?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Entram <strong className="text-foreground">{plural(s.totals.selected, "lançamento", "lançamentos")}</strong> em {plural(s.destinations.length, "destino", "destinos")}
                  {s.period ? ` (de ${formatDateBR(s.period.start)} a ${formatDateBR(s.period.end)})` : ""}: entradas <strong className="text-foreground">{formatBRL(s.totals.inCents)}</strong> e saídas{" "}
                  <strong className="text-foreground">{formatBRL(s.totals.outCents)}</strong>.
                </p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {totalBills > 0 && <li>{plural(totalBills, "conta a pagar criada", "contas a pagar criadas")}</li>}
                  {s.budgets.length > 0 && <li>{plural(s.budgets.length, "orçamento definido", "orçamentos definidos")}</li>}
                  {s.createdCategories.length > 0 && <li>{plural(s.createdCategories.length, "categoria nova", "categorias novas")}</li>}
                  {s.matrixTransactions > 0 && <li>{plural(s.matrixTransactions, "lançamento consolidado", "lançamentos consolidados")} por mês</li>}
                  {m.options.saveTemplate && <li>formato salvo como “{m.options.templateName ?? m.fileName}”</li>}
                </ul>
                <p>Lançamentos que já existem no app são só vinculados, sem duplicar. Você poderá desfazer a migração inteira depois.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              disabled={commit.isPending}
              onClick={(e) => {
                e.preventDefault();
                commit.mutate(undefined, { onSettled: () => setConfirmOpen(false) });
              }}
            >
              {commit.isPending ? "Importando…" : "Importar tudo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DestinationRowsDialog migrationId={m.id} destination={rowsOf} onOpenChange={(v) => !v && setRowsOf(null)} />
    </div>
  );
}
