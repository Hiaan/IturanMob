import type { FinancialRule } from "@prisma/client";
import { normalizeText } from "@/lib/utils";

export interface RuleSubject {
  description: string;
  merchant?: string | null;
  amountCents: number;
  type: string;
  /** Conta/cartão do lançamento (regras com condição "só nesta conta/cartão"). */
  accountId?: string | null;
  creditCardId?: string | null;
}

function textMatches(rule: Pick<FinancialRule, "matchType" | "pattern">, value: string): boolean {
  if (!value) return false;
  if (rule.matchType === "REGEX") {
    try {
      // Limita o tamanho do padrão para evitar ReDoS.
      if (rule.pattern.length > 200) return false;
      return new RegExp(rule.pattern, "i").test(value);
    } catch {
      return false;
    }
  }
  const v = normalizeText(value);
  const p = normalizeText(rule.pattern);
  if (!p) return false;
  switch (rule.matchType) {
    case "EQUALS":
      return v === p;
    case "STARTS_WITH":
      return v.startsWith(p);
    case "CONTAINS":
    default:
      return ` ${v} `.includes(` ${p} `) || v.includes(p);
  }
}

/** Retorna a primeira regra ativa (menor prioridade numérica) que se aplica. */
export function findMatchingRule<T extends FinancialRule>(rules: T[], subject: RuleSubject): T | null {
  const sorted = [...rules].filter((r) => r.active).sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  for (const rule of sorted) {
    if (rule.transactionType && rule.transactionType !== subject.type) continue;
    if (rule.minAmountCents != null && subject.amountCents < rule.minAmountCents) continue;
    if (rule.maxAmountCents != null && subject.amountCents > rule.maxAmountCents) continue;
    if (rule.matchAccountId && subject.accountId !== rule.matchAccountId) continue;
    if (rule.matchCreditCardId && subject.creditCardId !== rule.matchCreditCardId) continue;
    const fields =
      rule.matchField === "MERCHANT"
        ? [subject.merchant ?? ""]
        : rule.matchField === "DESCRIPTION"
          ? [subject.description]
          : [subject.description, subject.merchant ?? ""];
    if (fields.some((f) => textMatches(rule, f))) return rule;
  }
  return null;
}
