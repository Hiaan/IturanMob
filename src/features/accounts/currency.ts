"use client";

import { useMemo } from "react";
import { formatBRL } from "@/lib/money";
import { formatDayMonthBR } from "@/lib/dates";
import { useAccounts } from "@/features/finance/hooks";
import type { AccountDTO } from "@/features/finance/types";

/** Moedas das contas. Lançamentos e saldo ficam na moeda da conta; os totais em reais usam a PTAX do Banco Central. */
export type CurrencyCode = "BRL" | "USD" | "EUR" | "GBP";

export const CURRENCY_OPTIONS: Array<{ value: CurrencyCode; label: string }> = [
  { value: "BRL", label: "Real (BRL)" },
  { value: "USD", label: "Dólar (USD)" },
  { value: "EUR", label: "Euro (EUR)" },
  { value: "GBP", label: "Libra (GBP)" },
];

export const isForeignCurrency = (currency: string | null | undefined): boolean => Boolean(currency && currency !== "BRL");

const rateFormatters = new Map<string, Intl.NumberFormat>();

/** Cotação com até 4 casas: 5.4321 → "R$ 5,4321"; 5.4 → "R$ 5,40". */
export function formatRate(rate: number, currency: string = "BRL"): string {
  let f = rateFormatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("pt-BR", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 });
    rateFormatters.set(currency, f);
  }
  return f.format(rate).replace(/ /g, " ");
}

/**
 * Câmbio efetivo entre dois valores: "1 USD = R$ 5,40". A unidade é a moeda estrangeira
 * (entre duas estrangeiras, a de `a`). Null se faltar valor ou as moedas forem iguais.
 */
export function describeExchange(a: { cents: number | null | undefined; currency: string }, b: { cents: number | null | undefined; currency: string }): string | null {
  if (!a.cents || !b.cents || a.currency === b.currency) return null;
  const [unit, quote] = a.currency === "BRL" ? [b, a] : [a, b];
  return `1 ${unit.currency} = ${formatRate(Math.abs(quote.cents!) / Math.abs(unit.cents!), quote.currency)}`;
}

/** "≈ R$ 2.715,00 · PTAX de 15/10" para conta em moeda estrangeira; null nas contas em reais. */
export function brlEquivalent(account: Pick<AccountDTO, "currency" | "balanceBrlCents" | "fx">): string | null {
  if (!isForeignCurrency(account.currency)) return null;
  if (account.balanceBrlCents === null || !account.fx) return "Sem cotação do Banco Central ainda";
  return `≈ ${formatBRL(account.balanceBrlCents)} · PTAX de ${formatDayMonthBR(account.fx.date)}`;
}

/** Contas em moeda estrangeira entre as informadas: as convertidas (com a data da cotação mais antiga) e as sem cotação. */
export function foreignSummary(accounts: AccountDTO[]) {
  const foreign = accounts.filter((a) => isForeignCurrency(a.currency));
  const unrated = foreign.filter((a) => a.balanceBrlCents === null);
  const dates = foreign.map((a) => a.fx?.date).filter(Boolean).sort() as string[];
  return { foreign, unrated, rateDate: dates[0] ?? null };
}

/** Moeda de cada conta (inclui arquivadas), para formatar lançamentos que só trazem o id da conta. */
export function useAccountCurrencies(): Map<string, string> {
  const accounts = useAccounts({ includeArchived: true });
  return useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a.currency ?? "BRL"])), [accounts.data]);
}
