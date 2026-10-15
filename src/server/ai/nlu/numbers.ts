import { parseAmountToCents } from "@/lib/money";
import { normalizeForNlu } from "./text";

/**
 * Extração de valores monetários em português brasileiro, inclusive por extenso:
 * "283,90", "R$ 3.500", "2 mil", "1,5 mil", "2k", "duzentos e trinta e quatro reais e cinquenta centavos",
 * "mil e quinhentos", "dois mil reais", "80 conto".
 *
 * Números que claramente não são valores (parcelas, dias, horas, litros, percentuais, datas) são ignorados.
 */

const UNITS: Record<string, number> = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  catorze: 14,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  cincoenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  cento: 100,
  duzentos: 200,
  duzentas: 200,
  trezentos: 300,
  trezentas: 300,
  quatrocentos: 400,
  quatrocentas: 400,
  quinhentos: 500,
  quinhentas: 500,
  seiscentos: 600,
  seiscentas: 600,
  setecentos: 700,
  setecentas: 700,
  oitocentos: 800,
  oitocentas: 800,
  novecentos: 900,
  novecentas: 900,
};

const SCALES: Record<string, number> = { mil: 1000, milhao: 1_000_000, milhoes: 1_000_000 };
const CURRENCY_WORDS = new Set(["reais", "real", "conto", "contos", "pila", "pilas", "r$"]);
const CENTS_WORDS = new Set(["centavos", "centavo"]);
/** Palavras após um número que indicam que ele NÃO é um valor monetário. */
const NON_MONEY_AFTER = new Set([
  "vezes",
  "vez",
  "x",
  "parcela",
  "parcelas",
  "prestacao",
  "prestacoes",
  "dias",
  "dia",
  "horas",
  "hora",
  "h",
  "min",
  "minutos",
  "meses",
  "mes",
  "anos",
  "ano",
  "litros",
  "litro",
  "l",
  "kg",
  "quilos",
  "km",
  "%",
  "pessoas",
  "unidades",
  "itens",
  "semanas",
]);

export interface AmountMention {
  cents: number;
  /** Índices de palavra [início, fim) no texto normalizado. */
  start: number;
  end: number;
  raw: string;
  /** Acompanhado de "reais", "R$" etc. */
  hasCurrency: boolean;
  /** Valor da parcela ("10 vezes de 240"). */
  isInstallmentValue: boolean;
  /** Valor escrito por extenso. */
  spelled: boolean;
}

function isNumberWord(w: string): boolean {
  return w in UNITS || w in SCALES;
}

/** Converte uma sequência de palavras por extenso em número (sem "e" de centavos). */
export function spelledToNumber(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (t === "e") continue;
    if (t in UNITS) {
      current += UNITS[t]!;
      seen = true;
    } else if (t in SCALES) {
      const scale = SCALES[t]!;
      total += (current || 1) * scale;
      current = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + current : null;
}

function digitToken(w: string): number | null {
  // "2k", "2,5k"
  const k = /^(\d+(?:[.,]\d+)?)k$/.exec(w);
  if (k) {
    const n = Number(k[1]!.replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 100000) : null;
  }
  if (!/^\d[\d.,]*$/.test(w)) return null;
  if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(w)) return null;
  const clean = w.replace(/[.,]$/, "");
  return parseAmountToCents(clean);
}

const PREPOSITIONS = new Set(["na", "no", "nas", "nos", "de", "do", "da", "dos", "das", "em", "com", "pra", "para", "pro", "pela", "pelo", "por", "e", "reais", ""]);
const MONEY_VERBS_BEFORE = new Set(["gastei", "gastou", "gastamos", "gastaram", "paguei", "pagou", "pagamos", "custou", "custaram", "deu", "foi", "foram", "recebi", "recebeu", "recebemos", "ganhei", "transferi", "transferiu", "mandei", "separei", "guardei", "de", "por", "valor", "total", "r$", "entrou", "caiu", "abasteci", "comprei"]);

/** Decide se um número sem indicação de moeda é um valor monetário. */
function isLikelyMoney(p: { tokens: string[]; start: number; end: number; cents: number; rawTok: string; next: string; prev: string; spelled: boolean }): boolean {
  const { tokens, end, cents, rawTok, next, prev, spelled } = p;
  if (/^\d+x$/.test(rawTok)) return false;
  if (/^\d{1,2}[:h]\d{2}$/.test(rawTok)) return false;
  if (NON_MONEY_AFTER.has(next)) return false;
  if (prev === "dia" || prev === "parcela" || prev === "parcelas" || prev === "as" || prev === "das" || prev === "numero") return false;
  if (prev === "em" && (next === "vezes" || next === "x" || next === "parcelas")) return false;
  // "3 camisas por 150": o primeiro número é quantidade.
  for (let k = end; k < Math.min(tokens.length, end + 4); k++) {
    if (tokens[k] === "por" && tokens[k + 1] && /^\d/.test(tokens[k + 1]!)) return false;
  }
  const hasDecimals = /\d[.,]\d{1,2}$/.test(rawTok);
  if (hasDecimals) return true;
  if (spelled) {
    // Por extenso sem moeda: só valores >= 10 seguidos de preposição/fim ("vinte e cinco na farmácia").
    return cents >= 1000 && PREPOSITIONS.has(next);
  }
  if (PREPOSITIONS.has(next) || MONEY_VERBS_BEFORE.has(prev)) return true;
  // Número seguido de substantivo: provável quantidade quando pequeno ("2 pães").
  return cents >= 1000;
}

/** Extrai todas as menções monetárias do texto. */
export function extractAmounts(input: string): AmountMention[] {
  const norm = normalizeForNlu(input).replace(/r\$ /g, "r$ ");
  const tokens = norm.split(" ").map((t) => t.replace(/[.,!?:;]+$/g, ""));
  const result: AmountMention[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    let cents: number | null = null;
    let start = i;
    let end = i + 1;
    let spelled = false;
    let hasCurrency = false;

    if (t === "r$" && i + 1 < tokens.length) {
      hasCurrency = true;
      start = i;
      i++;
    }
    const cur = tokens[i]!;
    const dig = digitToken(cur);
    if (dig !== null) {
      cents = dig;
      end = i + 1;
      // "2 mil", "1,5 mil", "3 mil e 500"
      if (tokens[end] === "mil") {
        cents = Math.round((cents / 100) * 1000) * 100;
        end++;
        if (tokens[end] === "e") {
          const after = tokens[end + 1] ? digitToken(tokens[end + 1]!) : null;
          if (after !== null && after < 100000) {
            cents += after;
            end += 2;
          } else if (tokens[end + 1] && isNumberWord(tokens[end + 1]!)) {
            const seq: string[] = [];
            let j = end + 1;
            while (j < tokens.length && (isNumberWord(tokens[j]!) || (tokens[j] === "e" && j + 1 < tokens.length && isNumberWord(tokens[j + 1]!)))) {
              seq.push(tokens[j]!);
              j++;
            }
            const n = spelledToNumber(seq);
            if (n !== null && n < 1000) {
              cents += n * 100;
              end = j;
            }
          }
        }
      }
    } else if (isNumberWord(cur)) {
      // Sequência por extenso: "duzentos e trinta e quatro"
      const seq: string[] = [];
      let j = i;
      while (j < tokens.length && (isNumberWord(tokens[j]!) || (tokens[j] === "e" && j + 1 < tokens.length && isNumberWord(tokens[j + 1]!) && !CENTS_WORDS.has(tokens[j + 2] ?? "")))) {
        seq.push(tokens[j]!);
        j++;
      }
      const n = spelledToNumber(seq);
      if (n !== null) {
        cents = n * 100;
        end = j;
        spelled = true;
      }
    }

    if (cents === null) {
      i++;
      continue;
    }

    // Moeda após o número
    if (tokens[end] && CURRENCY_WORDS.has(tokens[end]!)) {
      hasCurrency = true;
      end++;
    }
    // Centavos: "e cinquenta centavos" / "e 50 centavos" / "com 50"
    if (tokens[end] === "e" || tokens[end] === "com") {
      const seq: string[] = [];
      let j = end + 1;
      while (j < tokens.length && (isNumberWord(tokens[j]!) || tokens[j] === "e")) {
        seq.push(tokens[j]!);
        j++;
      }
      let centsPart: number | null = null;
      if (seq.length && CENTS_WORDS.has(tokens[j] ?? "")) {
        centsPart = spelledToNumber(seq);
        j++;
      } else if (tokens[end + 1] && /^\d{1,2}$/.test(tokens[end + 1]!) && CENTS_WORDS.has(tokens[end + 2] ?? "")) {
        centsPart = Number(tokens[end + 1]);
        j = end + 3;
      }
      if (centsPart !== null && centsPart < 100 && cents % 100 === 0) {
        cents += centsPart;
        end = j;
      }
    }

    const next = tokens[end] ?? "";
    const prev = tokens[start - 1] ?? "";
    const prev2 = tokens[start - 2] ?? "";
    const rawTok = tokens[start] ?? "";
    const skip = !hasCurrency && !isLikelyMoney({ tokens, start, end, cents, rawTok, next, prev, spelled });
    if (!skip && cents > 0) {
      const installment = (prev === "de" && (prev2 === "vezes" || prev2 === "x" || prev2 === "parcelas" || /^\d+x$/.test(prev2))) || ((prev === "de" || prev === "por") && /^\d+x$/.test(prev2));
      result.push({
        cents,
        start,
        end,
        raw: tokens.slice(start, end).join(" "),
        hasCurrency,
        isInstallmentValue: installment,
        spelled,
      });
    }
    i = Math.max(end, i + 1);
  }
  return result;
}

/** Quantidade de parcelas: "em 10 vezes", "10x", "em 12 parcelas", "três parcelas", "parcelado em 3". */
export function extractInstallments(input: string): number | null {
  const norm = normalizeForNlu(input);
  const patterns = [
    /(?:em|de)\s+(\d{1,2})\s*(?:x|vezes|parcelas|prestacoes)\b/,
    /\b(\d{1,2})\s*x\b/,
    /\b(\d{1,2})\s+(?:vezes|parcelas|prestacoes)\b/,
    /parcelad[oa]\s+em\s+(\d{1,2})/,
  ];
  for (const re of patterns) {
    const m = re.exec(norm);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 72) return n;
    }
  }
  const spelled = /(?:em\s+)?\b(duas|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|dezoito|vinte e quatro)\s+(?:vezes|parcelas|prestacoes)\b/.exec(norm);
  if (spelled) {
    const n = spelledToNumber(spelled[1]!.split(" "));
    if (n && n >= 1 && n <= 72) return n;
  }
  if (/\ba vista\b/.test(norm)) return 1;
  return null;
}

/** Verifica se um valor (centavos) foi efetivamente mencionado no texto (anti-alucinação). */
export function amountMentioned(text: string, cents: number): boolean {
  return extractAmounts(text).some((a) => a.cents === cents);
}
