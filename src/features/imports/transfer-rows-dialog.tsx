"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/client/api";
import { formatDateBR } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { useAccounts } from "@/features/finance/hooks";
import { TransferAccountField, suggestInvestmentAccount } from "@/features/accounts/transfer-account-field";
import { useSetRowsTransfer } from "./use-imports";
import type { ImportPreview, ImportRowDTO } from "./types";

const SAMPLE = 4;

function CheckOption({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border p-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" aria-describedby={`${id}-hint`} />
      <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
        <span className="block font-medium">{label}</span>
        <span id={`${id}-hint`} className="block text-xs text-muted-foreground">
          {hint}
        </span>
      </label>
    </div>
  );
}

/** "Marcar como transferência": escolhe (ou cria) a conta do outro lado para linhas da prévia. */
export function TransferRowsDialog({ open, onOpenChange, preview, rows }: { open: boolean; onOpenChange: (o: boolean) => void; preview: ImportPreview; rows: ImportRowDTO[] }) {
  const accounts = useAccounts();
  const mutation = useSetRowsTransfer(preview.batch.id);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [applyToSimilar, setApplyToSimilar] = useState(true);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const statement = preview.batch.account;
  const current = [...new Set(rows.map((r) => r.transfer?.accountId ?? null))];
  const changing = rows.length > 0 && rows.every((r) => r.transfer?.accountId);

  useEffect(() => {
    if (!open) return;
    const only = current.length === 1 ? current[0] : null;
    setAccountId(only ?? null);
    setAccountName(only ? (rows[0]?.transfer?.accountName ?? null) : null);
    setApplyToSimilar(true);
    setRemember(true);
    setError(null);
    setFieldError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const statementAccount = accounts.data?.find((a) => a.id === statement?.id) ?? null;
  const suggestion = suggestInvestmentAccount(
    rows.map((r) => r.description),
    statementAccount ?? (statement ? { name: statement.name, institution: null } : null),
  );
  const outs = rows.filter((r) => (r.amountCents ?? 0) < 0);
  const ins = rows.filter((r) => (r.amountCents ?? 0) > 0);
  const sum = (list: ImportRowDTO[]) => list.reduce((s, r) => s + Math.abs(r.amountCents ?? 0), 0);
  const earliest = rows.map((r) => r.date).filter(Boolean).sort()[0] ?? null;
  const target = accountName ?? "a conta escolhida";

  const submit = () => {
    if (!accountId) return setFieldError("Escolha a conta do outro lado (ou crie uma conta de investimento)");
    setError(null);
    mutation.mutate(
      { rowIds: rows.map((r) => r.id), transferAccountId: accountId, applyToSimilar, remember, accountName },
      { onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-5 text-brand" aria-hidden /> {changing ? "Trocar a conta da transferência" : "Marcar como transferência"}
          </DialogTitle>
          <DialogDescription>
            Aplicação, resgate e transferência entre contas da família não são receita nem despesa: o dinheiro só muda de conta. Escolha a conta do outro lado.
          </DialogDescription>
        </DialogHeader>

        <form
          id="import-transfer-form"
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="rounded-xl border bg-muted/30 p-3 text-sm">
            {rows.length === 1 && rows[0] ? (
              <>
                <p className="break-words font-medium">{rows[0].description ?? "—"}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span className="tabular">{rows[0].date ? formatDateBR(rows[0].date) : "Sem data"}</span> · <span className="tabular">{formatBRL(rows[0].amountCents ?? 0, { signed: true })}</span>
                </p>
                <p className="mt-2 text-xs">
                  {(rows[0].amountCents ?? 0) < 0 ? (
                    <>
                      Sai de <strong>{statement?.name}</strong> <span aria-hidden>→</span> vai para <strong>{target}</strong>
                    </>
                  ) : (
                    <>
                      Vem de <strong>{target}</strong> <span aria-hidden>→</span> entra em <strong>{statement?.name}</strong>
                    </>
                  )}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">{rows.length} linha(s)</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {outs.length > 0 && (
                    <li>
                      {outs.length} saída(s) de {statement?.name} para {target}: <span className="tabular">{formatBRL(sum(outs))}</span>
                    </li>
                  )}
                  {ins.length > 0 && (
                    <li>
                      {ins.length} entrada(s) em {statement?.name} vindas de {target}: <span className="tabular">{formatBRL(sum(ins))}</span>
                    </li>
                  )}
                </ul>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {rows.slice(0, SAMPLE).map((r) => (
                    <li key={r.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">{r.description ?? "—"}</span>
                      <span className="shrink-0 tabular">{formatBRL(r.amountCents ?? 0, { signed: true })}</span>
                    </li>
                  ))}
                  {rows.length > SAMPLE && <li className="text-muted-foreground">e mais {rows.length - SAMPLE}…</li>}
                </ul>
              </>
            )}
          </div>

          <TransferAccountField
            id="import-transfer-account"
            value={accountId}
            onChange={(id, acc) => {
              setAccountId(id);
              setAccountName(acc?.name ?? null);
              setFieldError(null);
            }}
            excludeIds={statement ? [statement.id] : []}
            suggestion={suggestion}
            initialBalanceDate={earliest}
            error={fieldError ?? undefined}
          />

          <div className="grid gap-2">
            <CheckOption
              id="import-transfer-similar"
              checked={applyToSimilar}
              onChange={setApplyToSimilar}
              label="Aplicar às linhas parecidas deste arquivo"
              hint="Mesma descrição (sem contar números e códigos) e mesmo sentido — entrada ou saída."
            />
            <CheckOption
              id="import-transfer-remember"
              checked={remember}
              onChange={setRemember}
              label="Lembrar para as próximas importações"
              hint="Cria uma regra: os próximos extratos (e o WhatsApp) já tratam essas movimentações como transferência. Dá para editar em Categorias → Regras."
            />
          </div>

          {error && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button type="submit" form="import-transfer-form" variant="brand" loading={mutation.isPending}>
            <ArrowLeftRight /> {changing ? "Salvar conta" : "Marcar como transferência"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
