"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/client/api";
import { qk } from "@/lib/client/query-keys";
import { formatDateTimeBR } from "@/lib/dates";
import type { ExclusionReason, TransactionDTO } from "@/features/finance/types";
import { invalidateFinance } from "./invalidate";

/**
 * "Desconsiderar nos relatórios": receitas/despesas que não são da família (repasse de cliente,
 * reembolso…). Só a marca muda: saldo das contas, fatura do cartão e projeção de caixa ficam iguais.
 */

export const EXCLUSION_REASONS: ExclusionReason[] = ["CLIENT_PASSTHROUGH", "REIMBURSEMENT", "OTHER"];

export const EXCLUSION_REASON_LABELS: Record<ExclusionReason, string> = {
  CLIENT_PASSTHROUGH: "Repasse de cliente",
  REIMBURSEMENT: "Reembolso",
  OTHER: "Outro",
};

export const EXCLUSION_REASON_HINTS: Record<ExclusionReason, string> = {
  CLIENT_PASSTHROUGH: "Gasto feito para um cliente e o dinheiro que ele devolveu (ex.: anúncios no seu cartão pagos de volta por Pix).",
  REIMBURSEMENT: "Valor adiantado por alguém ou que alguém vai devolver.",
  OTHER: "Qualquer valor que não é renda nem gasto da família.",
};

/** Frase-padrão: o que muda e o que não muda ao desconsiderar. */
export const EXCLUSION_KEEPS_BALANCE = "O saldo da conta e a fatura do cartão não mudam.";
export const EXCLUSION_SCOPE = "O valor só sai de receitas, despesas, categorias, orçamentos, comparativos, relatórios e respostas do assistente.";

/** Só receitas e despesas entram nos relatórios (transferência e pagamento de fatura já ficam de fora). */
export function canExcludeFromReports(t: Pick<TransactionDTO, "type" | "deletedAt">): boolean {
  return (t.type === "EXPENSE" || t.type === "INCOME") && !t.deletedAt;
}

/** "Repasse de cliente · Cliente Alfa" */
export function exclusionLabel(t: Pick<TransactionDTO, "exclusion">): string {
  if (!t.exclusion) return "Desconsiderado nos relatórios";
  const reason = EXCLUSION_REASON_LABELS[t.exclusion.reason] ?? "Outro";
  return t.exclusion.party ? `${reason} · ${t.exclusion.party}` : reason;
}

/** Texto do title/tooltip do selo na lista. */
export function exclusionTitle(t: Pick<TransactionDTO, "exclusion">): string {
  const parts = [`Desconsiderado nos relatórios: ${exclusionLabel(t)}`];
  if (t.exclusion?.note) parts.push(t.exclusion.note);
  parts.push(`Continua no saldo e na fatura.`);
  return parts.join(" — ");
}

/** "por Ana em 16/10/2026 14:30" */
export function exclusionAuthorLine(t: Pick<TransactionDTO, "exclusion">, timezone?: string): string | null {
  const e = t.exclusion;
  if (!e || (!e.excludedBy && !e.excludedAt)) return null;
  return [e.excludedBy ? `por ${e.excludedBy.displayName}` : null, e.excludedAt ? `em ${formatDateTimeBR(e.excludedAt, timezone)}` : null].filter(Boolean).join(" ");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface ReportExclusionBody {
  transactionIds: string[];
  excluded: boolean;
  reason?: ExclusionReason | null;
  /** undefined = manter o que já está (edição em lote); null = limpar. */
  party?: string | null;
  note?: string | null;
}

export interface ReportExclusionResult {
  updated: number;
  skipped: Array<{ id: string; description: string | null; reason: string }>;
  items: TransactionDTO[];
}

/** Agrupa os motivos de "não alterado" em linhas curtas: "2× Já estava desconsiderado." */
export function skippedSummary(skipped: ReportExclusionResult["skipped"]): string {
  const byReason = new Map<string, string[]>();
  for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.description ?? "lançamento"]);
  return [...byReason]
    .map(([reason, names]) => (names.length === 1 ? `“${names[0]}”: ${reason}` : `${names.length}× ${reason}`))
    .join(" ");
}

/** Marca/desmarca lançamentos como desconsiderados nos relatórios, com toasts e invalidação. */
export function useReportExclusion() {
  const qc = useQueryClient();
  return useMutation({
    /** `editing`: só muda motivo/cliente/observação de quem já estava desconsiderado (texto do aviso). */
    mutationFn: ({ editing: _editing, ...body }: ReportExclusionBody & { editing?: boolean }) => api.post<ReportExclusionResult>("/api/v1/transactions/report-exclusion", body),
    onSuccess: (res, body) => {
      // Atualiza o detalhe aberto na hora (o refetch abaixo traz o histórico).
      for (const item of res.items) qc.setQueryData<TransactionDTO>(qk.transaction(item.id), (old) => (old ? { ...old, ...item } : old));
      const n = res.updated;
      const skippedText = res.skipped.length ? skippedSummary(res.skipped) : undefined;
      if (n > 0) {
        if (body.excluded) {
          const title = body.editing
            ? n === 1
              ? "Desconsideração atualizada"
              : `${plural(n, "lançamento atualizado", "lançamentos atualizados")}`
            : n === 1
              ? "Lançamento desconsiderado nos relatórios"
              : `${plural(n, "lançamento desconsiderado", "lançamentos desconsiderados")} nos relatórios`;
          toast.success(title, {
            description: `${EXCLUSION_KEEPS_BALANCE}${skippedText ? ` Não alterados: ${skippedText}` : ""}`,
          });
        } else {
          toast.success(n === 1 ? "Voltou a contar nos relatórios" : `${plural(n, "lançamento voltou", "lançamentos voltaram")} a contar nos relatórios`, {
            description: `O saldo e a fatura continuam iguais.${skippedText ? ` Não alterados: ${skippedText}` : ""}`,
          });
        }
      } else if (res.skipped.length) {
        toast.warning("Nada foi alterado", { description: skippedText });
      }
      invalidateFinance(qc, ["categories", "reports"]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Clientes/pessoas já usados (sugestões do formulário). */
export function useExclusionParties(enabled = true) {
  return useQuery({
    queryKey: qk.exclusionParties,
    queryFn: () => api.get<{ parties: string[] }>("/api/v1/transactions/exclusion-parties"),
    select: (d) => d.parties,
    staleTime: 60_000,
    enabled,
  });
}

/** Sugestões que combinam com o que foi digitado (sem repetir o valor exato). */
export function matchParties(parties: string[] | undefined, typed: string, limit = 6): string[] {
  const t = typed.trim().toLocaleLowerCase("pt-BR");
  const list = parties ?? [];
  const filtered = t ? list.filter((p) => p.toLocaleLowerCase("pt-BR").includes(t) && p.toLocaleLowerCase("pt-BR") !== t) : list;
  return filtered.slice(0, limit);
}

export interface PassthroughParty {
  party: string | null;
  receivedCents: number;
  spentCents: number;
  /** recebido − gasto: positivo = recebido a mais; negativo = a receber do cliente. */
  balanceCents: number;
  count: number;
  firstDate: string;
  lastDate: string;
  /** Lançamentos em moeda estrangeira ainda sem cotação (fora das somas). */
  missingFx: number;
}

export interface PassthroughSummary {
  period: { start: string | null; end: string | null };
  parties: PassthroughParty[];
  totals: { receivedCents: number; spentCents: number; balanceCents: number; count: number };
}

/** Saldo dos repasses de cliente por cliente (null = desde o início). */
export function usePassthrough(period: { start?: string | null; end?: string | null } | null, enabled = true) {
  const params = { start: period?.start ?? undefined, end: period?.end ?? undefined };
  return useQuery({
    queryKey: qk.passthrough(params),
    queryFn: () => api.get<PassthroughSummary>("/api/v1/transactions/passthrough", params),
    staleTime: 30_000,
    enabled,
  });
}

/** Significado do saldo do repasse, em texto. */
export function balanceMeaning(balanceCents: number): { label: string; detail: string | null; tone: "receivable" | "surplus" | "zero" } {
  if (balanceCents < 0) return { label: "A receber do cliente", detail: "gasto a mais do que o recebido", tone: "receivable" };
  if (balanceCents > 0) return { label: "Recebido a mais", detail: "ainda a gastar ou devolver", tone: "surplus" };
  return { label: "Zerado", detail: "recebido e gasto se equilibram", tone: "zero" };
}

/** Mesmo cliente, ignorando maiúsculas e espaços (como o servidor agrupa). */
export function sameParty(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLocaleLowerCase("pt-BR");
  return norm(a) === norm(b);
}
