/**
 * Utilitários monetários. Todos os valores são inteiros em centavos.
 * Nunca usar ponto flutuante para cálculos financeiros.
 */

/** Limite por valor individual: R$ 10.000.000,00. */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const brlCompactFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Formata centavos como moeda brasileira: 123456 → "R$ 1.234,56". */
export function formatBRL(cents: number | null | undefined, opts?: { signed?: boolean; compact?: boolean }): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
  const value = cents / 100;
  const formatted = (opts?.compact ? brlCompactFormatter : brlFormatter).format(Math.abs(value)).replace(/ /g, " ");
  if (cents < 0) return `-${formatted}`;
  if (opts?.signed && cents > 0) return `+${formatted}`;
  return formatted;
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** Formata centavos na moeda indicada (BRL → "R$ 1,00"; USD → "US$ 1,00"; EUR → "€ 1,00"). */
export function formatMoney(cents: number | null | undefined, currency: string = "BRL", opts?: { signed?: boolean }): string {
  if (!currency || currency === "BRL") return formatBRL(cents, opts);
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
  let f = moneyFormatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("pt-BR", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    moneyFormatters.set(currency, f);
  }
  const formatted = f.format(Math.abs(cents / 100)).replace(/ /g, " ");
  if (cents < 0) return `-${formatted}`;
  if (opts?.signed && cents > 0) return `+${formatted}`;
  return formatted;
}

/** Formata centavos sem símbolo: 123456 → "1.234,56". */
export function formatAmount(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Converte centavos em string decimal com ponto: 123456 → "1234.56" (exportações). */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Converte texto numérico (formatos brasileiro e internacional) em centavos.
 * Exemplos: "1.234,56" → 123456; "283,90" → 28390; "3.500" → 350000; "45" → 4500;
 * "R$ 12.50" → 1250; "-10,00" → -1000. Retorna null se não for um valor válido.
 */
export function parseAmountToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  let s = input.trim().replace(/\s+/g, "").replace(/^R\$/i, "").replace(/R\$/gi, "");
  if (!s) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let integerPart: string;
  let decimalPart = "";

  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? "." : ",";
    const thouSep = decSep === "." ? "," : ".";
    const idx = s.lastIndexOf(decSep);
    integerPart = s.slice(0, idx).split(thouSep).join("");
    decimalPart = s.slice(idx + 1);
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = s.split(sep);
    const last = parts[parts.length - 1] ?? "";
    // Um único separador seguido de exatamente 3 dígitos é separador de milhar ("3.500"),
    // exceto quando há mais de um grupo inconsistente.
    const looksLikeThousands = parts.length > 2 || (last.length === 3 && (parts[0]?.length ?? 0) <= 3 && parts[0] !== "0");
    if (looksLikeThousands && parts.slice(1).every((p) => p.length === 3)) {
      integerPart = parts.join("");
    } else if (parts.length === 2) {
      integerPart = parts[0] ?? "";
      decimalPart = last;
    } else {
      return null;
    }
  } else {
    integerPart = s;
  }

  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(decimalPart)) return null;
  if (decimalPart.length > 2) return null;
  if (!integerPart && !decimalPart) return null;
  const cents = Number(integerPart || "0") * 100 + Number((decimalPart + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Divide um total em N partes inteiras. O resto (centavos) vai para a primeira parte,
 * como é praxe nas administradoras de cartão brasileiras.
 * splitEvenly(1000, 3) → [334, 333, 333]
 */
export function splitEvenly(totalCents: number, parts: number): number[] {
  if (!Number.isInteger(totalCents) || !Number.isInteger(parts) || parts < 1) {
    throw new Error("splitEvenly: parâmetros inválidos");
  }
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  return Array.from({ length: parts }, (_, i) => (i === 0 ? base + remainder : base));
}

/** Divide proporcionalmente a pesos inteiros, preservando o total exato. */
export function splitByWeights(totalCents: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new Error("splitByWeights: pesos inválidos");
  const raw = weights.map((w) => Math.floor((totalCents * w) / totalWeight));
  let diff = totalCents - raw.reduce((a, b) => a + b, 0);
  for (let i = 0; diff > 0; i = (i + 1) % raw.length, diff--) raw[i] = (raw[i] ?? 0) + 1;
  return raw;
}

export function sumCents(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}

/** Percentual (0..100+) com 1 casa decimal. Retorna null se a base for zero. */
export function percentOf(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Variação percentual entre dois valores. Null quando a base é zero. */
export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export function isValidAmountCents(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_AMOUNT_CENTS;
}
