"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import type { ReportScope } from "@/features/finance/types";
import type { FixedExpensesOverview } from "./types";

/**
 * Gastos fixos (recorrências, parcelas e projeção). Fica sob o prefixo "analytics": é invalidado
 * junto com lançamentos, cartões, contas a pagar, categorias e recorrências.
 * `scope` ausente = recorte padrão da família (o servidor devolve qual aplicou).
 */
export function useFixedExpenses(scope: ReportScope | undefined, months = 12, enabled = true) {
  const params = { scope, months };
  return useQuery({
    queryKey: qk.analytics("fixed-expenses", params),
    queryFn: () => api.get<FixedExpensesOverview>("/api/v1/fixed-expenses", params),
    placeholderData: keepPreviousData,
    enabled,
  });
}
