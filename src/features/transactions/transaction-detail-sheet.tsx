"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArchiveRestore, ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, EyeOff, FileText, ImageOff, Info, Mic, PencilLine, Trash2, Undo2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ErrorState } from "@/components/shared/error-state";
import { formatBRL, formatMoney } from "@/lib/money";
import { formatDateBR, formatDateTimeBR, formatMonthBR } from "@/lib/dates";
import { OWNERSHIP_LABELS, PAYMENT_METHOD_LABELS, TRANSACTION_SOURCE_LABELS, TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";
import { TransactionForm } from "./transaction-form";
import { TransactionHistory } from "./transaction-history";
import { AmountText, ExcludedBadge, PendingBadge, SourceTag, TransactionIcon, categoryLabel } from "./transaction-visuals";
import { useTransactionActions, useTransactionDetail, type TransactionDetail } from "./use-transaction-actions";
import { DeleteTransactionsDialog, PurgeTransactionsDialog } from "./confirm-dialogs";
import { describeExchange, isForeignCurrency, useAccountCurrencies } from "@/features/accounts/currency";
import { ReportExclusionDialog } from "./report-exclusion-dialog";
import { EXCLUSION_REASON_LABELS, canExcludeFromReports, exclusionAuthorLine, sameParty, usePassthrough, useReportExclusion } from "./report-exclusion";
import { PassthroughBalance, excludedListHref } from "./passthrough-card";

const EDITABLE_TYPES = new Set(["EXPENSE", "INCOME", "TRANSFER"]);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function AttachmentItem({ a }: { a: TransactionDetail["attachments"][number] }) {
  const [failed, setFailed] = useState(false);
  const url = `/api/v1/attachments/${a.id}`;
  const kindLabel = a.kind === "IMAGE" ? "Comprovante (imagem)" : a.kind === "AUDIO" ? "Áudio" : a.kind === "DOCUMENT" ? "Documento" : "Arquivo";
  return (
    <li className="rounded-xl border p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          {a.kind === "AUDIO" ? <Mic className="size-3.5" aria-hidden /> : <FileText className="size-3.5" aria-hidden />}
          {kindLabel}
        </span>
        <span>{formatDateTimeBR(a.createdAt)}</span>
      </div>
      {a.contentDeletedAt ? (
        <p className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" aria-hidden /> Conteúdo removido pela política de retenção ({formatDateBR(a.contentDeletedAt)}).
        </p>
      ) : failed ? (
        <p className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <ImageOff className="size-3.5 shrink-0" aria-hidden /> Não foi possível carregar o conteúdo.{" "}
          <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
            Tentar abrir
          </a>
        </p>
      ) : a.kind === "IMAGE" ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="group block w-fit rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Abrir em nova aba">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Comprovante enviado (abre em nova aba)" loading="lazy" onError={() => setFailed(true)} className="max-h-48 rounded-lg border object-contain transition group-hover:opacity-90" />
        </a>
      ) : a.kind === "AUDIO" ? (
        <audio controls preload="none" src={url} className="w-full" onError={() => setFailed(true)}>
          Seu navegador não reproduz áudio.
        </audio>
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline">
          <ExternalLink className="size-3.5" aria-hidden /> Abrir arquivo
        </a>
      )}
    </li>
  );
}

/** Saldo do repasse com o cliente deste lançamento (desde o início). */
function PartyBalance({ party }: { party: string }) {
  const q = usePassthrough(null);
  const stats = q.data?.parties.find((p) => sameParty(p.party, party));
  if (q.isLoading) return <Skeleton className="mt-3 h-[74px]" />;
  if (!stats) return null;
  return (
    <div className="mt-3 rounded-lg border bg-card p-3">
      <p className="text-xs font-medium">
        Saldo do repasse com {stats.party ?? party} <span className="font-normal text-muted-foreground">· desde o início · {stats.count} {stats.count === 1 ? "lançamento" : "lançamentos"}</span>
      </p>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">Recebido</dt>
          <dd className="truncate text-sm font-semibold tabular text-positive">+{formatBRL(stats.receivedCents)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">Gasto</dt>
          <dd className="truncate text-sm font-semibold tabular">−{formatBRL(stats.spentCents)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">Saldo</dt>
          <dd>
            <PassthroughBalance cents={stats.balanceCents} srLabel />
          </dd>
        </div>
      </dl>
      <Link href={excludedListHref(null)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
        Ver repasses de todos os clientes <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

/** Quadro "Desconsiderado nos relatórios": motivo, cliente, quem/quando e as ações. */
function ExclusionPanel({
  tx,
  timezone,
  canWrite,
  onEdit,
  onUndo,
  undoing,
}: {
  tx: TransactionDetail;
  timezone?: string;
  canWrite: boolean;
  onEdit: () => void;
  onUndo: () => void;
  undoing: boolean;
}) {
  const e = tx.exclusion;
  const author = exclusionAuthorLine(tx, timezone);
  const party = e?.reason === "CLIENT_PASSTHROUGH" ? e.party : null;
  const where = tx.creditCard
    ? `Continua na fatura do cartão ${tx.creditCard.name} e no limite usado`
    : tx.account
      ? `Continua no saldo de ${tx.account.name}`
      : "Continua registrado";
  return (
    <section aria-labelledby="exclusion-title" className="rounded-xl border border-dashed border-muted-foreground/40 bg-muted/40 p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground" aria-hidden>
          <EyeOff className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="exclusion-title" className="text-sm font-semibold">
            Desconsiderado nos relatórios
          </h3>
          <p className="mt-0.5 break-words text-sm">
            {EXCLUSION_REASON_LABELS[e?.reason ?? "OTHER"]}
            {e?.party && (
              <>
                {" · "}
                <span className="font-medium">{e.party}</span>
              </>
            )}
          </p>
          {e?.note && <p className="mt-0.5 break-words text-xs text-muted-foreground">“{e.note}”</p>}
          {author && <p className="mt-0.5 text-xs text-muted-foreground">Marcado {author}</p>}
        </div>
      </div>
      <p className="mt-2.5 text-xs text-muted-foreground">
        <strong className="font-medium text-foreground/80">{where}.</strong> Só não entra em receitas, despesas, categorias, orçamentos, comparativos e relatórios.
      </p>
      {party && <PartyBalance party={party} />}
      {canWrite && !tx.deletedAt && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onEdit} aria-label="Editar desconsideração">
            <PencilLine /> Editar
          </Button>
          <Button size="sm" variant="outline" loading={undoing} onClick={onUndo}>
            <Undo2 /> Voltar a considerar
          </Button>
        </div>
      )}
    </section>
  );
}

/** Painel lateral com todos os dados, parcelas, anexos, histórico e ações de uma transação. */
export function TransactionDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useTransactionDetail(id);
  const me = useMe();
  const tz = me.data?.household.timezone;
  const canWrite = useCan("transactions:write");
  const canDelete = useCan("transactions:delete");
  const actions = useTransactionActions();
  const exclusion = useReportExclusion();
  const [exclusionOpen, setExclusionOpen] = useState(false);
  const currencies = useAccountCurrencies();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const tx = q.data;

  useEffect(() => {
    setEditing(false);
    setExclusionOpen(false);
  }, [id]);

  const deleted = Boolean(tx?.deletedAt);
  const editable = tx && EDITABLE_TYPES.has(tx.type) && !deleted && canWrite;
  const excludable = Boolean(tx && canExcludeFromReports(tx) && canWrite);
  const currency = tx?.currency ?? "BRL";
  // Transferência entre moedas: valor que saiu (origem) e o creditado no destino.
  const crossTransfer = tx?.type === "TRANSFER" && tx.destinationAmountCents != null;
  const destinationCurrency = (tx?.destinationAccount && currencies.get(tx.destinationAccount.id)) ?? (isForeignCurrency(currency) ? "BRL" : null);
  const exchange =
    crossTransfer && tx && destinationCurrency ? describeExchange({ cents: tx.amountCents, currency }, { cents: tx.destinationAmountCents, currency: destinationCurrency }) : null;

  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className={cn("gap-0 transition-[max-width]", editing ? "sm:max-w-2xl" : "sm:max-w-lg")}>
        {q.isLoading || (!tx && !q.error) ? (
          <>
            <SheetHeader className="pb-4">
              <SheetTitle>Carregando lançamento…</SheetTitle>
              <SheetDescription className="sr-only">Aguarde enquanto os detalhes são carregados.</SheetDescription>
            </SheetHeader>
            <div className="space-y-3 px-5">
              <Skeleton className="h-16" />
              <Skeleton className="h-40" />
              <Skeleton className="h-32" />
            </div>
          </>
        ) : q.error || !tx ? (
          <>
            <SheetHeader className="pb-4">
              <SheetTitle>Lançamento</SheetTitle>
              <SheetDescription className="sr-only">Não foi possível carregar o lançamento.</SheetDescription>
            </SheetHeader>
            <div className="px-5">
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            </div>
          </>
        ) : editing ? (
          <>
            <SheetHeader className="pb-4">
              <button type="button" onClick={() => setEditing(false)} className="mb-1 inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-3.5" /> Voltar aos detalhes
              </button>
              <SheetTitle>Editar lançamento</SheetTitle>
              <SheetDescription>As alterações ficam registradas no histórico.</SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-5 pb-6">
              <TransactionForm transaction={tx} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
            </div>
          </>
        ) : (
          <>
            <SheetHeader className="pb-4">
              <div className="flex items-start gap-3">
                <TransactionIcon tx={tx} size="lg" />
                <div className="min-w-0">
                  <SheetTitle className="break-words leading-snug">{tx.description}</SheetTitle>
                  <SheetDescription>
                    {labelOf(TRANSACTION_TYPE_LABELS, tx.type)} · {formatDateBR(tx.date)}
                  </SheetDescription>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <AmountText tx={tx} className="text-2xl tracking-tight" secondary={false} />
                {tx.status === "PENDING" && <PendingBadge />}
                <ExcludedBadge tx={tx} />
                {deleted && (
                  <Badge variant="negative">
                    <Trash2 aria-hidden /> Na lixeira
                  </Badge>
                )}
              </div>
              {isForeignCurrency(currency) && (tx.type === "EXPENSE" || tx.type === "INCOME" || tx.type === "ADJUSTMENT") && (
                <p className="text-xs text-muted-foreground">
                  {tx.amountBrlCents != null ? (
                    <>
                      <span className="font-medium text-foreground tabular">≈ {formatBRL(tx.amountBrlCents)}</span> pela PTAX da data: é esse valor que entra nos relatórios.
                    </>
                  ) : (
                    "Ainda sem cotação PTAX para a data: o valor em reais entra nos relatórios quando a cotação chegar."
                  )}
                </p>
              )}
              {crossTransfer && destinationCurrency && (
                <p className="text-xs text-muted-foreground">
                  Creditado em {tx.destinationAccount?.name ?? "destino"}: <span className="font-medium text-foreground tabular">{formatMoney(tx.destinationAmountCents!, destinationCurrency)}</span>
                </p>
              )}
            </SheetHeader>

            <div className="flex flex-wrap gap-2 border-b px-5 pb-4">
              {editable && (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <PencilLine /> Editar
                </Button>
              )}
              {tx.status === "PENDING" && !deleted && canWrite && (
                <Button size="sm" variant="brand" loading={actions.confirm.isPending} onClick={() => actions.confirm.mutate(tx.id)}>
                  <CheckCircle2 /> Confirmar
                </Button>
              )}
              {excludable && !tx.excludedFromReports && (
                <Button size="sm" variant="outline" onClick={() => setExclusionOpen(true)} title="Repasse de cliente, reembolso…: o saldo da conta e a fatura do cartão não mudam">
                  <EyeOff /> Desconsiderar nos relatórios
                </Button>
              )}
              {!deleted && canDelete && (
                <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Excluir
                </Button>
              )}
              {deleted && canDelete && (
                <>
                  <Button size="sm" variant="brand" loading={actions.restore.isPending} onClick={() => actions.restore.mutate(tx.id)}>
                    <ArchiveRestore /> Restaurar
                  </Button>
                  <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirmPurge(true)}>
                    <Trash2 /> Excluir definitivamente
                  </Button>
                </>
              )}
              {!editable && !deleted && canWrite && !EDITABLE_TYPES.has(tx.type) && (
                <p className="basis-full text-xs text-muted-foreground">
                  {tx.type === "CARD_PAYMENT" ? "Pagamentos de fatura" : "Ajustes de saldo"} não são editados por aqui: exclua e registre novamente se necessário.
                </p>
              )}
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              {tx.excludedFromReports && (
                <ExclusionPanel
                  tx={tx}
                  timezone={tz}
                  canWrite={excludable}
                  onEdit={() => setExclusionOpen(true)}
                  onUndo={() => exclusion.mutate({ transactionIds: [tx.id], excluded: false })}
                  undoing={exclusion.isPending}
                />
              )}
              <Section title="Detalhes">
                <dl className="divide-y">
                  <Row label="Situação">{tx.status === "PENDING" ? "Aguardando confirmação (não afeta saldos)" : "Confirmada"}</Row>
                  <Row label="Data">{formatDateBR(tx.date)}</Row>
                  {tx.competenceDate !== tx.date && <Row label="Competência">{formatDateBR(tx.competenceDate)}</Row>}
                  {(tx.type === "EXPENSE" || tx.type === "INCOME") && (
                    <Row label="Categoria">
                      {tx.category ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ backgroundColor: tx.category.color }} aria-hidden />
                          {categoryLabel(tx)}
                        </span>
                      ) : (
                        <span className="text-warning">Sem categoria</span>
                      )}
                    </Row>
                  )}
                  {tx.merchant && <Row label="Estabelecimento">{tx.merchant.name}</Row>}
                  <Row label={tx.type === "INCOME" ? "Forma de recebimento" : "Forma de pagamento"}>{tx.paymentMethod ? labelOf(PAYMENT_METHOD_LABELS, tx.paymentMethod) : "Não informada"}</Row>
                  {tx.type === "TRANSFER" ? (
                    <>
                      <Row label="De">{tx.account?.name ?? "—"}</Row>
                      <Row label="Para">{tx.destinationAccount?.name ?? "—"}</Row>
                      {exchange && <Row label="Câmbio efetivo">{exchange}</Row>}
                    </>
                  ) : tx.type === "CARD_PAYMENT" ? (
                    <>
                      <Row label="Conta">{tx.account?.name ?? "—"}</Row>
                      <Row label="Cartão">{tx.creditCard?.name ?? "—"}</Row>
                      {tx.statement && (
                        <Row label="Fatura">
                          <Link href={`/cartoes?id=${tx.creditCard?.id ?? ""}&statement=${tx.statement.id}`} className="font-medium text-brand hover:underline">
                            {formatMonthBR(tx.statement.referenceMonth, { capitalize: true })}
                          </Link>
                        </Row>
                      )}
                    </>
                  ) : tx.creditCard ? (
                    <Row label="Cartão">
                      <Link href={`/cartoes?id=${tx.creditCard.id}`} className="font-medium text-brand hover:underline">
                        {tx.creditCard.name}
                      </Link>
                    </Row>
                  ) : (
                    <Row label={tx.type === "ADJUSTMENT" ? "Conta ajustada" : "Conta"}>
                      {tx.account || tx.destinationAccount ? (
                        <Link href={`/contas?id=${(tx.account ?? tx.destinationAccount)!.id}`} className="font-medium text-brand hover:underline">
                          {(tx.account ?? tx.destinationAccount)!.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Sem conta (não afeta saldos)</span>
                      )}
                    </Row>
                  )}
                  {(tx.type === "EXPENSE" || tx.type === "INCOME") && (
                    <>
                      <Row label={tx.type === "INCOME" ? "Quem recebeu" : "Quem pagou"}>{tx.payer?.displayName ?? "Não informado"}</Row>
                      <Row label="Responsável">
                        {tx.allocations.length > 1 ? (
                          <ul className="space-y-0.5">
                            {tx.allocations.map((a) => (
                              <li key={a.memberId} className="flex justify-between gap-2">
                                <span>{a.displayName}</span>
                                <span className="whitespace-nowrap tabular">{formatMoney(a.amountCents, currency)}</span>
                              </li>
                            ))}
                          </ul>
                        ) : tx.ownership === "INDIVIDUAL" ? (
                          `Individual — ${tx.responsible?.displayName ?? tx.allocations[0]?.displayName ?? "?"}`
                        ) : (
                          labelOf(OWNERSHIP_LABELS, tx.ownership)
                        )}
                      </Row>
                    </>
                  )}
                  <Row label="Origem">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <SourceTag source={tx.source} />
                      <span className="sr-only">{labelOf(TRANSACTION_SOURCE_LABELS, tx.source)}</span>
                      {tx.confidenceScore != null && tx.source !== "MANUAL" && <span className="text-xs text-muted-foreground">confiança {Math.round(tx.confidenceScore * 100)}%</span>}
                    </span>
                  </Row>
                  {tx.notes && <Row label="Observações">{tx.notes}</Row>}
                  <Row label="Registrado em">{formatDateTimeBR(tx.createdAt, tz)}</Row>
                  {tx.updatedAt !== tx.createdAt && <Row label="Atualizado em">{formatDateTimeBR(tx.updatedAt, tz)}</Row>}
                  {tx.deletedAt && <Row label="Excluído em">{formatDateTimeBR(tx.deletedAt, tz)}</Row>}
                </dl>
              </Section>

              {tx.installments.length > 0 && (
                <Section title={`Parcelas (${tx.installments.length})`}>
                  <ul className="divide-y rounded-xl border">
                    {tx.installments.map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium tabular">
                            {i.number}/{i.totalInstallments}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Vence {formatDateBR(i.dueDate)} ·{" "}
                            <Link href={`/cartoes?id=${tx.creditCard?.id ?? ""}&statement=${i.statementId}`} className="font-medium text-brand hover:underline">
                              fatura de {formatMonthBR(i.referenceMonth)}
                            </Link>
                          </p>
                        </div>
                        <span className="shrink-0 whitespace-nowrap font-medium tabular">{formatBRL(i.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {tx.attachments.length > 0 && (
                <Section title={`Anexos (${tx.attachments.length})`}>
                  <ul className="space-y-2">
                    {tx.attachments.map((a) => (
                      <AttachmentItem key={a.id} a={a} />
                    ))}
                  </ul>
                </Section>
              )}

              <Separator />
              <Section title="Histórico de alterações">
                <TransactionHistory history={tx.history} timezone={tz} />
              </Section>
            </div>

            <ReportExclusionDialog open={exclusionOpen} onOpenChange={setExclusionOpen} items={[tx]} />
            <DeleteTransactionsDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              count={1}
              description={`${tx.description} (${formatMoney(tx.amountCents, currency)})`}
              loading={actions.remove.isPending}
              onConfirm={() =>
                actions.remove.mutate(tx.id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    onClose();
                  },
                })
              }
            />
            <PurgeTransactionsDialog
              open={confirmPurge}
              onOpenChange={setConfirmPurge}
              count={1}
              loading={actions.purge.isPending}
              onConfirm={() =>
                actions.purge.mutate([tx.id], {
                  onSuccess: (r) => {
                    setConfirmPurge(false);
                    if (r.ok) onClose();
                  },
                })
              }
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
