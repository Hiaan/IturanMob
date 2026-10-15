"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArchiveRestore, ArrowLeft, CheckCircle2, ExternalLink, FileText, ImageOff, Info, Mic, PencilLine, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ErrorState } from "@/components/shared/error-state";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDateTimeBR, formatMonthBR } from "@/lib/dates";
import { OWNERSHIP_LABELS, PAYMENT_METHOD_LABELS, TRANSACTION_SOURCE_LABELS, TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/features/me/use-me";
import { TransactionForm } from "./transaction-form";
import { TransactionHistory } from "./transaction-history";
import { AmountText, PendingBadge, SourceTag, TransactionIcon, categoryLabel } from "./transaction-visuals";
import { useTransactionActions, useTransactionDetail, type TransactionDetail } from "./use-transaction-actions";
import { DeleteTransactionsDialog, PurgeTransactionsDialog } from "./confirm-dialogs";

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

/** Painel lateral com todos os dados, parcelas, anexos, histórico e ações de uma transação. */
export function TransactionDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useTransactionDetail(id);
  const me = useMe();
  const tz = me.data?.household.timezone;
  const canWrite = useCan("transactions:write");
  const canDelete = useCan("transactions:delete");
  const actions = useTransactionActions();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const tx = q.data;

  useEffect(() => {
    setEditing(false);
  }, [id]);

  const deleted = Boolean(tx?.deletedAt);
  const editable = tx && EDITABLE_TYPES.has(tx.type) && !deleted && canWrite;

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
                <AmountText tx={tx} className="text-2xl tracking-tight" />
                {tx.status === "PENDING" && <PendingBadge />}
                {deleted && (
                  <Badge variant="negative">
                    <Trash2 aria-hidden /> Na lixeira
                  </Badge>
                )}
              </div>
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
                                <span className="tabular">{formatBRL(a.amountCents)}</span>
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
                        <span className="font-medium tabular">{formatBRL(i.amountCents)}</span>
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

            <DeleteTransactionsDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              count={1}
              description={`${tx.description} (${formatBRL(tx.amountCents)})`}
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
