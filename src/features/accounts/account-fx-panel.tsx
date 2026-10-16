"use client";

import { useQuery } from "@tanstack/react-query";
import { Globe, Info, TriangleAlert } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import { api } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatBRL, formatMoney } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { AccountDTO } from "@/features/finance/types";
import { formatRate, isForeignCurrency } from "./currency";

interface AccountFx {
  currency: string;
  balanceCents: number;
  variation: null | {
    valueBrlCents: number;
    costBrlCents: number;
    variationBrlCents: number;
    rate: number;
    rateDate: string;
    incomplete: boolean;
  };
}

/** Valor em reais e variação cambial de uma conta em moeda estrangeira (GET /accounts/:id/fx). */
export function AccountFxPanel({ account }: { account: AccountDTO }) {
  const foreign = isForeignCurrency(account.currency);
  const q = useQuery({
    queryKey: qk.accounts({ fx: account.id }),
    queryFn: () => api.get<AccountFx>(`/api/v1/accounts/${account.id}/fx`),
    enabled: foreign,
  });

  if (!foreign) return null;
  if (q.isLoading) return <Skeleton className="h-44 rounded-xl" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact />;
  const data = q.data;
  if (!data) return null;
  const v = data.variation;
  const currency = data.currency;

  return (
    <Card>
      <CardHeader className="flex-row items-start gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-1.5">
            <Globe className="size-4 text-info" aria-hidden /> Câmbio
          </CardTitle>
          <CardDescription className="mt-1 text-xs">
            {v ? `PTAX de ${formatDateBR(v.rateDate)}: 1 ${currency} = ${formatRate(v.rate)}` : `Conta em ${currency}`}
          </CardDescription>
        </div>
        {v?.incomplete && (
          <CardAction>
            <Badge variant="warning" title="Falta a cotação de alguma data dos movimentos">
              <TriangleAlert aria-hidden /> Aproximada
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!v ? (
          <p className="flex gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Ainda não há cotação PTAX do {currency}. O sistema busca no Banco Central automaticamente; quando chegar, aparecem o valor em reais e a variação cambial.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">
                Valor hoje <span className="text-xs">({formatMoney(data.balanceCents, currency)} × {formatRate(v.rate)})</span>
              </dt>
              <dd className="text-right font-medium tabular">{formatBRL(v.valueBrlCents)}</dd>
              <dt className="text-muted-foreground">Custo em reais dos movimentos</dt>
              <dd className="text-right tabular">{formatBRL(v.costBrlCents)}</dd>
              <dt className="border-t pt-1.5 font-medium">Variação cambial</dt>
              <dd
                className={cn(
                  "border-t pt-1.5 text-right font-semibold tabular",
                  v.variationBrlCents > 0 && "text-positive",
                  v.variationBrlCents < 0 && "text-negative",
                )}
              >
                {formatBRL(v.variationBrlCents, { signed: true })}
              </dd>
            </dl>
            <p className="text-xs text-muted-foreground">
              Quanto o valor em reais mudou só pela cotação desde cada entrada e saída. Não é receita nem despesa e não entra nos relatórios.
            </p>
            {v.incomplete && <p className="text-xs text-warning">Falta a cotação de alguma data dos movimentos: o custo e a variação são aproximados.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
