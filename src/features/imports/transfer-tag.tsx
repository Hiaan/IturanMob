"use client";

import { ArrowLeftRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ImportRowDTO } from "./types";

const REASON: Record<string, string> = {
  INVESTMENT: "Detectado como aplicação/resgate de investimento",
  OWN_ACCOUNTS: "Detectado como transferência entre contas próprias",
  FOREIGN: "Detectado como remessa/câmbio entre contas próprias",
  RULE: "Pela regra aprendida",
  MANUAL: "Marcado por você",
};

/** Etiqueta da linha de transferência: "→ CDB Itaú" (saída) ou "← CDB Itaú" (entrada); sem conta, pede a escolha. */
export function TransferTag({ row, className }: { row: Pick<ImportRowDTO, "kind" | "transfer">; className?: string }) {
  const t = row.transfer;
  if (row.kind !== "TRANSFER" || !t) return null;
  if (!t.accountId)
    return (
      <Badge variant="warning" className={cn("max-w-full", className)} title="Escolha a conta do outro lado para importar como transferência">
        <ArrowLeftRight aria-hidden /> <span className="truncate">Transferência · escolha a conta</span>
      </Badge>
    );
  const out = t.direction === "OUT";
  return (
    <Badge variant="brand" className={cn("max-w-full", className)} title={`${REASON[t.reason ?? "MANUAL"] ?? "Transferência"}: não conta como receita nem despesa.`}>
      <ArrowLeftRight aria-hidden />
      <span className="truncate">
        Transferência <span aria-hidden>{out ? "→" : "←"}</span>
        <span className="sr-only">{out ? "para" : "vinda de"}</span> {t.accountName ?? "outra conta"}
        {t.counterpartAmountCents && t.accountCurrency ? ` · ${formatMoney(t.counterpartAmountCents, t.accountCurrency)}` : null}
      </span>
    </Badge>
  );
}
