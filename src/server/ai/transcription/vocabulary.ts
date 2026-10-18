import { prisma } from "../../db";
import { normalizeText } from "@/lib/utils";
import type { TranscriptVocabulary } from "../nlu/transcript";

/**
 * Vocabulário da família para a transcrição: entra no prompt do Whisper (para ele já ouvir "Ícaro",
 * "Nubank", "empresa") e na correção do texto depois dela. Ordenado por uso; o prompt fica em
 * ~200 tokens (o Whisper usa no máximo 224 e corta o começo).
 */

export const BASE_PROMPT =
  "Mensagem de controle financeiro familiar em português do Brasil: valores em reais e centavos, cartão de crédito, débito, Pix, parcelas, mercado, farmácia.";
/** Vale para qualquer família (não identifica ninguém). */
export const NATURE_PROMPT = "Natureza: empresa, pessoal, PJ, PF.";
/** Orçamento de caracteres do trecho da família (~140 tokens em português). */
const FAMILY_BUDGET = 480;

/** Palavras de nomes de contas/cartões que não identificam nada ("Conta Corrente", "Crédito"). */
const GENERIC_ACCOUNT_WORDS = new Set(
  "conta contas corrente poupanca cartao credito debito digital carteira dinheiro investimento investimentos reserva black gold platinum visa master mastercard elo internacional pessoal empresa principal".split(" "),
);
/** Palavras com inicial maiúscula nas descrições que não são nomes. */
const NOT_NAMES = new Set(
  "pix compra compras pagamento pagto transferencia ted doc deposito saque boleto fatura parcela parcelas mercado supermercado farmacia padaria almoco jantar lanche uber gasolina combustivel posto aluguel luz agua internet energia salario despesa receita lancamento importado ajuste de do da dos das para pro pra com no na em e o a os as".split(" "),
);

export interface FamilyVocabulary extends TranscriptVocabulary {
  categories: string[];
}

function addScored(map: Map<string, { text: string; score: number }>, text: string | null | undefined, score: number) {
  const t = text?.trim();
  if (!t || t.length < 2 || t.length > 40) return;
  const k = normalizeText(t);
  const cur = map.get(k);
  if (cur) cur.score += score;
  else map.set(k, { text: t, score });
}

const ranked = (map: Map<string, { text: string; score: number }>) => [...map.values()].sort((a, b) => b.score - a.score).map((v) => v.text);

export async function familyVocabulary(householdId: string): Promise<FamilyVocabulary> {
  const since = new Date(Date.now() - 180 * 86_400_000);
  const [members, accounts, cards, byAccount, byCard, categories, byCategory, rules, parties, recent] = await Promise.all([
    prisma.householdMember.findMany({ where: { householdId, isActive: true }, select: { displayName: true } }),
    prisma.account.findMany({ where: { householdId, archivedAt: null }, select: { id: true, name: true, institution: true } }),
    prisma.creditCard.findMany({ where: { householdId, archivedAt: null }, select: { id: true, name: true, issuer: true } }),
    prisma.transaction.groupBy({ by: ["accountId"], where: { householdId, deletedAt: null, date: { gte: since }, accountId: { not: null } }, _count: { _all: true } }),
    prisma.transaction.groupBy({ by: ["creditCardId"], where: { householdId, deletedAt: null, date: { gte: since }, creditCardId: { not: null } }, _count: { _all: true } }),
    prisma.category.findMany({ where: { householdId, archivedAt: null }, select: { id: true, name: true } }),
    prisma.transaction.groupBy({ by: ["categoryId"], where: { householdId, deletedAt: null, date: { gte: since }, categoryId: { not: null } }, _count: { _all: true } }),
    prisma.financialRule.findMany({ where: { householdId, active: true }, select: { pattern: true, setExclusionParty: true, timesApplied: true } }),
    prisma.transaction.groupBy({ by: ["exclusionParty"], where: { householdId, deletedAt: null, exclusionParty: { not: null } }, _count: { _all: true } }),
    prisma.transaction.findMany({ where: { householdId, deletedAt: null, date: { gte: since } }, orderBy: { date: "desc" }, take: 1500, select: { description: true } }),
  ]);

  // Contas e cartões, por uso (o nome inteiro e as palavras marcantes: "Nubank", "Inter", "Wise").
  const accountUse = new Map(byAccount.map((r) => [r.accountId!, r._count._all]));
  const cardUse = new Map(byCard.map((r) => [r.creditCardId!, r._count._all]));
  const acc = new Map<string, { text: string; score: number }>();
  const addAccount = (name: string, extra: string | null, uses: number) => {
    for (const source of [name, extra]) {
      if (!source) continue;
      for (const word of source.split(/\s+/)) {
        const n = normalizeText(word);
        if (n.length >= 3 && !GENERIC_ACCOUNT_WORDS.has(n) && !/^\d+$/.test(n)) addScored(acc, word, 10 + uses);
      }
    }
  };
  for (const a of accounts) addAccount(a.name, a.institution, accountUse.get(a.id) ?? 0);
  for (const c of cards) addAccount(c.name, c.issuer, cardUse.get(c.id) ?? 0);

  // Pessoas: membros, clientes/pessoas das regras e dos repasses, nomes que aparecem nas descrições.
  const names = new Map<string, { text: string; score: number }>();
  for (const m of members) for (const w of m.displayName.split(/\s+/)) addScored(names, w, 1000);
  for (const r of rules) addScored(names, r.setExclusionParty, 200 + r.timesApplied);
  for (const p of parties) addScored(names, p.exclusionParty, 50 + p._count._all * 10);
  const rulePatterns = new Set(rules.map((r) => normalizeText(r.pattern)).flatMap((p) => p.split(/\s+/)));
  const accountWords = new Set([...acc.keys()]);
  const categoryWords = new Set(categories.map((c) => normalizeText(c.name)));
  for (const t of recent) {
    for (const word of t.description.split(/[\s,.;:()/-]+/)) {
      if (!/^\p{Lu}\p{Ll}{2,}$/u.test(word)) continue;
      const n = normalizeText(word);
      if (NOT_NAMES.has(n) || accountWords.has(n) || categoryWords.has(n)) continue;
      // Nome que também é padrão de regra (ex.: Pix para o Ícaro aprendido) pesa mais.
      addScored(names, word, rulePatterns.has(n) ? 5 : 1);
    }
  }

  const categoryUse = new Map(byCategory.map((r) => [r.categoryId!, r._count._all]));
  const cats = categories
    .map((c) => ({ text: c.name, score: categoryUse.get(c.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .map((c) => c.text);

  return { accounts: ranked(acc), names: ranked(names).filter((n) => !/^\d/.test(n)), categories: cats };
}

/** Lista "A, B, C" até o orçamento de caracteres. */
function fit(items: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    if (used + item.length + 2 > budget) break;
    out.push(item);
    used += item.length + 2;
  }
  return out;
}

/**
 * Prompt da transcrição. Com `external` (provedor fora do servidor da família), vai só o texto
 * genérico — nomes de pessoas e contas não saem para terceiros.
 */
export function transcriptionPrompt(vocab: FamilyVocabulary | null, external: boolean): string {
  if (external || !vocab) return `${BASE_PROMPT} ${NATURE_PROMPT}`;
  const accounts = fit(vocab.accounts, 140);
  const names = fit(vocab.names, 200);
  const categories = fit(vocab.categories, Math.max(60, FAMILY_BUDGET - 140 - 200));
  // O Whisper corta o começo quando passa do limite: o mais importante fica no fim.
  const parts = [
    BASE_PROMPT,
    categories.length ? `Categorias: ${categories.join(", ")}.` : "",
    accounts.length ? `Contas e cartões: ${accounts.join(", ")}.` : "",
    names.length ? `Pessoas: ${names.join(", ")}.` : "",
    NATURE_PROMPT,
  ];
  return parts.filter(Boolean).join(" ");
}
