"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, FileUp, ScanLine } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { formatDigitableLine } from "@/lib/boleto";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { AccountSelect, CategoryPicker, NONE, parseCategoryValue } from "@/features/recurring/pickers";
import type { BoletoFilePreview, BoletoPreview } from "./types";
import { copyBoletoLine, useBoletoMutations } from "./use-bills";

/** Tamanhos aceitos: código de barras (44), linha bancária (47) ou de arrecadação (48). */
const LINE_LENGTHS = new Set([44, 47, 48]);
const onlyDigits = (v: string) => v.replace(/\D/g, "");

type Hints = BoletoFilePreview["hints"] | null;
/** Leitura válida e os dígitos digitados que a geraram (se o texto mudar, a leitura deixa de valer). */
type Checked = { input: string; preview: BoletoPreview; hints: Hints };

const DOC_HINT = "Lido do documento — confira";

/** Adicionar boleto: cola a linha digitável ou envia o PDF/foto, confere e cadastra nas contas a pagar. */
export function BoletoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Adicionar boleto</DialogTitle>
          <DialogDescription>Cole o código do boleto ou envie o PDF ou uma foto. Valor e vencimento que vêm no código são usados como estão.</DialogDescription>
        </DialogHeader>
        {open && <BoletoForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function BoletoForm({ onDone }: { onDone: () => void }) {
  const { preview, readFile, create } = useBoletoMutations();
  const [line, setLine] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [lineError, setLineError] = useState<{ input: string; message: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [amountCents, setAmountCents] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [category, setCategory] = useState(NONE);
  const [accountId, setAccountId] = useState(NONE);
  const [submitted, setSubmitted] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef("");

  const digits = onlyDigits(line);
  // A leitura vale enquanto o texto do campo for o mesmo que foi conferido.
  const current = checked && checked.input === digits ? checked : null;
  const error = lineError && lineError.input === digits ? lineError.message : null;

  const apply = (input: string, p: BoletoPreview, hints: Hints) => {
    setChecked({ input, preview: p, hints });
    setLineError(null);
    setSubmitted(false);
    setDescription(hints?.beneficiary ?? p.label);
    setAmountCents(p.boleto.amountCents ?? hints?.amountCents ?? 0);
    setDueDate(p.boleto.dueDate ?? hints?.dueDate ?? "");
  };

  const check = (input: string) => {
    if (!input) return;
    preview.mutate(input, {
      onSuccess: (p) => {
        if (latest.current === input) apply(input, p, null);
      },
      onError: (err) => {
        if (latest.current === input) setLineError({ input, message: errorMessage(err) });
      },
    });
  };

  // Confere sozinho quando o texto colado já tem o tamanho de um código completo.
  useEffect(() => {
    if (!LINE_LENGTHS.has(digits.length) || checked?.input === digits || lineError?.input === digits) return;
    const t = setTimeout(() => check(digits), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    readFile.mutate(file, {
      onSuccess: (p) => {
        const input = p.boleto.digitableLine;
        latest.current = input;
        setLine(formatDigitableLine(input));
        apply(input, p, p.hints);
      },
      onError: (err) => setFileError(errorMessage(err)),
    });
  };

  const b = current?.preview.boleto;
  const hints = current?.hints ?? null;
  const duplicate = Boolean(current?.preview.existingBillId);
  const needsAmount = Boolean(b && b.amountCents === null);
  const needsDue = Boolean(b && b.dueDate === null);
  const errors = {
    description: !description.trim() ? "Informe uma descrição" : undefined,
    amount: needsAmount && amountCents <= 0 ? "Informe o valor" : undefined,
    due: needsDue && dueDate.length !== 10 ? "Informe o vencimento" : undefined,
  };
  const valid = !errors.description && !errors.amount && !errors.due;

  const save = () => {
    setSubmitted(true);
    if (!current || !b || duplicate || !valid) return;
    const categoryId = parseCategoryValue(category).categoryId;
    create.mutate(
      {
        line: b.digitableLine,
        description: description.trim(),
        ...(needsAmount ? { amountCents } : {}),
        ...(needsDue ? { dueDate } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(accountId !== NONE ? { accountId } : {}),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (current) save();
        else check(digits);
      }}
    >
      <Field label="Código do boleto (linha digitável)" htmlFor="boleto-line" error={error ?? undefined} hint="Pode colar com pontos e espaços. Só os números contam.">
        <Textarea
          id="boleto-line"
          rows={2}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="Ex.: 34191.79001 01043.510047 91020.150008 1 96610000017500"
          className="font-mono text-sm"
          value={line}
          onChange={(e) => {
            latest.current = onlyDigits(e.target.value);
            setLine(e.target.value);
          }}
          aria-invalid={Boolean(error)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => check(digits)} disabled={!digits || Boolean(current)} loading={preview.isPending}>
          <ScanLine /> Conferir
        </Button>
        <span className="text-xs text-muted-foreground">ou</span>
        <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} loading={readFile.isPending}>
          <FileUp /> Enviar PDF ou foto
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/*"
          className="sr-only"
          tabIndex={-1}
          aria-label="Enviar PDF ou foto do boleto"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {fileError && (
        <p role="alert" className="flex items-start gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden /> {fileError}
        </p>
      )}

      {current && b && (
        <>
          <div className="grid gap-2 rounded-xl border bg-muted/30 p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="size-4 text-positive" aria-hidden />
              {b.kind === "BANK" ? `Boleto bancário${b.bankName ? ` · ${b.bankName}` : ""}` : `Conta de consumo ou tributo${b.segment ? ` · ${b.segment}` : ""}`}
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <div>
                <dt className="text-xs text-muted-foreground">Valor no código</dt>
                <dd className="font-semibold tabular">{b.amountCents !== null ? formatBRL(b.amountCents) : "Não vem no código"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Vencimento no código</dt>
                <dd className="font-semibold tabular">{b.dueDate ? formatDateBR(b.dueDate) : "Não vem no código"}</dd>
              </div>
            </dl>
            <div className="flex items-center justify-between gap-2">
              <code className="min-w-0 break-all font-mono text-xs text-muted-foreground">{formatDigitableLine(b.digitableLine)}</code>
              <Button type="button" variant="ghost" size="sm" onClick={() => copyBoletoLine(b.digitableLine)}>
                <Copy /> Copiar
              </Button>
            </div>
          </div>

          {duplicate ? (
            <p role="status" className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> Este boleto já está nas contas a pagar.
            </p>
          ) : (
            <>
              <Field label="Descrição" htmlFor="boleto-description" error={submitted ? errors.description : undefined} required>
                <Input id="boleto-description" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} aria-invalid={submitted && Boolean(errors.description)} />
              </Field>
              {(needsAmount || needsDue) && (
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  {needsAmount && (
                    <Field
                      label="Valor"
                      htmlFor="boleto-amount"
                      error={submitted ? errors.amount : undefined}
                      hint={hints?.amountCents && amountCents === hints.amountCents ? DOC_HINT : "O código não traz o valor"}
                      required
                    >
                      <MoneyInput id="boleto-amount" value={amountCents} onChange={setAmountCents} aria-invalid={submitted && Boolean(errors.amount)} />
                    </Field>
                  )}
                  {needsDue && (
                    <Field
                      label="Vencimento"
                      htmlFor="boleto-due"
                      error={submitted ? errors.due : undefined}
                      hint={hints?.dueDate && dueDate === hints.dueDate ? DOC_HINT : "O código não traz o vencimento"}
                      required
                    >
                      <Input id="boleto-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-invalid={submitted && Boolean(errors.due)} />
                    </Field>
                  )}
                </div>
              )}
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <Field label="Categoria" htmlFor="boleto-category">
                  <CategoryPicker id="boleto-category" value={category} onChange={setCategory} kind="EXPENSE" withSubcategories={false} />
                </Field>
                <Field label="Conta para pagar" htmlFor="boleto-account" hint="Opcional">
                  <AccountSelect id="boleto-account" value={accountId} onChange={setAccountId} noneLabel="Definir ao pagar" />
                </Field>
              </div>
            </>
          )}
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {duplicate ? "Fechar" : "Cancelar"}
        </Button>
        {!duplicate && (
          <Button type="submit" variant="brand" disabled={!current} loading={create.isPending}>
            Cadastrar boleto
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}
