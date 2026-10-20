"use client";

import { useState, type ReactNode } from "react";
import { CreditCard, Landmark, Plus, RotateCcw, Sparkles, TrendingUp, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBRL } from "@/lib/money";
import { formatDayMonthBR } from "@/lib/dates";
import type { SubscriptionCandidateDTO } from "./types";
import { useSubscriptionCandidates, useSubscriptionMutations } from "./use-fixed-expenses";

function Payer({ c }: { c: SubscriptionCandidateDTO }) {
  const source = c.creditCard ?? c.account;
  if (!source) return null;
  const Icon = c.creditCard ? CreditCard : Landmark;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{source.name}</span>
    </span>
  );
}

function Row({ c, children }: { c: SubscriptionCandidateDTO; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium leading-snug">
          <span className="truncate">{c.merchantName}</span>
          <span className="whitespace-nowrap tabular">{formatBRL(c.amountCents)}</span>
          {c.priceRaised && c.previousAmountCents !== null && (
            <Badge variant="warning">
              <TrendingUp className="size-3" aria-hidden /> Ficou mais cara: antes {formatBRL(c.previousAmountCents)}
            </Badge>
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {c.occurrences} {c.occurrences === 1 ? "mês" : "meses seguidos"} · última em {formatDayMonthBR(c.lastChargeDate)}
          </span>
          <Payer c={c} />
        </p>
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </li>
  );
}

/** Cobranças que se repetem todo mês e ainda não estão nos gastos fixos (aparece só quando há alguma). */
export function SubscriptionsSection({ canEdit }: { canEdit: boolean }) {
  const open = useSubscriptionCandidates("OPEN");
  const ignored = useSubscriptionCandidates("IGNORED");
  const { accept, ignore, reopen } = useSubscriptionMutations();
  const [showIgnored, setShowIgnored] = useState(false);
  const items = open.data ?? [];
  const ignoredItems = ignored.data ?? [];
  const busy = (m: { isPending: boolean; variables?: SubscriptionCandidateDTO }, c: SubscriptionCandidateDTO) => m.isPending && m.variables?.id === c.id;

  if (!items.length && !(showIgnored && ignoredItems.length)) {
    if (!ignoredItems.length) return null;
    return (
      <p className="text-xs text-muted-foreground">
        {ignoredItems.length} {ignoredItems.length === 1 ? "cobrança mensal ignorada" : "cobranças mensais ignoradas"} ·{" "}
        <button type="button" className="font-medium text-brand underline-offset-4 hover:underline" onClick={() => setShowIgnored(true)}>
          Ver ignoradas
        </button>
      </p>
    );
  }

  return (
    <Card aria-labelledby="fixed-subscriptions-title">
      <CardHeader>
        <CardTitle id="fixed-subscriptions-title" className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand" aria-hidden /> Cobranças que se repetem todo mês
        </CardTitle>
        <CardDescription className="mt-1 text-xs">Não estão nos gastos fixos. Se ainda usa, cadastre; se não usa mais, vale cancelar a assinatura.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {items.length > 0 && (
          <ul className="divide-y rounded-xl border">
            {items.map((c) => (
              <Row key={c.id} c={c}>
                {canEdit && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => ignore.mutate(c)} loading={busy(ignore, c)} disabled={busy(accept, c)}>
                      <X /> Ignorar
                    </Button>
                    <Button size="sm" variant="brand" onClick={() => accept.mutate(c)} loading={busy(accept, c)} disabled={busy(ignore, c)}>
                      <Plus /> Cadastrar como gasto fixo
                    </Button>
                  </>
                )}
              </Row>
            ))}
          </ul>
        )}

        {ignoredItems.length > 0 && (
          <div className="grid gap-2">
            <button type="button" className="justify-self-start text-xs font-medium text-brand underline-offset-4 hover:underline" aria-expanded={showIgnored} onClick={() => setShowIgnored((v) => !v)}>
              {showIgnored ? "Esconder ignoradas" : `Ver ignoradas (${ignoredItems.length})`}
            </button>
            {showIgnored && (
              <ul className="divide-y rounded-xl border border-dashed text-muted-foreground">
                {ignoredItems.map((c) => (
                  <Row key={c.id} c={c}>
                    {canEdit && (
                      <Button size="sm" variant="outline" onClick={() => reopen.mutate(c)} loading={busy(reopen, c)}>
                        <RotateCcw /> Voltar a sugerir
                      </Button>
                    )}
                  </Row>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
