"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { formatDateBR, formatDayMonthBR } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { useAccounts } from "@/features/finance/hooks";
import type { AccountDTO } from "@/features/finance/types";
import { TransferAccountField, suggestInvestmentAccount } from "@/features/accounts/transfer-account-field";
import { describeExchange, formatRate, isForeignCurrency } from "@/features/accounts/currency";
import { needsCounterpartAmount } from "./helpers";
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
  const [chosen, setChosen] = useState<AccountDTO | null>(null);
  const [counterpart, setCounterpart] = useState(0);
  const [amountError, setAmountError] = useState<string | null>(null);
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
    setChosen(null);
    // Valor na outra moeda já informado nesta linha (editar sem digitar de novo).
    setCounterpart(rows.length === 1 && only ? (rows[0]?.transfer?.counterpartAmountCents ?? 0) : 0);
    setAmountError(null);
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

  // Contas de moedas diferentes (ex.: C6 em reais → Wise em dólar): o valor do outro lado é informado linha a linha.
  const statementCurrency = statementAccount?.currency ?? "BRL";
  // A conta recém-criada no campo ainda pode não estar na lista.
  const chosenAccount = accounts.data?.find((a) => a.id === accountId) ?? (chosen?.id === accountId ? chosen : null);
  const otherCurrency = chosenAccount?.currency ?? "BRL";
  const crossCurrency = Boolean(chosenAccount) && otherCurrency !== statementCurrency;
  const single = rows.length === 1 ? rows[0]! : null;
  const askAmount = crossCurrency && Boolean(single);
  const rowCents = Math.abs(single?.amountCents ?? 0);
  const rowOut = (single?.amountCents ?? 0) < 0;
  const exchange = askAmount ? describeExchange({ cents: rowCents, currency: statementCurrency }, { cents: counterpart, currency: otherCurrency }) : null;
  // Referência: a do servidor (PTAX da data da linha) quando a linha já espera o valor nesta conta;
  // senão, a PTAX mais recente da conta em moeda estrangeira. O câmbio real da operação pode ser outro.
  const serverReference = single && needsCounterpartAmount(single) && single.transfer?.accountId === accountId ? (single.message?.match(/Referência:.*$/s)?.[0] ?? null) : null;
  const fxAccount = isForeignCurrency(otherCurrency) ? chosenAccount : isForeignCurrency(statementCurrency) ? statementAccount : null;
  const reference =
    askAmount && fxAccount?.fx && rowCents
      ? `Referência: PTAX de ${formatDayMonthBR(fxAccount.fx.date)}, 1 ${fxAccount.currency} = ${formatRate(fxAccount.fx.rate)} (≈ ${formatMoney(
          isForeignCurrency(otherCurrency) ? Math.round(rowCents / fxAccount.fx.rate) : Math.round(rowCents * fxAccount.fx.rate),
          otherCurrency,
        )}).`
      : null;
  const money = (cents: number, opts?: { signed?: boolean }) => formatMoney(cents, statementCurrency, opts);
  const awaitingAmount = rows.length > 0 && rows.every(needsCounterpartAmount);

  const submit = () => {
    if (!accountId) return setFieldError("Escolha a conta do outro lado (ou crie uma conta de investimento)");
    if (askAmount && !counterpart) return setAmountError(`Informe o valor em ${otherCurrency}`);
    setError(null);
    mutation.mutate(
      {
        rowIds: rows.map((r) => r.id),
        transferAccountId: accountId,
        // O valor na outra moeda vale só para esta linha.
        applyToSimilar: askAmount ? false : applyToSimilar,
        remember,
        accountName,
        counterpartAmountCents: askAmount ? counterpart : null,
      },
      { onSuccess: () => onOpenChange(false), onError: (e) => setError(errorMessage(e)) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-5 text-brand" aria-hidden /> {awaitingAmount ? "Transferência entre moedas" : changing ? "Trocar a conta da transferência" : "Marcar como transferência"}
          </DialogTitle>
          <DialogDescription>
            Aplicação, resgate, remessa e transferência entre contas da família não são receita nem despesa: o dinheiro só muda de conta. Escolha a conta do outro lado.
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
                  <span className="tabular">{rows[0].date ? formatDateBR(rows[0].date) : "Sem data"}</span> · <span className="tabular">{money(rows[0].amountCents ?? 0, { signed: true })}</span>
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
                      {outs.length} saída(s) de {statement?.name} para {target}: <span className="tabular">{money(sum(outs))}</span>
                    </li>
                  )}
                  {ins.length > 0 && (
                    <li>
                      {ins.length} entrada(s) em {statement?.name} vindas de {target}: <span className="tabular">{money(sum(ins))}</span>
                    </li>
                  )}
                </ul>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {rows.slice(0, SAMPLE).map((r) => (
                    <li key={r.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">{r.description ?? "—"}</span>
                      <span className="shrink-0 tabular">{money(r.amountCents ?? 0, { signed: true })}</span>
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
              setChosen(acc);
              setFieldError(null);
              setAmountError(null);
            }}
            excludeIds={statement ? [statement.id] : []}
            suggestion={suggestion}
            initialBalanceDate={earliest}
            error={fieldError ?? undefined}
          />

          {askAmount && (
            <Field
              label={`Valor em ${otherCurrency}`}
              htmlFor="import-transfer-counterpart"
              error={amountError ?? undefined}
              required
              hint={
                <>
                  {rowOut ? `Quanto chegou em ${target}, já descontadas as tarifas.` : `Quanto saiu de ${target}.`}
                  {exchange && (
                    <span className="block">
                      Câmbio efetivo: <strong className="font-medium text-foreground tabular">{exchange}</strong>
                    </span>
                  )}
                  {(serverReference ?? reference) && <span className="block">{serverReference ?? reference}</span>}
                </>
              }
            >
              <MoneyInput
                id="import-transfer-counterpart"
                currency={otherCurrency}
                value={counterpart}
                onChange={(n) => {
                  setCounterpart(n);
                  if (n) setAmountError(null);
                }}
                aria-invalid={Boolean(amountError)}
              />
            </Field>
          )}
          {crossCurrency && !single && (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              {target} está em {otherCurrency} e {statement?.name} em {statementCurrency}: o valor em {otherCurrency} é informado linha a linha. As linhas ficam fora da importação até você informar cada uma.
            </p>
          )}

          <div className="grid gap-2">
            {!askAmount && (
              <CheckOption
                id="import-transfer-similar"
                checked={applyToSimilar}
                onChange={setApplyToSimilar}
                label="Aplicar às linhas parecidas deste arquivo"
                hint="Mesma descrição (sem contar números e códigos) e mesmo sentido — entrada ou saída."
              />
            )}
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
            <ArrowLeftRight /> {askAmount ? "Salvar transferência" : changing ? "Salvar conta" : "Marcar como transferência"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
