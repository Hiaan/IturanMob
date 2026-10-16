import type { AccountType, FinancialRule } from "@prisma/client";
import { normalizeText } from "@/lib/utils";
import { findMatchingRule } from "../rules/matcher";

/**
 * Movimentações entre contas da própria família — aplicação/resgate de investimento (CDB, RDB,
 * LCI/LCA, Tesouro, poupança, caixinhas) e transferências "mesma titularidade". Não são receita
 * nem despesa: viram TRANSFERÊNCIA entre a conta do extrato e a conta do outro lado.
 * Rendimento, juros e dividendos continuam sendo receita; IOF/IR/tarifas do resgate, despesa.
 */

export type OwnMoveKind = "INVESTMENT" | "OWN_ACCOUNTS" | "FOREIGN";

export interface AccountLite {
  id: string;
  name: string;
  institution: string | null;
  type: AccountType;
  currency?: string;
}

/** Impostos e tarifas sobre aplicações são despesas de verdade. */
const COSTS = /\b(iof|ir|irrf|imposto|impostos|tarifa|tarifas|tar|taxa|taxas|custodia|corretagem|multa)\b/;
/** Ganhos do investimento são receita. */
const YIELD = /\b(rendimentos?|rend pago|juros|dividendos?|jcp|proventos|remuneracao|bonificacao|cashback)\b/;
const MOVE_VERB = /\b(resgates?|resg|resgatad[oa]s?|aplicac(ao|oes)|aplic|aplicad[oa]s?|investimentos?|invest|dinheiro guardado|dinheiro resgatado|guardad[oa]s?|aporte|aportes)\b/;
// "Caixinha", "cofrinho" e "porquinho" só contam com verbo (aplicação, resgate, guardado):
// sozinhos, podem ser a caixinha do porteiro.
const PRODUCT = /\b(cdb|rdb|lci|lca|cdi|tesouro|poupanca|poup|fundos? (de )?(invest\w*|di|renda fixa|acoes|multimercado)|renda fixa|previdencia privada|pgbl|vgbl)\b/;
/** Remessa/câmbio (Wise, Remitly…): só vira transferência se a família tiver conta em moeda estrangeira. */
const FOREIGN = /\b(remessa|remittance|cambio|corretora de cambio|wise|remitly|western union|payoneer|ordem de pagamento do exterior)\b/;
const OWN_ACCOUNTS = /\b(mesma titularidade|mesmo titular|mesma tit|entre contas|conta propria|contas proprias|transf(erencia)? (para |p\/ )?conta propria)\b/;

/** Movimentação entre contas próprias pela descrição (null = receita/despesa comum). */
export function detectOwnMove(description: string): OwnMoveKind | null {
  const n = normalizeText(description);
  if (!n || COSTS.test(n)) return null;
  const verb = MOVE_VERB.test(n);
  if (YIELD.test(n) && !/\b(resgates?|resg|aplic\w*)\b/.test(n)) return null;
  if (FOREIGN.test(n)) return "FOREIGN";
  if (OWN_ACCOUNTS.test(n)) return "OWN_ACCOUNTS";
  if (verb || PRODUCT.test(n)) return "INVESTMENT";
  return null;
}

export function isInvestmentAccount(a: Pick<AccountLite, "type">): boolean {
  return a.type === "INVESTMENT" || a.type === "SAVINGS";
}

const GENERIC = new Set(["conta", "contas", "corrente", "banco", "digital", "de", "do", "da", "dos", "das", "e", "sa", "s", "a", "o", "minha", "meu", "nossa", "nosso", "pagamento", "pagamentos"]);

function tokens(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !GENERIC.has(t));
}

/** A descrição cita o nome/instituição da conta (ex.: "RESGATE CDB" × conta "CDB Itaú"). */
function mentions(description: string, account: AccountLite): boolean {
  const words = new Set(tokens(description));
  const accTokens = tokens(`${account.name} ${account.institution ?? ""}`);
  return accTokens.some((t) => words.has(t) || (t.length >= 4 && [...words].some((w) => w.length >= 4 && (w.startsWith(t) || t.startsWith(w)))));
}

function sameInstitution(a: AccountLite, b: AccountLite): boolean {
  const ia = normalizeText(a.institution ?? "");
  const ib = normalizeText(b.institution ?? "");
  return Boolean(ia && ib && (ia === ib || ia.includes(ib) || ib.includes(ia)));
}

function narrow(list: AccountLite[], pred: (a: AccountLite) => boolean): AccountLite[] {
  const hit = list.filter(pred);
  return hit.length ? hit : list;
}

/**
 * Conta do outro lado da movimentação. Só devolve quando há uma única opção depois de considerar
 * o nome citado na descrição, o tipo (poupança × investimento) e a mesma instituição.
 */
export function pickCounterpart(description: string, kind: OwnMoveKind, scope: AccountLite, accounts: AccountLite[]): AccountLite | null {
  const others = accounts.filter((a) => a.id !== scope.id && a.type !== "WALLET");
  let candidates: AccountLite[];
  if (kind === "INVESTMENT") {
    candidates = isInvestmentAccount(scope) ? others.filter((a) => !isInvestmentAccount(a)) : others.filter(isInvestmentAccount);
  } else if (kind === "FOREIGN") {
    candidates = others.filter((a) => (a.currency ?? "BRL") !== (scope.currency ?? "BRL"));
  } else {
    candidates = others;
  }
  if (candidates.length <= 1) return candidates[0] ?? null;
  const n = normalizeText(description);
  candidates = narrow(candidates, (a) => mentions(description, a));
  if (candidates.length === 1) return candidates[0]!;
  if (/\bpoup(anca)?\b/.test(n)) candidates = narrow(candidates, (a) => a.type === "SAVINGS");
  else if (kind === "INVESTMENT" && !isInvestmentAccount(scope)) candidates = narrow(candidates, (a) => a.type === "INVESTMENT");
  if (candidates.length === 1) return candidates[0]!;
  // TED "mesma titularidade" costuma ir para outro banco: a instituição só desempata investimentos.
  if (kind !== "INVESTMENT") return null;
  candidates = narrow(candidates, (a) => sameInstitution(a, scope));
  return candidates.length === 1 ? candidates[0]! : null;
}

export interface OwnMove {
  kind: OwnMoveKind | "RULE";
  counterpartId: string | null;
  ruleId: string | null;
}

/** Regra aprendida primeiro; depois a detecção pela descrição. */
export function resolveOwnMove(
  description: string,
  amountCents: number,
  scope: AccountLite,
  accounts: AccountLite[],
  rules: FinancialRule[],
): OwnMove | null {
  const transferRules = rules.filter((r) => r.setTransferAccountId && r.setTransferAccountId !== scope.id);
  if (transferRules.length) {
    // O "tipo" da regra limita o sentido: saída (aplicação) = EXPENSE, entrada (resgate) = INCOME.
    const rule = findMatchingRule(transferRules, { description, merchant: null, amountCents: Math.abs(amountCents), type: amountCents < 0 ? "EXPENSE" : "INCOME", accountId: scope.id });
    if (rule && accounts.some((a) => a.id === rule.setTransferAccountId)) return { kind: "RULE", counterpartId: rule.setTransferAccountId, ruleId: rule.id };
  }
  const kind = detectOwnMove(description);
  if (!kind) return null;
  // Remessa sem conta em outra moeda é recebimento comum (ex.: pagamento do exterior).
  if (kind === "FOREIGN" && !accounts.some((a) => (a.currency ?? "BRL") !== (scope.currency ?? "BRL"))) return null;
  return { kind, counterpartId: pickCounterpart(description, kind, scope, accounts)?.id ?? null, ruleId: null };
}

/** Chave para "linhas parecidas" e para a regra aprendida: palavras sem números/códigos. */
export function similarityKey(description: string | null | undefined): string | null {
  const words = normalizeText(description ?? "")
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !GENERIC.has(w));
  const key = words.slice(0, 3).join(" ");
  return key.length >= 3 ? key : null;
}
