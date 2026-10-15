import { normalizeText } from "@/lib/utils";
import { sha256Hex } from "../../crypto";

/**
 * Funções puras de conciliação: similaridade de descrições, impressão digital de linhas
 * importadas e detecção de padrões (pagamento de fatura, parcelas, créditos de cartão).
 */

/** Palavras genéricas de extrato que não ajudam a identificar o estabelecimento. */
const STOPWORDS = new Set([
  "compra",
  "compras",
  "cartao",
  "debito",
  "credito",
  "deb",
  "cred",
  "pix",
  "pagamento",
  "pagto",
  "pgto",
  "transferencia",
  "transf",
  "enviado",
  "enviada",
  "recebido",
  "recebida",
  "ted",
  "doc",
  "com",
  "para",
  "das",
  "dos",
  "visa",
  "master",
  "mastercard",
  "elo",
  "maestro",
  "parcela",
  "parc",
  "ltda",
  "eireli",
  "bra",
  "brasil",
  "aut",
  "automatico",
  "boleto",
  "conta",
  "nacional",
  "internacional",
  "int",
  "nac",
  "online",
  "app",
  "via",
  "est",
  "estab",
]);

export function descriptionTokens(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) return a.startsWith(b) || b.startsWith(a);
  return false;
}

/**
 * Similaridade por contenção (0..1): fração das palavras relevantes da descrição mais curta
 * presentes na outra. "Mercado" × "COMPRA CARTAO MERCADO EXTRA 1234" → 1.
 */
export function descriptionSimilarity(a: string, b: string): number {
  const ta = [...new Set(descriptionTokens(a))];
  const tb = [...new Set(descriptionTokens(b))];
  if (!ta.length || !tb.length) return 0;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  let hits = 0;
  for (const t of small) if (large.some((u) => tokenMatch(t, u))) hits++;
  return hits / small.length;
}

/** Impressão digital da linha: escopo (conta/cartão) + data + valor + descrição + ocorrência no arquivo. */
export function importRowFingerprint(scopeKey: string, date: string, amountCents: number, description: string, occurrence: number): string {
  return sha256Hex(`${scopeKey}|${date}|${amountCents}|${normalizeText(description)}|${occurrence}`).slice(0, 40);
}

/** Linha do extrato bancário que é pagamento de fatura de cartão (não é despesa). */
export function looksLikeCardBillPayment(description: string): boolean {
  const n = normalizeText(description);
  return /\b(pagamento|pagto|pgto|pag)( de| da| do)? (fatura|cartao)\b/.test(n) || /\bfatura( do| de)? cartao\b/.test(n) || /\bcartao de credito\b/.test(n);
}

/** Linha da fatura do cartão que é pagamento, estorno ou crédito (não é compra). */
export function looksLikeCardCredit(description: string): boolean {
  const n = normalizeText(description);
  return /\b(pagamento|pagto|pgto|estorno|devolucao|reembolso|cashback|credito de|ajuste a credito|desconto)\b/.test(n);
}

/** Marcação de parcela no extrato do cartão ("PARC 02/10", "PARCELA 3 DE 12"). */
export function detectInstallment(description: string): { number: number; total: number } | null {
  const m = /\bparc(?:ela)?\.?\s*(\d{1,2})\s*(?:\/|de|-)\s*(\d{1,2})\b/i.exec(description);
  if (!m) return null;
  const number = Number(m[1]);
  const total = Number(m[2]);
  if (number < 1 || total < 2 || number > total || total > 72) return null;
  return { number, total };
}
