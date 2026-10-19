"use client";

import { useId, useState } from "react";
import { CircleOff, CreditCard, Grid3x3, Landmark, Rows3, Save, TriangleAlert, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/shared/money-input";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { InitialBalanceChoice, MigrationBalanceDTO, MigrationDTO, MigrationDestinationDTO } from "@/server/modules/migration/types";
import { plural } from "./labels";
import { useMigrationBusy, useUpdateOptions } from "./use-migration";

const KIND_META: Record<MigrationDestinationDTO["kind"], { icon: LucideIcon; label: string }> = {
  ACCOUNT: { icon: Landmark, label: "Conta" },
  CARD: { icon: CreditCard, label: "Cartão" },
  NONE: { icon: CircleOff, label: "Sem conta (não altera saldos)" },
  MATRIX: { icon: Grid3x3, label: "Categorias × meses" },
};

function Stat({ label, value, tone, help }: { label: string; value: number; tone?: "warning" | "negative" | "positive"; help?: string }) {
  return (
    <div className={cn("rounded-lg border px-2.5 py-2", !value && "opacity-60")} title={help}>
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("text-base font-semibold tabular", value > 0 && tone === "warning" && "text-warning", value > 0 && tone === "negative" && "text-negative", value > 0 && tone === "positive" && "text-positive")}>
        {value.toLocaleString("pt-BR")}
      </dd>
    </div>
  );
}

function suggestionSource(b: MigrationBalanceDTO): string | null {
  if (b.suggestedInitialCents === null) return null;
  const when = b.suggestedInitialDate ? ` (em ${formatDateBR(b.suggestedInitialDate)})` : "";
  if (b.suggestedFrom === "BALANCE_COLUMN") return `da coluna Saldo da planilha${when}`;
  if (b.suggestedFrom === "OPENING_ROW") return `da linha “Saldo inicial” da planilha${when}`;
  return `da planilha${when}`;
}

/** Saldo inicial de uma conta nova (ou sem saldo): antes do primeiro lançamento ou o saldo de hoje. */
function InitialBalanceEditor({ migration: m, accountId, balance: b }: { migration: MigrationDTO; accountId: string; balance: MigrationBalanceDTO }) {
  const update = useUpdateOptions(m.id);
  const busy = useMigrationBusy(m.id);
  const name = useId();
  const [mode, setMode] = useState<InitialBalanceChoice["mode"]>(b.choice?.mode ?? "INITIAL");
  const [cents, setCents] = useState<number>(b.choice?.cents ?? b.suggestedInitialCents ?? 0);
  const source = suggestionSource(b);
  const changed = !b.choice || b.choice.mode !== mode || b.choice.cents !== cents;
  const missing = b.needsInitialBalance && !b.choice;

  const save = () => {
    const others = m.options.initialBalances.filter((c) => c.accountId !== accountId);
    update.mutate({ initialBalances: [...others, { accountId, mode, cents }] });
  };

  return (
    <div className={cn("mt-3 grid gap-3 rounded-lg border p-3", missing && "border-warning/50 bg-warning/5")}>
      <fieldset className="grid gap-2">
        <legend className="text-[13px] font-medium">Saldo inicial da conta</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" name={name} checked={mode === "INITIAL"} onChange={() => setMode("INITIAL")} className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]" />
          <span>
            Saldo antes do primeiro lançamento <span className="text-muted-foreground">(em {formatDateBR(b.initialBalanceDate)})</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" name={name} checked={mode === "CURRENT"} onChange={() => setMode("CURRENT")} className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]" />
          <span>
            Saldo de hoje <span className="text-muted-foreground">(o saldo inicial é calculado a partir dele)</span>
          </span>
        </label>
      </fieldset>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <MoneyInput value={cents} onChange={setCents} allowNegative className="sm:w-52" id={`${name}-cents`} aria-invalid={missing || undefined} />
        <Label htmlFor={`${name}-cents`} className="sr-only">
          Valor do saldo
        </Label>
        <Button variant={missing ? "brand" : "outline"} size="sm" onClick={save} disabled={busy || !changed} loading={update.isPending}>
          <Save aria-hidden /> Salvar saldo
        </Button>
      </div>
      {source && b.suggestedInitialCents !== null && (
        <p className="text-xs text-muted-foreground">
          Sugestão {source}: <span className="font-medium text-foreground tabular">{formatBRL(b.suggestedInitialCents)}</span>.
          {(mode !== "INITIAL" || cents !== b.suggestedInitialCents) && (
            <>
              {" "}
              <button
                type="button"
                className="font-medium text-brand underline-offset-2 hover:underline"
                onClick={() => {
                  setMode("INITIAL");
                  setCents(b.suggestedInitialCents ?? 0);
                }}
              >
                Usar a sugestão
              </button>
            </>
          )}
        </p>
      )}
      {missing && (
        <p className="flex items-start gap-1.5 text-xs font-medium text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> Informe e salve o saldo inicial desta conta para importar.
        </p>
      )}
      {b.choice && !changed && <p className="text-xs text-positive">Saldo salvo. A prévia já considera este valor.</p>}
    </div>
  );
}

function BalanceSection({ migration: m, accountId, balance: b }: { migration: MigrationDTO; accountId: string; balance: MigrationBalanceDTO }) {
  const update = useUpdateOptions(m.id);
  const busy = useMigrationBusy(m.id);
  const switchId = useId();
  return (
    <div className="mt-3 border-t pt-3">
      <dl className="grid grid-cols-1 gap-2 text-sm min-[420px]:grid-cols-3">
        <div>
          <dt className="text-[11px] text-muted-foreground">{b.isNew ? "Saldo agora (conta nova)" : "Saldo hoje"}</dt>
          <dd className="font-semibold tabular">{formatBRL(b.currentBalanceCents)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted-foreground">Saldo inicial · {formatDateBR(b.initialBalanceDate)}</dt>
          <dd className="font-semibold tabular">{formatBRL(b.initialBalanceCents)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted-foreground">Depois de importar</dt>
          <dd className="font-semibold tabular text-brand">{formatBRL(b.projectedBalanceCents)}</dd>
        </div>
      </dl>
      {(b.needsInitialBalance || b.isNew) && <InitialBalanceEditor key={`${b.choice?.mode}:${b.choice?.cents}`} migration={m} accountId={accountId} balance={b} />}
      {!b.isNew && b.rowsBeforeInitial > 0 && (
        <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="grid gap-0.5">
            <Label htmlFor={switchId} className="text-sm leading-snug">
              {plural(b.rowsBeforeInitial, "lançamento é anterior", "lançamentos são anteriores")} ao saldo inicial desta conta
            </Label>
            <p className="text-xs text-muted-foreground">
              {m.options.keepCurrentBalance
                ? "O saldo de hoje continua igual: eles entram no histórico sem mudar o saldo. Vale para todas as contas que já existiam."
                : "Desligado: eles mudam o saldo de hoje desta conta. Vale para todas as contas que já existiam."}
            </p>
          </div>
          <Switch id={switchId} checked={m.options.keepCurrentBalance} onCheckedChange={(v) => update.mutate({ keepCurrentBalance: v })} disabled={busy} />
        </div>
      )}
    </div>
  );
}

/** Um destino da prévia (conta, cartão, sem conta ou matriz) com contagens, período, totais e saldo. */
export function DestinationCard({ migration: m, destination: d, isCreated, onViewRows }: { migration: MigrationDTO; destination: MigrationDestinationDTO; isCreated: boolean; onViewRows: () => void }) {
  const meta = KIND_META[d.kind];
  const Icon = meta.icon;
  return (
    <Card className="flex min-w-0 flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="break-words font-semibold">{d.name}</span>
              {isCreated && <Badge variant="brand">nova</Badge>}
            </p>
            <p className="text-xs text-muted-foreground">
              {meta.label}
              {d.start && d.end ? ` · ${formatDateBR(d.start)} a ${formatDateBR(d.end)}` : ""}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onViewRows} className="shrink-0" aria-label={`Ver linhas de ${d.name}`}>
          <Rows3 aria-hidden /> Ver linhas
        </Button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 min-[420px]:grid-cols-4">
        <Stat label="Novos" value={d.newRows} help={`${d.selectedRows} selecionado(s) para importar`} />
        <Stat label="Já no app" value={d.matchedRows} tone="positive" help="Já registrados: só serão vinculados, sem duplicar." />
        <Stat label="Duplicados" value={d.duplicateRows} help="Já importados antes: não entram de novo." />
        <Stat label="Ignorados" value={d.skippedRows} help="Saldo, total, valor zero ou pagamento de fatura." />
        {d.divergentRows > 0 && <Stat label="Divergentes" value={d.divergentRows} tone="warning" help="Parecem um lançamento do app, com valor diferente: viram pendência." />}
        <Stat label="Com erro" value={d.errorRows} tone="negative" help="Data ou valor que não deu para ler: não entram." />
        <Stat label="Transferências" value={d.transfers} help="Entre contas próprias: não contam como receita nem despesa." />
        <Stat label="Compras parceladas" value={d.installmentPurchases} help="Criadas com as parcelas futuras." />
      </dl>
      <p className="mt-2 text-xs text-muted-foreground tabular">
        {plural(d.selectedRows, "linha selecionada", "linhas selecionadas")} · entradas <span className="font-medium text-positive">{formatBRL(d.inCents)}</span> · saídas{" "}
        <span className="font-medium text-foreground">{formatBRL(d.outCents)}</span>
      </p>

      {d.kind === "ACCOUNT" && d.balance && d.id && <BalanceSection migration={m} accountId={d.id} balance={d.balance} />}
    </Card>
  );
}
