"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Briefcase,
  CheckCheck,
  CheckCircle2,
  Copy,
  CreditCard,
  FileWarning,
  HelpCircle,
  Inbox,
  MessageCircleQuestion,
  Pencil,
  RotateCcw,
  Tags,
  Trash2,
  Upload,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDateTimeBR } from "@/lib/dates";
import { PENDING_TYPE_LABELS, TRANSACTION_SOURCE_LABELS, labelOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useCategories } from "@/features/finance/hooks";
import type { TransactionDTO, TransactionNature } from "@/features/finance/types";
import { TransactionForm } from "@/features/transactions/transaction-form";
import { useCan } from "@/features/me/use-me";
import { NewCategoryOption, QuickCategoryDialog } from "@/features/categories/quick-category-dialog";
import { useQuickCategoryOption } from "@/features/categories/use-quick-category";
import { NATURES, NATURE_KEEPS_BALANCE, NATURE_LABELS, useSetNature } from "@/features/transactions/nature";
import { NATURE_ICONS } from "@/features/transactions/nature-control";
import { ReportExclusionDialog } from "@/features/transactions/report-exclusion-dialog";

interface PendingTx {
  id: string;
  type: string;
  status: string;
  amountCents: number;
  description: string;
  date: string;
  categoryId: string | null;
  paymentMethod: string | null;
  accountId: string | null;
  creditCardId: string | null;
  installmentCount: number;
  deletedAt: string | null;
  confidenceScore: number | null;
  source: string;
}

interface PendingItemDTO {
  id: string;
  type: keyof typeof PENDING_TYPE_LABELS;
  status: string;
  title: string;
  description: string | null;
  createdAt: string;
  transaction: PendingTx | null;
  relatedTransaction: { id: string; amountCents: number; description: string; date: string; type: string; deletedAt: string | null; source: string } | null;
  message: { id: string; type: string; status: string; sentAt: string; statusDetail: string | null } | null;
  attachment: { id: string; kind: string; mimeType: string; contentDeletedAt: string | null } | null;
  importRow: { id: string; batchId: string; date: string | null; amountCents: number | null; description: string | null; status: string } | null;
}

const TYPE_ICONS: Record<string, LucideIcon> = {
  CONFIRMATION: CheckCircle2,
  UNCATEGORIZED: Tags,
  MISSING_PAYMENT_METHOD: CreditCard,
  POSSIBLE_DUPLICATE: Copy,
  UNREADABLE_RECEIPT: FileWarning,
  PROCESSING_FAILED: AlertTriangle,
  IMPORT_DIVERGENCE: Upload,
  INSTALLMENT_INCONSISTENT: CreditCard,
  CLARIFICATION: MessageCircleQuestion,
  NATURE_REVIEW: Briefcase,
};

const ORDER = ["CONFIRMATION", "POSSIBLE_DUPLICATE", "CLARIFICATION", "NATURE_REVIEW", "PROCESSING_FAILED", "UNREADABLE_RECEIPT", "MISSING_PAYMENT_METHOD", "UNCATEGORIZED", "IMPORT_DIVERGENCE", "INSTALLMENT_INCONSISTENT"];

/** Pendência "Escolher natureza" com o lançamento ainda ativo. */
const isNatureItem = (i: PendingItemDTO) => i.type === "NATURE_REVIEW" && Boolean(i.transaction) && !i.transaction!.deletedAt;

function useInvalidate() {
  const qc = useQueryClient();
  return () => ["pending", "transactions", "accounts", "cards", "analytics", "me", "budgets", "reports"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

function CategoryPicker({ tx, onDone }: { tx: PendingTx; onDone: () => void }) {
  const categories = useCategories();
  const invalidate = useInvalidate();
  const [value, setValue] = useState("");
  const kind = tx.type === "INCOME" ? "INCOME" : "EXPENSE";
  const save = useMutation({
    mutationFn: (v: string) => api.patch(`/api/v1/transactions/${tx.id}`, v.startsWith("sub:") ? { subcategoryId: v.slice(4) } : { categoryId: v.slice(4), subcategoryId: null }),
    onSuccess: () => {
      toast.success("Categoria definida");
      invalidate();
      onDone();
    },
    onError: (e) => {
      setValue("");
      toast.error(errorMessage(e));
    },
  });
  const choose = (v: string) => {
    setValue(v);
    save.mutate(v);
  };
  const quick = useQuickCategoryOption((r) => choose(r.subcategoryId ? `sub:${r.subcategoryId}` : `cat:${r.categoryId}`));
  return (
    <>
      <Select
        value={value}
        onValueChange={(v) => {
          if (!quick.intercept(v)) choose(v);
        }}
        disabled={save.isPending}
      >
        <SelectTrigger ref={quick.triggerRef} className="h-9 w-full sm:w-64" aria-label="Escolher categoria">
          <SelectValue placeholder="Escolher categoria…" />
        </SelectTrigger>
        <SelectContent>
          {(categories.data ?? [])
            .filter((c) => c.kind === kind && !c.archivedAt)
            .map((c) => (
              <SelectGroup key={c.id}>
                <SelectLabel>{c.name}</SelectLabel>
                <SelectItem value={`cat:${c.id}`}>{c.name} (geral)</SelectItem>
                {c.subcategories
                  .filter((s) => !s.archivedAt)
                  .map((s) => (
                    <SelectItem key={s.id} value={`sub:${s.id}`}>
                      {c.name} › {s.name}
                    </SelectItem>
                  ))}
              </SelectGroup>
            ))}
          {quick.canCreate && <NewCategoryOption />}
        </SelectContent>
      </Select>
      {quick.canCreate && <QuickCategoryDialog {...quick.dialog} kind={kind} />}
    </>
  );
}

/** Pessoal / Empresa (na hora) / Repasse… (abre o diálogo de motivo e cliente). */
function NatureButtons({ txId, onPassthrough }: { txId: string; onPassthrough: (ids: string[]) => void }) {
  const setNature = useSetNature();
  const canWrite = useCan("transactions:write");
  if (!canWrite) return <p className="text-xs text-muted-foreground">Quem pode editar lançamentos escolhe a natureza.</p>;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Escolher natureza">
      {NATURES.map((n) => {
        const Icon = NATURE_ICONS[n];
        return (
          <Button
            key={n}
            size="sm"
            variant="outline"
            loading={setNature.isPending && setNature.variables?.nature === n}
            disabled={setNature.isPending}
            onClick={() => (n === "PASSTHROUGH" ? onPassthrough([txId]) : setNature.mutate({ transactionIds: [txId], nature: n as TransactionNature }))}
          >
            <Icon className={n === "BUSINESS" ? "text-series-7" : undefined} /> {n === "PASSTHROUGH" ? "Repasse…" : NATURE_LABELS[n]}
          </Button>
        );
      })}
    </div>
  );
}

function PendingCard({
  item,
  selected,
  onSelect,
  onEdit,
  onPassthrough,
}: {
  item: PendingItemDTO;
  selected: boolean;
  onSelect: (v: boolean) => void;
  onEdit: (txId: string | null) => void;
  onPassthrough: (txIds: string[]) => void;
}) {
  const invalidate = useInvalidate();
  const Icon = TYPE_ICONS[item.type] ?? HelpCircle;
  const tx = item.transaction;

  const run = useMutation({
    mutationFn: async (action: "confirm" | "discardTx" | "dismiss" | "resolve" | "reprocess") => {
      if (action === "confirm" && tx) return api.post(`/api/v1/transactions/${tx.id}/confirm`);
      if (action === "discardTx" && tx) return api.delete(`/api/v1/transactions/${tx.id}`);
      if (action === "reprocess" && item.message) return api.post(`/api/v1/integrations/whatsapp/messages/${item.message.id}/reprocess`);
      return api.patch(`/api/v1/pending/${item.id}`, { status: action === "dismiss" ? "DISMISSED" : "RESOLVED" });
    },
    onSuccess: (_d, action) => {
      toast.success(
        action === "confirm" ? "Lançamento confirmado" : action === "discardTx" ? "Lançamento descartado (pode ser restaurado na lixeira)" : action === "reprocess" ? "Mensagem enviada para reprocessamento" : "Pendência atualizada",
      );
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card className={cn("p-4 transition", selected && "ring-2 ring-ring/40")}>
      <div className="flex items-start gap-3">
        <Checkbox checked={selected} onCheckedChange={(v) => onSelect(Boolean(v))} aria-label="Selecionar pendência" className="mt-1" />
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted">{labelOf(PENDING_TYPE_LABELS, item.type)}</Badge>
            <span className="text-xs text-muted-foreground">{formatDateTimeBR(item.createdAt)}</span>
          </div>
          <p className="mt-1.5 font-medium">{item.title}</p>
          {item.description && <p className="mt-0.5 text-sm text-muted-foreground">{item.description}</p>}

          {tx && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{tx.description}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateBR(tx.date)} · {labelOf(TRANSACTION_SOURCE_LABELS, tx.source)}
                  {tx.installmentCount > 1 && ` · ${tx.installmentCount}x`}
                  {tx.confidenceScore !== null && ` · confiança ${Math.round(tx.confidenceScore * 100)}%`}
                  {tx.deletedAt && " · excluído"}
                </p>
              </div>
              <span className="font-semibold tabular">{formatBRL(tx.amountCents)}</span>
            </div>
          )}
          {item.type === "POSSIBLE_DUPLICATE" && item.relatedTransaction && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Lançamento já existente</p>
                <p className="truncate">{item.relatedTransaction.description}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateBR(item.relatedTransaction.date)} · {labelOf(TRANSACTION_SOURCE_LABELS, item.relatedTransaction.source)}
                </p>
              </div>
              <span className="tabular">{formatBRL(item.relatedTransaction.amountCents)}</span>
            </div>
          )}
          {item.message?.statusDetail && <p className="mt-2 text-xs text-muted-foreground">Detalhe: {item.message.statusDetail}</p>}
          {item.attachment && item.attachment.kind === "IMAGE" && !item.attachment.contentDeletedAt && (
            <a href={`/api/v1/attachments/${item.attachment.id}`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/v1/attachments/${item.attachment.id}`} alt="Comprovante recebido" className="h-28 rounded-lg border object-cover" />
            </a>
          )}
          {item.attachment && item.attachment.kind === "AUDIO" && !item.attachment.contentDeletedAt && <audio controls src={`/api/v1/attachments/${item.attachment.id}`} className="mt-2 h-10 w-full max-w-sm" />}
          {item.importRow && (
            <p className="mt-2 text-sm">
              Linha importada: {item.importRow.description} · {item.importRow.amountCents !== null ? formatBRL(Math.abs(item.importRow.amountCents)) : "—"} ·{" "}
              {item.importRow.date ? formatDateBR(item.importRow.date) : "sem data"}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {item.type === "CONFIRMATION" && tx && !tx.deletedAt && (
              <>
                <Button size="sm" variant="brand" onClick={() => run.mutate("confirm")} loading={run.isPending && run.variables === "confirm"}>
                  <CheckCircle2 /> Confirmar
                </Button>
                <Button size="sm" variant="outline" onClick={() => onEdit(tx.id)}>
                  <Pencil /> Editar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => run.mutate("discardTx")}>
                  <XCircle /> Descartar
                </Button>
              </>
            )}
            {item.type === "POSSIBLE_DUPLICATE" && tx && !tx.deletedAt && (
              <>
                <Button size="sm" variant="brand" onClick={() => run.mutate("confirm")}>
                  <CheckCircle2 /> É um novo lançamento
                </Button>
                <Button size="sm" variant="outline" onClick={() => run.mutate("discardTx")}>
                  <Trash2 /> É duplicado — descartar
                </Button>
              </>
            )}
            {item.type === "NATURE_REVIEW" && tx && !tx.deletedAt && (
              <div className="grid gap-1.5">
                <NatureButtons txId={tx.id} onPassthrough={onPassthrough} />
                <p className="text-xs text-muted-foreground">{NATURE_KEEPS_BALANCE}</p>
              </div>
            )}
            {item.type === "UNCATEGORIZED" && tx && <CategoryPicker tx={tx} onDone={() => undefined} />}
            {(item.type === "MISSING_PAYMENT_METHOD" || item.type === "INSTALLMENT_INCONSISTENT") && tx && (
              <Button size="sm" variant="outline" onClick={() => onEdit(tx.id)}>
                <Pencil /> Completar lançamento
              </Button>
            )}
            {(item.type === "PROCESSING_FAILED" || item.type === "UNREADABLE_RECEIPT" || item.type === "CLARIFICATION") && (
              <>
                {item.message && (
                  <Button size="sm" variant="outline" onClick={() => run.mutate("reprocess")} loading={run.isPending && run.variables === "reprocess"}>
                    <RotateCcw /> Reprocessar
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onEdit(null)}>
                  <Pencil /> Registrar manualmente
                </Button>
              </>
            )}
            {item.type === "IMPORT_DIVERGENCE" && item.importRow && (
              <Button size="sm" variant="outline" asChild>
                <Link href={`/importacao?batch=${item.importRow.batchId}`}>
                  <Upload /> Ver conciliação
                </Link>
              </Button>
            )}
            {item.type !== "CONFIRMATION" && item.type !== "POSSIBLE_DUPLICATE" && !(item.type === "NATURE_REVIEW" && tx && !tx.deletedAt) && (
              <Button size="sm" variant="ghost" onClick={() => run.mutate(item.type === "UNCATEGORIZED" || item.type === "MISSING_PAYMENT_METHOD" ? "dismiss" : "resolve")}>
                <CheckCheck /> {item.type === "UNCATEGORIZED" || item.type === "MISSING_PAYMENT_METHOD" ? "Ignorar" : "Marcar como resolvida"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function PendingView() {
  const [type, setType] = useState<string | "ALL">("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ txId: string | null } | null>(null);
  /** Lançamentos no diálogo de Repasse (motivo, cliente, observação). */
  const [repasse, setRepasse] = useState<TransactionDTO[]>([]);
  const [repasseOpen, setRepasseOpen] = useState(false);
  const qc = useQueryClient();
  const setNature = useSetNature();
  const invalidate = useInvalidate();
  const openPassthrough = async (txIds: string[]) => {
    try {
      const list = await Promise.all(
        txIds.map((id) => qc.fetchQuery({ queryKey: qk.transaction(id), queryFn: () => api.get<TransactionDTO>(`/api/v1/transactions/${id}`), staleTime: 10_000 })),
      );
      setRepasse(list);
      setRepasseOpen(true);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const counts = useQuery({ queryKey: qk.pendingCounts, queryFn: () => api.get<{ total: number; byType: Record<string, number> }>("/api/v1/pending/counts") });
  // Filtro por tipo no servidor (inclui "Escolher natureza" / NATURE_REVIEW).
  const serverType = type === "ALL" ? null : type;
  const list = useQuery({
    queryKey: qk.pending({ type }),
    queryFn: () => api.get<{ items: PendingItemDTO[] }>("/api/v1/pending", serverType ? { type: serverType, limit: 200 } : { limit: 200 }),
  });
  const editTx = useQuery({
    queryKey: qk.transaction(editing?.txId ?? "none"),
    queryFn: () => api.get<TransactionDTO>(`/api/v1/transactions/${editing!.txId}`),
    enabled: Boolean(editing?.txId),
  });

  const items = useMemo(
    () => [...(list.data?.items ?? [])].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)),
    [list.data],
  );
  const selectedItems = items.filter((i) => selected.has(i.id));
  const confirmable = selectedItems.filter((i) => (i.type === "CONFIRMATION" || i.type === "POSSIBLE_DUPLICATE") && i.transaction && !i.transaction.deletedAt);
  const natureSelected = selectedItems.filter(isNatureItem);
  const canWriteTx = useCan("transactions:write");

  const bulk = useMutation({
    mutationFn: async (action: "confirm" | "dismiss") => {
      if (action === "confirm") {
        await api.post("/api/v1/transactions/bulk", { action: "confirm", ids: confirmable.map((i) => i.transaction!.id) });
      } else {
        // "Escolher natureza" descartada = fica como Pessoal (tira a marca do lançamento e resolve a pendência).
        const natureIds = selectedItems.filter(isNatureItem).map((i) => i.transaction!.id);
        if (natureIds.length) await api.post("/api/v1/transactions/nature", { transactionIds: natureIds, nature: "PERSONAL" });
        for (const i of selectedItems) if (!isNatureItem(i)) await api.patch(`/api/v1/pending/${i.id}`, { status: "DISMISSED" });
      }
    },
    onSuccess: (_d, action) => {
      const kept = selectedItems.filter(isNatureItem).length;
      toast.success(action === "confirm" ? `${confirmable.length} lançamento(s) confirmado(s)` : `${selectedItems.length} pendência(s) descartada(s)`, {
        description: action === "dismiss" && kept ? `${kept} “Escolher natureza” ficaram como Pessoal.` : undefined,
      });
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const byType = counts.data?.byType ?? {};
  const tabs = ORDER.filter((t) => byType[t]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pendências"
        description="Lançamentos e mensagens que precisam da sua atenção. Nada é descartado sem a sua decisão."
        actions={
          selectedItems.length > 0 && (
            <>
              <span className="text-sm text-muted-foreground">{selectedItems.length} selecionada(s)</span>
              {confirmable.length > 0 && (
                <Button variant="brand" size="sm" onClick={() => bulk.mutate("confirm")} loading={bulk.isPending && bulk.variables === "confirm"}>
                  <CheckCheck /> Confirmar {confirmable.length}
                </Button>
              )}
              {natureSelected.length > 0 &&
                canWriteTx &&
                NATURES.map((n) => {
                  const Icon = NATURE_ICONS[n];
                  const ids = natureSelected.map((i) => i.transaction!.id);
                  return (
                    <Button
                      key={n}
                      variant="outline"
                      size="sm"
                      disabled={setNature.isPending}
                      loading={setNature.isPending && setNature.variables?.nature === n}
                      onClick={() =>
                        n === "PASSTHROUGH" ? openPassthrough(ids) : setNature.mutate({ transactionIds: ids, nature: n }, { onSuccess: () => setSelected(new Set()) })
                      }
                    >
                      <Icon /> {n === "PASSTHROUGH" ? "Repasse…" : NATURE_LABELS[n]} ({ids.length})
                    </Button>
                  );
                })}
              <Button variant="outline" size="sm" onClick={() => bulk.mutate("dismiss")} loading={bulk.isPending && bulk.variables === "dismiss"}>
                Descartar pendências
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Tipos de pendência">
        <button
          type="button"
          role="tab"
          aria-selected={type === "ALL"}
          onClick={() => setType("ALL")}
          className={cn("rounded-full border px-3 py-1.5 text-sm font-medium transition", type === "ALL" ? "border-transparent bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
        >
          Todas {counts.data ? `(${counts.data.total})` : ""}
        </button>
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={type === t}
            onClick={() => setType(t)}
            className={cn("rounded-full border px-3 py-1.5 text-sm font-medium transition", type === t ? "border-transparent bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
          >
            {labelOf(PENDING_TYPE_LABELS, t)} ({byType[t]})
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !items.length ? (
        <EmptyState icon={Inbox} title="Tudo em dia" description="Não há pendências abertas. Lançamentos que precisarem de confirmação ou mensagens não processadas aparecerão aqui." />
      ) : (
        <div className={cn("space-y-3 transition-opacity", list.isFetching && "opacity-70")}>
          {items.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={selected.size === items.length}
                onCheckedChange={(v) => setSelected(v ? new Set(items.map((i) => i.id)) : new Set())}
                aria-label="Selecionar todas"
              />
              Selecionar todas
            </label>
          )}
          {items.map((item) => (
            <PendingCard
              key={item.id}
              item={item}
              selected={selected.has(item.id)}
              onSelect={(v) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (v) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                })
              }
              onEdit={(txId) => setEditing({ txId })}
              onPassthrough={openPassthrough}
            />
          ))}
        </div>
      )}

      <ReportExclusionDialog open={repasseOpen} onOpenChange={setRepasseOpen} items={repasse} onDone={() => setSelected(new Set())} />
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing?.txId ? "Completar lançamento" : "Registrar manualmente"}</DialogTitle>
            <DialogDescription>{editing?.txId ? "Ajuste os dados e salve. Depois confirme o lançamento, se estiver pendente." : "Cadastre o lançamento a partir das informações da mensagem."}</DialogDescription>
          </DialogHeader>
          {editing?.txId ? (
            editTx.data ? (
              <TransactionForm transaction={editTx.data} onSaved={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
            ) : (
              <Skeleton className="h-96" />
            )
          ) : (
            editing && <TransactionForm onSaved={() => { setEditing(null); invalidate(); }} onCancel={() => setEditing(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
