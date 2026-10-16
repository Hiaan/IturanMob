"use client";

import { useId, useState } from "react";
import { PiggyBank, Plus, TrendingUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/shared/money-input";
import { errorMessage } from "@/lib/client/api";
import { todayISO } from "@/lib/dates";
import { ACCOUNT_TYPE_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/features/finance/hooks";
import { useMe } from "@/features/me/use-me";
import type { AccountDTO } from "@/features/finance/types";
import { ACCOUNT_COLORS, ACCOUNT_TYPE_ICON } from "./account-icon";
import { useAccountMutations } from "./use-account-mutations";

type InvestmentType = "INVESTMENT" | "SAVINGS";

export function isInvestmentAccount(a: Pick<AccountDTO, "type">): boolean {
  return a.type === "INVESTMENT" || a.type === "SAVINGS";
}

const PRODUCTS: Array<[RegExp, string]> = [
  [/\bcdb\b/i, "CDB"],
  [/\brdb\b/i, "RDB"],
  [/\blci\b/i, "LCI"],
  [/\blca\b/i, "LCA"],
  [/\btesouro\b/i, "Tesouro"],
];

/** Nome e tipo sugeridos para a conta de investimento: produto citado nas descrições + instituição da conta. */
export function suggestInvestmentAccount(descriptions: Array<string | null | undefined>, account: Pick<AccountDTO, "name" | "institution"> | null | undefined): { name: string; type: InvestmentType } {
  const text = descriptions.filter(Boolean).join(" ");
  const bank = (account?.institution || account?.name || "").trim();
  if (/\bpoup(an[cç]a)?\b/i.test(text)) return { name: bank ? `Poupança ${bank}` : "Poupança", type: "SAVINGS" };
  const product = PRODUCTS.find(([re]) => re.test(text))?.[1] ?? "CDB";
  return { name: (bank ? `${product} ${bank}` : "Investimentos").slice(0, 60), type: "INVESTMENT" };
}

/**
 * Conta do outro lado de uma transferência entre contas próprias: investimentos e poupança primeiro,
 * depois as demais contas; com a opção de criar uma conta de investimento ali mesmo.
 */
export function TransferAccountField({
  id,
  label = "Conta do outro lado",
  value,
  onChange,
  excludeIds = [],
  suggestion,
  initialBalanceDate,
  error,
  hint,
}: {
  id: string;
  label?: string;
  value: string | null;
  onChange: (accountId: string | null, account: AccountDTO | null) => void;
  excludeIds?: string[];
  suggestion?: { name: string; type: InvestmentType };
  /** Data do saldo inicial da conta criada (ex.: a data mais antiga das linhas); padrão: hoje. */
  initialBalanceDate?: string | null;
  error?: string;
  hint?: React.ReactNode;
}) {
  const accounts = useAccounts();
  const me = useMe();
  const { save } = useAccountMutations();
  const formId = useId();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<AccountDTO | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<InvestmentType>("INVESTMENT");
  const [initial, setInitial] = useState(0);
  const [createError, setCreateError] = useState<string | null>(null);

  const list = [...(accounts.data ?? [])];
  if (created && !list.some((a) => a.id === created.id)) list.push(created);
  const options = list.filter((a) => !a.archivedAt && !excludeIds.includes(a.id));
  const investments = options.filter(isInvestmentAccount);
  const others = options.filter((a) => !isInvestmentAccount(a));
  const selected = options.find((a) => a.id === value) ?? null;

  const openCreate = () => {
    setName(suggestion?.name ?? "Investimentos");
    setType(suggestion?.type ?? "INVESTMENT");
    setInitial(0);
    setCreateError(null);
    setCreating(true);
  };

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return setCreateError("Informe o nome da conta");
    setCreateError(null);
    save.mutate(
      {
        input: {
          name: trimmed,
          institution: null,
          type,
          visibility: "SHARED",
          ownerMemberId: null,
          initialBalanceCents: initial,
          initialBalanceDate: initialBalanceDate ?? todayISO(me.data?.household.timezone),
          color: type === "SAVINGS" ? ACCOUNT_COLORS[1]! : ACCOUNT_COLORS[4]!,
          icon: ACCOUNT_TYPE_ICON[type]?.name ?? "trending-up",
          includeInTotals: true,
        },
      },
      {
        onSuccess: (acc) => {
          setCreated(acc);
          setCreating(false);
          onChange(acc.id, acc);
        },
        onError: (err) => setCreateError(errorMessage(err)),
      },
    );
  };

  return (
    <div className="grid gap-2">
      <Field label={label} htmlFor={id} error={error} hint={creating ? undefined : hint} required>
        <Select value={value ?? ""} onValueChange={(v) => onChange(v, options.find((a) => a.id === v) ?? null)} disabled={accounts.isLoading}>
          <SelectTrigger id={id} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>
            <SelectValue placeholder={accounts.isLoading ? "Carregando contas…" : options.length ? "Escolha a conta" : "Nenhuma outra conta: crie uma abaixo"} />
          </SelectTrigger>
          <SelectContent>
            {investments.length > 0 && (
              <SelectGroup>
                <SelectLabel>Investimentos e poupança</SelectLabel>
                {investments.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} <span className="text-muted-foreground">· {ACCOUNT_TYPE_LABELS[a.type as keyof typeof ACCOUNT_TYPE_LABELS] ?? a.type}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {investments.length > 0 && others.length > 0 && <SelectSeparator />}
            {others.length > 0 && (
              <SelectGroup>
                <SelectLabel>Outras contas da família</SelectLabel>
                {others.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} <span className="text-muted-foreground">· {ACCOUNT_TYPE_LABELS[a.type as keyof typeof ACCOUNT_TYPE_LABELS] ?? a.type}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </Field>

      {!creating ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {!accounts.isLoading && !investments.length && <span>A família ainda não tem conta de investimento.</span>}
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={openCreate}>
            <Plus /> Criar conta de investimento
          </Button>
          {selected && created?.id === selected.id && <span aria-live="polite">· {selected.name} criada e escolhida.</span>}
        </div>
      ) : (
        <div
          role="group"
          aria-labelledby={`${formId}-title`}
          className="grid gap-3 rounded-xl border bg-muted/30 p-3"
          onKeyDown={(e) => {
            // Enter cria a conta (o mini-formulário fica dentro de outros formulários).
            if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
              e.preventDefault();
              create();
            }
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <p id={`${formId}-title`} className="flex items-center gap-1.5 text-sm font-medium">
              <TrendingUp className="size-4 text-brand" aria-hidden /> Nova conta de investimento
            </p>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setCreating(false)} aria-label="Cancelar a criação da conta">
              <X />
            </Button>
          </div>
          <Field label="Nome" htmlFor={`${formId}-name`} error={createError ?? undefined} required>
            <Input
              id={`${formId}-name`}
              value={name}
              maxLength={60}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              aria-invalid={Boolean(createError)}
            />
          </Field>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-[13px] font-medium">Tipo</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo da conta">
              {(
                [
                  ["INVESTMENT", TrendingUp, "Investimento"],
                  ["SAVINGS", PiggyBank, "Poupança"],
                ] as const
              ).map(([v, Icon, text]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={type === v}
                  onClick={() => setType(v)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    type === v ? "border-brand bg-accent/60" : "hover:bg-muted/50",
                  )}
                >
                  <Icon className={cn("size-4 shrink-0", type === v ? "text-brand" : "text-muted-foreground")} aria-hidden /> {text}
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="Saldo inicial" htmlFor={`${formId}-initial`} hint="Pode deixar R$ 0,00: depois você ajusta o saldo em Contas.">
            <MoneyInput id={`${formId}-initial`} value={initial} onChange={setInitial} />
          </Field>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={create} loading={save.isPending}>
              <Plus /> Criar e usar esta conta
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
