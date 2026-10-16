"use client";

import { useEffect, useMemo, useState } from "react";
import { EyeOff, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateBR } from "@/lib/dates";
import { formatBRL, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ExclusionReason, TransactionDTO } from "@/features/finance/types";
import {
  EXCLUSION_KEEPS_BALANCE,
  EXCLUSION_REASONS,
  EXCLUSION_REASON_HINTS,
  EXCLUSION_REASON_LABELS,
  EXCLUSION_SCOPE,
  canExcludeFromReports,
  matchParties,
  useExclusionParties,
  useReportExclusion,
} from "./report-exclusion";

export const PARTY_LABELS: Record<ExclusionReason, string> = {
  CLIENT_PASSTHROUGH: "Cliente",
  REIMBURSEMENT: "Quem reembolsa",
  OTHER: "Pessoa ou empresa",
};

const brl = (t: TransactionDTO) => (!t.currency || t.currency === "BRL" ? t.amountCents : (t.amountBrlCents ?? 0));

/** Valor comum a todos (ou null quando diferem). */
function common<T>(list: T[]): T | null {
  if (!list.length) return null;
  const first = list[0]!;
  return list.every((v) => v === first) ? first : null;
}

/** Sugestões de cliente/pessoa já usados, como botões (funciona bem no celular). */
export function PartySuggestions({ value, onPick, enabled = true }: { value: string; onPick: (v: string) => void; enabled?: boolean }) {
  const parties = useExclusionParties(enabled);
  const suggestions = matchParties(parties.data, value);
  if (!suggestions.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Clientes já usados">
      <span className="text-xs text-muted-foreground">Já usados:</span>
      {suggestions.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          className="inline-flex h-7 max-w-full items-center rounded-full border bg-card px-2.5 text-xs font-medium text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <span className="truncate">{p}</span>
        </button>
      ))}
    </div>
  );
}

/** Escolha do motivo: botões em linha e a explicação do escolhido logo abaixo. */
export function ExclusionReasonPicker({ value, onChange, idPrefix }: { value: ExclusionReason; onChange: (r: ExclusionReason) => void; idPrefix: string }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby={`${idPrefix}-reason-label`}>
        {EXCLUSION_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={value === r}
            onClick={() => onChange(r)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
              value === r ? "border-brand bg-accent text-accent-foreground" : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {value === r && <span aria-hidden>✓</span>}
            {EXCLUSION_REASON_LABELS[r]}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{EXCLUSION_REASON_HINTS[value]}</p>
    </div>
  );
}

/**
 * "Desconsiderar nos relatórios" (um ou vários lançamentos). Também edita motivo, cliente e
 * observação de quem já está desconsiderado. Nunca muda saldo, fatura ou projeção.
 */
export function ReportExclusionDialog({ open, onOpenChange, items, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; items: TransactionDTO[]; onDone?: () => void }) {
  const mutation = useReportExclusion();
  const eligible = useMemo(() => items.filter(canExcludeFromReports), [items]);
  const ignored = items.length - eligible.length;
  const already = eligible.filter((t) => t.excludedFromReports);
  const bulk = items.length > 1;

  const initial = useMemo(() => {
    const ex = eligible.filter((t) => t.excludedFromReports).map((t) => t.exclusion);
    const allExcluded = eligible.length > 0 && ex.length === eligible.length;
    return {
      /** Todos já desconsiderados: o diálogo edita motivo/cliente/observação. */
      editing: allExcluded,
      reason: (allExcluded ? common(ex.map((e) => e?.reason ?? "OTHER")) : null) ?? "CLIENT_PASSTHROUGH",
      party: (allExcluded ? common(ex.map((e) => e?.party ?? "")) : null) ?? "",
      note: (allExcluded ? common(ex.map((e) => e?.note ?? "")) : null) ?? "",
    } as { editing: boolean; reason: ExclusionReason; party: string; note: string };
    // Recalcula só ao abrir (a lista muda depois de salvar).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const [reason, setReason] = useState<ExclusionReason>("CLIENT_PASSTHROUGH");
  const [party, setParty] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open) return;
    setReason(initial.reason);
    setParty(initial.party);
    setNote(initial.note);
  }, [open, initial]);

  // Em lote, campo em branco que já começou em branco mantém o que cada lançamento já tem.
  const someHaveParty = already.some((t) => t.exclusion?.party);
  const someHaveNote = already.some((t) => t.exclusion?.note);
  const resolve = (value: string, start: string, someHave: boolean): string | null | undefined => {
    const v = value.trim();
    if (v) return v;
    if (bulk && !start && someHave) return undefined;
    return null;
  };

  const incomes = eligible.filter((t) => t.type === "INCOME");
  const expenses = eligible.filter((t) => t.type === "EXPENSE");
  const sum = (list: TransactionDTO[]) => list.reduce((s, t) => s + brl(t), 0);
  const single = items.length === 1 ? items[0] : undefined;
  const busy = mutation.isPending;
  const editing = initial.editing;

  const submit = () => {
    if (!eligible.length) return;
    mutation.mutate(
      {
        transactionIds: eligible.map((t) => t.id),
        excluded: true,
        reason,
        party: resolve(party, initial.party, someHaveParty),
        note: resolve(note, initial.note, someHaveNote),
        editing,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          onDone?.();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <EyeOff className="size-5 text-brand" aria-hidden /> {editing ? "Editar desconsideração" : "Desconsiderar nos relatórios"}
          </DialogTitle>
          <DialogDescription>
            {single
              ? single.type === "INCOME"
                ? "Esta entrada deixa de contar como receita da família."
                : "Esta saída deixa de contar como despesa da família."
              : "Os lançamentos escolhidos deixam de contar como receita ou despesa da família."}
          </DialogDescription>
        </DialogHeader>

        <form
          id="report-exclusion-form"
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {single ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border bg-muted/30 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{single.description}</p>
                <p className="text-xs text-muted-foreground">{formatDateBR(single.date)}</p>
              </div>
              <span className="shrink-0 font-semibold tabular">{formatMoney(single.amountCents, single.currency)}</span>
            </div>
          ) : (
            <div className="rounded-xl border bg-muted/30 p-3 text-sm">
              <p className="font-medium">
                {eligible.length} {eligible.length === 1 ? "lançamento" : "lançamentos"}
                {already.length > 0 && !editing && <span className="font-normal text-muted-foreground"> ({already.length} já desconsiderado(s): motivo e cliente serão atualizados)</span>}
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {incomes.length > 0 && (
                  <li>
                    {incomes.length} {incomes.length === 1 ? "receita" : "receitas"} · <span className="tabular">{formatBRL(sum(incomes))}</span>
                  </li>
                )}
                {expenses.length > 0 && (
                  <li>
                    {expenses.length} {expenses.length === 1 ? "despesa" : "despesas"} · <span className="tabular">{formatBRL(sum(expenses))}</span>
                  </li>
                )}
                {ignored > 0 && <li>{ignored} item(ns) não se aplicam (transferências, pagamentos de fatura, ajustes ou excluídos) e serão ignorados.</li>}
              </ul>
            </div>
          )}

          {eligible.length === 0 ? (
            <p role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              Só receitas e despesas podem ser desconsideradas. Transferências e pagamentos de fatura já não contam como receita nem despesa.
            </p>
          ) : (
            <>
              <div className="grid gap-1.5">
                <p id="rx-reason-label" className="text-[13px] font-medium">
                  Motivo
                </p>
                <ExclusionReasonPicker idPrefix="rx" value={reason} onChange={setReason} />
              </div>

              <Field
                label={`${PARTY_LABELS[reason]}${reason === "CLIENT_PASSTHROUGH" ? "" : " (opcional)"}`}
                htmlFor="rx-party"
                hint={
                  reason === "CLIENT_PASSTHROUGH"
                    ? bulk && someHaveParty && !initial.party
                      ? "Agrupa o saldo do repasse por cliente. Em branco: mantém o cliente já informado em cada lançamento."
                      : "Agrupa o saldo do repasse por cliente: quanto ele pagou e quanto foi gasto para ele."
                    : bulk && someHaveParty && !initial.party
                      ? "Em branco: mantém o que já está em cada lançamento."
                      : undefined
                }
              >
                <Input
                  id="rx-party"
                  value={party}
                  onChange={(e) => setParty(e.target.value)}
                  maxLength={80}
                  autoComplete="off"
                  placeholder={reason === "CLIENT_PASSTHROUGH" ? "Ex.: Agência Alfa" : "Ex.: Maria"}
                />
                <PartySuggestions value={party} onPick={setParty} enabled={open} />
              </Field>

              <Field label="Observação (opcional)" htmlFor="rx-note" hint={bulk && someHaveNote && !initial.note ? "Em branco: mantém a observação já informada em cada lançamento." : undefined}>
                <Input id="rx-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} autoComplete="off" placeholder="Ex.: campanha de outubro" />
              </Field>

              <p className="flex gap-2 rounded-lg bg-info/10 px-3 py-2.5 text-xs text-info">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  <strong className="font-semibold">{EXCLUSION_KEEPS_BALANCE}</strong> {EXCLUSION_SCOPE} Dá para voltar a considerar quando quiser.
                </span>
              </p>
            </>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form="report-exclusion-form" variant="brand" loading={busy} disabled={!eligible.length}>
            <EyeOff /> {editing ? "Salvar" : eligible.length > 1 ? `Desconsiderar ${eligible.length}` : "Desconsiderar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
