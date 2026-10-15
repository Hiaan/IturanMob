"use client";

import type { QueryClient } from "@tanstack/react-query";

/** Prefixos de consulta afetados por mudanças financeiras (transações, contas, cartões, categorias). */
export const FINANCE_PREFIXES = ["transactions", "accounts", "cards", "analytics", "pending", "me", "budgets", "bills", "goals"] as const;

export function invalidateFinance(qc: QueryClient, extra: string[] = []) {
  for (const key of [...FINANCE_PREFIXES, ...extra]) qc.invalidateQueries({ queryKey: [key] });
}
