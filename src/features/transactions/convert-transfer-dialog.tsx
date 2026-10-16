"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, ChevronDown, CircleMinus, Combine, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/client/api";
import { formatDateBR } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/features/finance/hooks";
import { useCan } from "@/features/me/use-me";
import { TransferAccountField, suggestInvestmentAccount } from "@/features/accounts/transfer-account-field";
import type { TransactionDTO } from "@/features/finance/types";
import { useConvertToTransfer, type ConvertPlanItem, type ConvertTransferResult } from "./use-transaction-actions";

/** Receitas e despesas em conta (fora compras no cartão) podem virar transferência. */
export function canConvertToTransfer(t: TransactionDTO): boolean {
  return (t.type === "EXPENSE" || t.type === "INCOME") && !t.creditCard && t.paymentMethod !== "CREDIT_CARD";
}

function PlanGroup({
  icon: Icon,
  tone,
  title,
  children,
  items,
  renderItem,
}: {
  icon: typeof Info;
  tone: "brand" | "info" | "muted";
  title: string;
  children?: React.ReactNode;
  items: ConvertPlanItem[];
  renderItem: (i: ConvertPlanItem) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const shown = open ? items : items.slice(0, 3);
  return (
    <section className="rounded-xl border p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", tone === "brand" ? "bg-accent text-accent-foreground" : tone === "info" ? "bg-info/10 text-info" : "bg-muted text-muted-foreground")}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        {title}
      </h3>
      {children && <div className="mt-1.5 text-xs text-muted-foreground">{children}</div>}
      <ul className="mt-2 divide-y text-sm">
        {shown.map((i) => (
          <li key={`${i.action}-${i.transactionId}`} className="flex items-start justify-between gap-3 py-1.5">
            <div className="min-w-0">
              <p className="truncate font-medium">{i.description || "—"}</p>
              <div className="mt-0.5 text-xs text-muted-foreground">{renderItem(i)}</div>
            </div>
            <span className="shrink-0 tabular">{formatBRL(i.amountCents)}</span>
          </li>
        ))}
      </ul>
      {items.length > 3 && (
        <Button type="button" variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronDown className={cn("transition", open && "rotate-180")} /> {open ? "Mostrar menos" : `Ver todos (${items.length})`}
        </Button>
      )}
    </section>
  );
}

/** Lançamentos → transferências com outra conta própria: escolhe a conta, mostra o plano (dry-run) e converte. */
export function ConvertTransferDialog({
  open,
  onOpenChange,
  items,
  lookup = [],
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  items: TransactionDTO[];
  /** Lançamentos já carregados (a página atual), para nomear o outro lado que será unido. */
  lookup?: TransactionDTO[];
  onDone: () => void;
}) {
  const accounts = useAccounts();
  const canDelete = useCan("transactions:delete");
  const preview = useConvertToTransfer();
  const run = useConvertToTransfer();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ConvertTransferResult | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAccountId(null);
    setPlan(null);
    setFieldError(null);
    setError(null);
  }, [open]);

  const eligible = items.filter(canConvertToTransfer);
  const expenses = eligible.filter((t) => t.type === "EXPENSE");
  const incomes = eligible.filter((t) => t.type === "INCOME");
  const others = items.length - eligible.length;
  const sources = [...new Set(eligible.map((t) => t.account?.id).filter(Boolean) as string[])];
  const sourceAccount = sources.length === 1 ? (accounts.data?.find((a) => a.id === sources[0]) ?? null) : null;
  const suggestion = suggestInvestmentAccount(
    eligible.map((t) => t.description),
    sourceAccount ?? (eligible[0]?.account ? { name: eligible[0].account.name, institution: null } : null),
  );
  const earliest = eligible.map((t) => t.date).sort()[0] ?? null;
  const names = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? (plan?.counterpart.id === id ? plan.counterpart.name : "outra conta")) : "sem conta");
  const sum = (list: TransactionDTO[]) => list.reduce((s, t) => s + t.amountCents, 0);
  const mirrorName = (id: string | null) => {
    const t = id ? lookup.find((x) => x.id === id) : undefined;
    return t ? `“${t.description}”, ` : "";
  };

  const loadPlan = () => {
    if (!accountId) return setFieldError("Escolha a conta do outro lado (ou crie uma conta de investimento)");
    setError(null);
    preview.mutate(
      { transactionIds: items.map((t) => t.id), counterpartAccountId: accountId, dryRun: true },
      { onSuccess: (res) => setPlan(res), onError: (e) => setError(errorMessage(e)) },
    );
  };

  const convert = () => {
    if (!accountId || !plan) return;
    setError(null);
    run.mutate(
      { transactionIds: items.map((t) => t.id), counterpartAccountId: accountId, dryRun: false },
      {
        onSuccess: () => {
          onOpenChange(false);
          onDone();
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  const converts = plan?.items.filter((i) => i.action === "CONVERT") ?? [];
  const mergedItems = plan?.items.filter((i) => i.action === "MERGE" || (i.action === "CONVERT" && i.mirrorTransactionId)) ?? [];
  const skips = plan?.items.filter((i) => i.action === "SKIP") ?? [];
  const reasons = [...skips.reduce((m, i) => m.set(i.reason ?? "Não se aplica.", (m.get(i.reason ?? "Não se aplica.") ?? 0) + 1), new Map<string, number>())];
  const actionable = (plan?.totals.convert ?? 0) + (plan?.items.filter((i) => i.action === "MERGE").length ?? 0);
  const blockedByPermission = Boolean(plan && plan.totals.merge > 0 && !canDelete);
  const busy = preview.isPending || run.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-5 text-brand" aria-hidden /> Converter em transferência
          </DialogTitle>
          <DialogDescription>
            Aplicação, resgate e transferência entre contas da família não são receita nem despesa. A despesa vira saída para a conta escolhida; a receita, entrada vinda dela.
          </DialogDescription>
        </DialogHeader>

        {!plan ? (
          <form
            id="convert-transfer-form"
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              loadPlan();
            }}
          >
            <div className="rounded-xl border bg-muted/30 p-3 text-sm">
              <p className="font-medium">{eligible.length} lançamento(s) podem virar transferência</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {expenses.length > 0 && (
                  <li>
                    {expenses.length} despesa(s) · <span className="tabular">{formatBRL(sum(expenses))}</span> → saem da conta do lançamento para a conta escolhida
                  </li>
                )}
                {incomes.length > 0 && (
                  <li>
                    {incomes.length} receita(s) · <span className="tabular">{formatBRL(sum(incomes))}</span> → entram na conta do lançamento vindas da conta escolhida
                  </li>
                )}
                {others > 0 && <li>{others} item(ns) não se aplicam (transferências, pagamentos de fatura, ajustes ou compras no cartão) e serão ignorados.</li>}
              </ul>
            </div>
            <TransferAccountField
              id="convert-transfer-account"
              value={accountId}
              onChange={(id) => {
                setAccountId(id);
                setFieldError(null);
              }}
              excludeIds={sources.length === 1 ? sources : []}
              suggestion={suggestion}
              initialBalanceDate={earliest}
              error={fieldError ?? undefined}
              hint="Antes de alterar qualquer coisa, você vê o que vai mudar."
            />
          </form>
        ) : (
          <div className="grid gap-3" aria-live="polite">
            <p className="text-sm">
              Com <strong>{plan.counterpart.name}</strong>: <strong>{plan.totals.convert}</strong> viram transferência
              {plan.totals.merge > 0 && (
                <>
                  , <strong>{plan.totals.merge}</strong> lançamento(s) repetido(s) serão unidos
                </>
              )}
              {plan.totals.skip > 0 && (
                <>
                  {" "}
                  e <strong>{plan.totals.skip}</strong> ignorado(s)
                </>
              )}
              .
            </p>
            <PlanGroup
              icon={ArrowLeftRight}
              tone="brand"
              title={`${converts.length} vira(m) transferência`}
              items={converts}
              renderItem={(i) => (
                <>
                  <span className="tabular">{formatDateBR(i.date)}</span> · {nameOf(i.fromAccountId)} <span aria-hidden>→</span>
                  <span className="sr-only">para</span> {nameOf(i.toAccountId)}
                </>
              )}
            >
              Deixam de contar como receita ou despesa; os saldos das duas contas são recalculados.
            </PlanGroup>
            <PlanGroup
              icon={Combine}
              tone="info"
              title={`${plan.totals.merge} lançamento(s) repetido(s) serão unidos`}
              items={mergedItems}
              renderItem={(i) =>
                i.action === "MERGE" ? (
                  <>A mesma transferência já está registrada: este lançamento vai para a lixeira.</>
                ) : (
                  <>
                    O outro lado ({mirrorName(i.mirrorTransactionId)}já lançado em {plan.counterpart.name}) é unido a esta transferência e vai para a lixeira.
                  </>
                )
              }
            >
              É o mesmo movimento registrado duas vezes (por exemplo, o extrato de {plan.counterpart.name} também foi importado). Para não contar em dobro, o repetido é excluído de forma
              restaurável — fica na Lixeira e a alteração aparece no histórico.
            </PlanGroup>
            <PlanGroup icon={CircleMinus} tone="muted" title={`${skips.length} ignorado(s)`} items={skips} renderItem={(i) => <>{i.reason ?? "Não se aplica."}</>}>
              {skips.length > 3 && reasons.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                  {reasons.map(([reason, n]) => (
                    <li key={reason}>
                      <Badge variant="muted" className="whitespace-normal text-left">
                        {n}× {reason}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </PlanGroup>
            {actionable === 0 && (
              <p role="status" className="flex gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> Nada a converter com esta conta. Volte e escolha outra conta ou outros lançamentos.
              </p>
            )}
            {blockedByPermission && (
              <p role="alert" className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> Unir lançamentos repetidos exige permissão para excluir lançamentos. Peça a quem administra a família.
              </p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          {!plan ? (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="submit" form="convert-transfer-form" variant="brand" loading={preview.isPending} disabled={!eligible.length}>
                Ver o que vai mudar
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPlan(null);
                  setError(null);
                }}
                disabled={busy}
              >
                Voltar
              </Button>
              <Button type="button" variant="brand" onClick={convert} loading={run.isPending} disabled={!actionable || blockedByPermission}>
                <ArrowLeftRight /> Converter{actionable ? ` ${actionable}` : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
