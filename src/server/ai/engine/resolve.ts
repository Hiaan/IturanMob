import type { HouseholdContext } from "./context";
import type { PaymentMethodValue, RawDraft, DraftKind } from "./schemas";
import { normalizeForNlu } from "../nlu/text";
import { amountMentioned, extractAmounts } from "../nlu/numbers";
import { findMentions, matchCategory } from "../nlu/local-parser";
import { detectInvestmentMessage, isInvestmentAccountType } from "../nlu/investment";
import { findMatchingRule } from "../../modules/rules/matcher";
import { isISODate, addDays } from "@/lib/dates";
import { MAX_AMOUNT_CENTS } from "@/lib/money";

export type Decision = "AUTO" | "CONFIRM" | "CLARIFY";

/** Rascunho resolvido: referências validadas contra os cadastros da própria família. */
export interface ResolvedDraft {
  index: number;
  kind: DraftKind;
  amountCents: number | null;
  description: string;
  merchantName: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  date: string;
  paymentMethod: PaymentMethodValue | null;
  accountId: string | null;
  destinationAccountId: string | null;
  creditCardId: string | null;
  installmentCount: number;
  payerMemberId: string | null;
  ownership: "SHARED" | "INDIVIDUAL";
  responsibleMemberId: string | null;
  goalId: string | null;
  confidence: number;
  missing: string[];
  warnings: string[];
  decision: Decision;
  labels: {
    category: string | null;
    subcategory: string | null;
    account: string | null;
    destinationAccount: string | null;
    card: string | null;
    payer: string | null;
    responsible: string | null;
    goal: string | null;
  };
  /** Regra explícita do usuário aplicada. */
  ruleId: string | null;
  /** Aplicação (IN) ou resgate (OUT) de investimento. */
  investment: "IN" | "OUT" | null;
}

function matchByName<T extends { id: string; name: string; aliases?: string[] }>(hint: string | null | undefined, list: T[]): T | null {
  if (!hint) return null;
  const n = normalizeForNlu(hint);
  if (!n) return null;
  const exact = list.find((x) => normalizeForNlu(x.name) === n);
  if (exact) return exact;
  const mentions = findMentions(n, list.map((x) => ({ id: x.id, aliases: x.aliases ?? [normalizeForNlu(x.name)] })));
  if (mentions.length) return list.find((x) => x.id === mentions[0]!.id) ?? null;
  const partial = list.filter((x) => normalizeForNlu(x.name).includes(n) || n.includes(normalizeForNlu(x.name)));
  return partial.length === 1 ? partial[0]! : null;
}

function resolveCategory(hint: string | null, hc: HouseholdContext, kind: "EXPENSE" | "INCOME", fallbackText: string) {
  if (hint) {
    const [catName, subName] = hint.split(">").map((s) => s.trim());
    const cat = hc.categories.find((c) => c.kind === kind && c.normalized === normalizeForNlu(catName ?? ""));
    if (cat) {
      const sub = subName ? cat.subcategories.find((s) => s.normalized === normalizeForNlu(subName)) : null;
      return { categoryId: cat.id, subcategoryId: sub?.id ?? null, category: cat.name, subcategory: sub?.name ?? null, exact: true };
    }
    // Hint apenas com o nome da subcategoria
    for (const c of hc.categories) {
      if (c.kind !== kind) continue;
      const sub = c.subcategories.find((s) => s.normalized === normalizeForNlu(hint));
      if (sub) return { categoryId: c.id, subcategoryId: sub.id, category: c.name, subcategory: sub.name, exact: true };
    }
  }
  const m = matchCategory(normalizeForNlu(`${hint ?? ""} ${fallbackText}`), hc, kind);
  if (!m) return null;
  const cat = hc.categories.find((c) => c.id === m.categoryId)!;
  const sub = m.subcategoryId ? cat.subcategories.find((s) => s.id === m.subcategoryId) : null;
  return { categoryId: cat.id, subcategoryId: sub?.id ?? null, category: cat.name, subcategory: sub?.name ?? null, exact: false };
}

/** Membro a partir de uma referência ("eu", "remetente", "esposa", nome). */
export function resolveMember(hint: string | null | undefined, hc: HouseholdContext): { id: string; displayName: string } | null {
  if (!hint) return null;
  const n = normalizeForNlu(hint);
  if (["eu", "remetente", "mim", "minha", "meu", "sender"].includes(n) && hc.sender) return { id: hc.sender.memberId, displayName: hc.sender.displayName };
  const byAlias = findMentions(n, hc.members.map((m) => ({ id: m.id, aliases: m.aliases })));
  const candidates = byAlias.length ? byAlias : [];
  if (candidates.length) {
    const m = hc.members.find((x) => x.id === candidates[0]!.id)!;
    return { id: m.id, displayName: m.displayName };
  }
  if (n === "conjuge") {
    const adults = hc.members.filter((m) => m.hasLogin && m.id !== hc.sender?.memberId);
    if (adults.length === 1) return { id: adults[0]!.id, displayName: adults[0]!.displayName };
  }
  const exact = hc.members.find((m) => normalizeForNlu(m.displayName) === n);
  return exact ? { id: exact.id, displayName: exact.displayName } : null;
}

/**
 * Valores a partir deste limite (R$ 10.000,00) nunca são registrados automaticamente, por mais alta
 * que seja a confiança informada pelo modelo: sempre pedem confirmação de quem enviou.
 */
export const LARGE_AMOUNT_CENTS = 1_000_000;

/** Decisão a partir da confiança e dos limites configurados pela família. */
export function decide(confidence: number, missing: string[], hc: Pick<HouseholdContext, "settings">, amountCents?: number | null): Decision {
  if (missing.length) return "CLARIFY";
  if (confidence >= hc.settings.confidenceHigh) return amountCents && amountCents >= LARGE_AMOUNT_CENTS ? "CONFIRM" : "AUTO";
  if (confidence >= hc.settings.confidenceMedium) return "CONFIRM";
  return "CLARIFY";
}

/**
 * Resolve um rascunho bruto (do LLM ou do motor local).
 * Regras anti-alucinação: o valor precisa estar literalmente na mensagem (ou ser derivado
 * de valores informados, como parcela × quantidade); caso contrário, é tratado como ausente.
 */
export function resolveDraft(raw: RawDraft, index: number, hc: HouseholdContext, sourceText: string): ResolvedDraft {
  const missing: string[] = [];
  const warnings: string[] = [];
  let confidence = Math.max(0, Math.min(1, raw.confidence));

  // Aplicação/resgate classificado como receita/despesa (ex.: pelo modelo externo): é transferência.
  const investment =
    raw.investment ??
    (raw.kind === "INCOME" || raw.kind === "EXPENSE" || raw.kind === "TRANSFER" ? detectInvestmentMessage(normalizeForNlu(raw.segment || raw.description)) : null);
  if (investment && raw.kind !== "TRANSFER") {
    raw = { ...raw, kind: "TRANSFER", investment, categoryHint: null, cardHint: null, installments: null, description: investment === "IN" ? "Aplicação" : "Resgate" };
  }

  // --- Valor
  let amountCents = raw.amountCents;
  if (amountCents !== null) {
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) amountCents = null;
  }
  if (amountCents !== null) {
    const mentioned = amountMentioned(sourceText, amountCents);
    const derivedFromInstallment =
      raw.amountIsInstallmentValue && raw.installments && raw.installments > 1 && extractAmounts(sourceText).some((a) => a.cents * raw.installments! === amountCents);
    if (!mentioned && !derivedFromInstallment) {
      // O modelo propôs um valor que não está na mensagem: descartado (nunca inventar).
      warnings.push("O valor sugerido não consta na mensagem e foi descartado.");
      amountCents = null;
    } else if (derivedFromInstallment) {
      warnings.push("Total calculado a partir do valor da parcela informado.");
    }
  }
  if (amountCents === null && raw.kind !== "CARD_PAYMENT") missing.push("valor");

  // --- Data
  let date = raw.date && isISODate(raw.date) ? raw.date : hc.today;
  if (date > addDays(hc.today, 400) || date < addDays(hc.today, -3650)) {
    warnings.push("Data fora do intervalo esperado; usada a data de hoje.");
    date = hc.today;
    confidence = Math.min(confidence, 0.7);
  }

  // --- Contas e cartões
  let account = matchByName(raw.accountHint, hc.accounts);
  let destination = matchByName(raw.destinationAccountHint, hc.accounts);
  let card = matchByName(raw.cardHint, hc.cards);
  if (raw.accountHint && !account) {
    warnings.push(`Conta "${raw.accountHint}" não encontrada.`);
    confidence = Math.min(confidence, 0.7);
  }
  if (raw.cardHint && !card) {
    warnings.push(`Cartão "${raw.cardHint}" não encontrado.`);
    confidence = Math.min(confidence, 0.7);
  }

  let paymentMethod = raw.paymentMethod;
  let installmentCount = raw.installments && raw.installments > 0 ? Math.min(raw.installments, 72) : 1;
  if (raw.kind === "EXPENSE") {
    if (card) paymentMethod = "CREDIT_CARD";
    if (installmentCount > 1 && !paymentMethod) paymentMethod = "CREDIT_CARD";
    if (paymentMethod === "CREDIT_CARD" && !card) {
      if (hc.cards.length === 1) {
        card = hc.cards[0]!;
        warnings.push(`Cartão considerado: ${card.name} (único cadastrado).`);
      } else if (hc.cards.length > 1) {
        missing.push("cartão");
      }
    }
    if (paymentMethod !== "CREDIT_CARD") installmentCount = installmentCount > 1 && paymentMethod === "BANK_SLIP" ? installmentCount : 1;
  }
  // Movimento de caixa sem conta informada: com uma única conta cadastrada, ela é a única possível.
  // Com várias, o lançamento fica com pendência para escolher a conta (nada é presumido).
  if (!account && !raw.accountHint && ((raw.kind === "EXPENSE" && !card && paymentMethod !== "CREDIT_CARD") || raw.kind === "INCOME") && hc.accounts.length === 1) {
    account = hc.accounts[0]!;
    warnings.push(`Conta considerada: ${account.name} (única cadastrada).`);
  }

  // --- Categoria (regra explícita do usuário tem prioridade)
  let categoryId: string | null = null;
  let subcategoryId: string | null = null;
  let categoryLabel: string | null = null;
  let subcategoryLabel: string | null = null;
  let ruleId: string | null = null;
  if (raw.kind === "EXPENSE" || raw.kind === "INCOME") {
    const kind = raw.kind === "INCOME" ? "INCOME" : "EXPENSE";
    const rule = findMatchingRule(
      hc.rules.filter((r) => !r.setTransferAccountId),
      { description: raw.description, merchant: raw.merchant, amountCents: amountCents ?? 0, type: raw.kind },
    );
    if (rule?.setCategoryId) {
      const cat = hc.categories.find((c) => c.id === rule.setCategoryId && c.kind === kind);
      if (cat) {
        categoryId = cat.id;
        subcategoryId = rule.setSubcategoryId ?? null;
        categoryLabel = cat.name;
        subcategoryLabel = cat.subcategories.find((s) => s.id === subcategoryId)?.name ?? null;
        ruleId = rule.id;
        confidence = Math.max(confidence, 0.9);
      }
    }
    if (!categoryId) {
      const res = resolveCategory(raw.categoryHint, hc, kind, `${raw.description} ${raw.merchant ?? ""}`);
      if (res) {
        categoryId = res.categoryId;
        subcategoryId = res.subcategoryId;
        categoryLabel = res.category;
        subcategoryLabel = res.subcategory;
      } else {
        warnings.push("Categoria não identificada.");
        confidence = Math.min(confidence, 0.86);
      }
    }
  }

  // --- Pessoas (quem pagou x responsável)
  const payer = resolveMember(raw.personHint, hc) ?? (hc.sender ? { id: hc.sender.memberId, displayName: hc.sender.displayName } : null);
  if (raw.personHint && !resolveMember(raw.personHint, hc)) {
    warnings.push(`Pessoa "${raw.personHint}" não identificada; considerado o autor da mensagem.`);
    confidence = Math.min(confidence, 0.75);
  }
  const responsible = resolveMember(raw.responsibleHint, hc);
  const ownership: "SHARED" | "INDIVIDUAL" = raw.ownership === "INDIVIDUAL" && (responsible || payer) ? "INDIVIDUAL" : "SHARED";

  // --- Metas, transferências e faturas
  const goal = matchByName(raw.goalHint, hc.goals);
  if (raw.kind === "GOAL_CONTRIBUTION" && !goal) missing.push(hc.goals.length ? "meta" : "meta (nenhuma meta cadastrada)");
  if (raw.kind === "TRANSFER" && investment) {
    // Lado do investimento × lado da conta de movimento, pelo tipo da conta (corrige a ordem trocada).
    const named = [account, destination].filter(Boolean) as typeof hc.accounts;
    let inv = named.find((a) => isInvestmentAccountType(a.type)) ?? null;
    let cash = named.find((a) => !isInvestmentAccountType(a.type)) ?? null;
    const text = normalizeForNlu(`${raw.segment} ${raw.description}`);
    if (!inv) {
      let options = hc.accounts.filter((a) => isInvestmentAccountType(a.type));
      if (/\bpoupanca\b/.test(text) && options.some((a) => a.type === "SAVINGS")) options = options.filter((a) => a.type === "SAVINGS");
      else if (options.some((a) => a.type === "INVESTMENT") && !/\bpoupanca\b/.test(text)) options = options.filter((a) => a.type === "INVESTMENT");
      if (options.length === 1) {
        inv = options[0]!;
        warnings.push(`Conta de investimento considerada: ${inv.name}.`);
      }
    }
    if (!cash) {
      let options = hc.accounts.filter((a) => !isInvestmentAccountType(a.type) && a.type !== "WALLET");
      if (options.length > 1 && inv?.institution) {
        const same = options.filter((a) => a.institution && normalizeForNlu(a.institution) === normalizeForNlu(inv!.institution!));
        if (same.length === 1) options = same;
      }
      if (options.length === 1) {
        cash = options[0]!;
        warnings.push(`Conta considerada: ${cash.name}.`);
      }
    }
    account = investment === "IN" ? cash : inv;
    destination = investment === "IN" ? inv : cash;
    if (inv && /^(aplicacao|resgate)$/.test(normalizeForNlu(raw.description))) raw = { ...raw, description: investment === "IN" ? `Aplicação em ${inv.name}` : `Resgate de ${inv.name}` };
    if (!inv) missing.push(hc.accounts.some((a) => isInvestmentAccountType(a.type)) ? "conta de investimento" : "conta de investimento (nenhuma cadastrada)");
    if (!cash) missing.push(investment === "IN" ? "conta de origem" : "conta de destino");
  } else if (raw.kind === "TRANSFER") {
    if (!account) missing.push("conta de origem");
    if (!destination) missing.push("conta de destino");
    if (account && destination && account.id === destination.id) missing.push("contas diferentes");
  }
  if (raw.kind === "CARD_PAYMENT") {
    if (!card) {
      if (hc.cards.length === 1) card = hc.cards[0]!;
      else missing.push("cartão");
    }
  }

  const resolved: ResolvedDraft = {
    index,
    kind: raw.kind,
    amountCents,
    description: raw.description?.trim().slice(0, 200) || (raw.kind === "INCOME" ? "Receita" : "Despesa"),
    merchantName: raw.merchant?.trim().slice(0, 120) || null,
    categoryId,
    subcategoryId,
    date,
    paymentMethod,
    accountId: raw.kind === "EXPENSE" && card ? null : account?.id ?? null,
    destinationAccountId: destination?.id ?? null,
    creditCardId: raw.kind === "EXPENSE" || raw.kind === "CARD_PAYMENT" ? card?.id ?? null : null,
    installmentCount: raw.kind === "EXPENSE" ? installmentCount : 1,
    payerMemberId: payer?.id ?? null,
    ownership,
    responsibleMemberId: ownership === "INDIVIDUAL" ? responsible?.id ?? payer?.id ?? null : null,
    goalId: goal?.id ?? null,
    confidence: Math.round(confidence * 100) / 100,
    missing,
    warnings,
    decision: "CLARIFY",
    labels: {
      category: categoryLabel,
      subcategory: subcategoryLabel,
      account: account?.name ?? null,
      destinationAccount: destination?.name ?? null,
      card: card?.name ?? null,
      payer: payer?.displayName ?? null,
      responsible: ownership === "INDIVIDUAL" ? responsible?.displayName ?? payer?.displayName ?? null : null,
      goal: goal?.name ?? null,
    },
    ruleId,
    investment: raw.kind === "TRANSFER" ? investment : null,
  };
  resolved.decision = decide(resolved.confidence, missing, hc, resolved.amountCents);
  if (resolved.decision === "CONFIRM" && (resolved.amountCents ?? 0) >= LARGE_AMOUNT_CENTS) warnings.push("Valor alto: confirme antes de registrar.");
  return resolved;
}
