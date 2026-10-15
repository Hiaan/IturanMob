/**
 * Busca inteligente de transações (funções puras, executadas no cliente).
 *
 * Interpreta trechos do texto digitado e os converte em filtros estruturados:
 * valores ("R$ 50", "acima de 100", "entre 50 e 80"), datas ("15/10", "ontem", "outubro"),
 * pessoas (nome dos membros), categorias/subcategorias (pelo nome), formas de pagamento
 * ("pix", "débito"), tipo ("receitas"), origem ("whatsapp", "áudio") e situação ("pendentes").
 * O restante do texto continua sendo buscado em descrição, observações, estabelecimento e categoria.
 */
import { parseAmountToCents, formatBRL } from "@/lib/money";
import { addDays, endOfMonth, formatDateBR, formatMonthBR, isISODate, makeISO, monthKeyFromParts, monthRange, startOfMonth, addMonths } from "@/lib/dates";
import { normalizeText } from "@/lib/utils";

export interface SmartEntities {
  members: Array<{ id: string; displayName: string }>;
  categories: Array<{ id: string; name: string; archivedAt: string | null; subcategories: Array<{ id: string; name: string; archivedAt: string | null }> }>;
}

export interface SmartPatch {
  start?: string;
  end?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  memberId?: string;
  categoryIds?: string[];
  subcategoryId?: string;
  paymentMethods?: string[];
  types?: string[];
  sources?: string[];
  status?: "PENDING" | "CONFIRMED";
  uncategorized?: boolean;
}

export interface SmartToken {
  /** Trecho original reconhecido (usado para removê-lo do texto). */
  raw: string;
  kind: "amount" | "date" | "person" | "category" | "payment" | "type" | "source" | "status";
  label: string;
}

export interface SmartResult {
  search: string;
  patch: SmartPatch;
  tokens: SmartToken[];
}

const L = "\\p{L}\\p{N}";
const before = `(?<![${L}])`;
const after = `(?![${L}])`;

function wordRe(body: string) {
  return new RegExp(`${before}(?:${body})${after}`, "giu");
}

/** Regex insensível a acentos para um nome (ex.: "João" casa "joao" e "JOÃO"). */
function accentInsensitive(name: string): string {
  const map: Record<string, string> = { a: "[aáàâãä]", e: "[eéèêë]", i: "[iíìîï]", o: "[oóòôõö]", u: "[uúùûü]", c: "[cç]", n: "[nñ]" };
  return normalizeText(name)
    .split(" ")
    .filter(Boolean)
    .map((w) => [...w].map((ch) => map[ch] ?? ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(""))
    .join("\\s+");
}

const MONTHS: Array<[string, number]> = [
  ["janeiro", 1],
  ["fevereiro", 2],
  ["mar[cç]o", 3],
  ["abril", 4],
  ["maio", 5],
  ["junho", 6],
  ["julho", 7],
  ["agosto", 8],
  ["setembro", 9],
  ["outubro", 10],
  ["novembro", 11],
  ["dezembro", 12],
];

const PAYMENT_PATTERNS: Array<[string, string, string]> = [
  ["d[eé]bito\\s+autom[aá]tico", "AUTO_DEBIT", "Débito automático"],
  ["cart[aã]o\\s+de\\s+cr[eé]dito|cr[eé]dito", "CREDIT_CARD", "Cartão de crédito"],
  ["cart[aã]o\\s+de\\s+d[eé]bito|d[eé]bito", "DEBIT_CARD", "Cartão de débito"],
  ["pix", "PIX", "Pix"],
  ["dinheiro|esp[eé]cie", "CASH", "Dinheiro"],
  ["boleto", "BANK_SLIP", "Boleto"],
  ["transfer[eê]ncia\\s+banc[aá]ria|ted|doc", "BANK_TRANSFER", "Transferência bancária"],
  ["vale[\\s-]+(?:refei[cç][aã]o|alimenta[cç][aã]o)|vr", "VOUCHER", "Vale (VR/VA)"],
];

const TYPE_PATTERNS: Array<[string, string, string]> = [
  ["receitas?", "INCOME", "Receitas"],
  ["despesas?|gastos?", "EXPENSE", "Despesas"],
  ["transfer[eê]ncias?", "TRANSFER", "Transferências"],
];

const SOURCE_PATTERNS: Array<[string, string[], string]> = [
  ["[aá]udios?", ["WHATSAPP_AUDIO"], "Origem: áudio"],
  ["comprovantes?|fotos?", ["WHATSAPP_IMAGE"], "Origem: comprovante"],
  ["whats\\s?app|zap", ["WHATSAPP_TEXT", "WHATSAPP_AUDIO", "WHATSAPP_IMAGE"], "Origem: WhatsApp"],
  ["importa[cç][aã]o|importad[oa]s?", ["IMPORT"], "Origem: importação"],
];

const STOPWORDS = new Set(["de", "do", "da", "dos", "das", "a", "o", "as", "os", "e", "em", "no", "na", "nos", "nas", "com", "por", "para", "pra", "entre", "ate", "até", "no", "dia", "valor", "valores", "r$"]);

const NUM = "(?:r\\$\\s*)?(\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?![\\d/])";

function cents(s: string | undefined): number | null {
  if (!s) return null;
  const v = parseAmountToCents(s);
  return v !== null && v >= 0 ? v : null;
}

export function parseSmartSearch(input: string, today: string, entities: SmartEntities): SmartResult {
  let text = ` ${input} `;
  const tokens: SmartToken[] = [];
  const patch: SmartPatch = {};

  const take = (re: RegExp, fn: (m: RegExpExecArray) => SmartToken | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const found: Array<{ raw: string; tok: SmartToken }> = [];
    while ((m = re.exec(text))) {
      const tok = fn(m);
      if (tok) found.push({ raw: m[0], tok });
      if (m[0].length === 0) re.lastIndex++;
    }
    for (const f of found) {
      text = text.replace(f.raw, " ");
      tokens.push({ ...f.tok, raw: f.raw.trim() });
    }
  };

  // --- Valores -------------------------------------------------------------
  take(new RegExp(`${before}entre\\s+${NUM}\\s+e\\s+${NUM}`, "giu"), (m) => {
    const a = cents(m[1]);
    const b = cents(m[2]);
    if (a === null || b === null) return null;
    patch.minAmountCents = Math.min(a, b);
    patch.maxAmountCents = Math.max(a, b);
    return { raw: m[0], kind: "amount", label: `Valor entre ${formatBRL(patch.minAmountCents)} e ${formatBRL(patch.maxAmountCents)}` };
  });
  take(new RegExp(`(?:${before}(?:acima\\s+de|mais\\s+de|maior(?:es)?\\s+que|a\\s+partir\\s+de)|>=?)\\s*${NUM}`, "giu"), (m) => {
    const a = cents(m[1]);
    if (a === null) return null;
    patch.minAmountCents = a;
    return { raw: m[0], kind: "amount", label: `Valor a partir de ${formatBRL(a)}` };
  });
  take(new RegExp(`(?:${before}(?:abaixo\\s+de|menos\\s+de|menor(?:es)?\\s+que|at[eé])|<=?)\\s*${NUM}`, "giu"), (m) => {
    const a = cents(m[1]);
    if (a === null) return null;
    patch.maxAmountCents = a;
    return { raw: m[0], kind: "amount", label: `Valor até ${formatBRL(a)}` };
  });
  // Valor exato: "R$ 50" ou número com centavos ("283,90", "1.234,56").
  take(new RegExp(`(?:r\\$\\s*(\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)|${before}(\\d{1,3}(?:\\.\\d{3})*,\\d{2}))(?![\\d/])`, "giu"), (m) => {
    const a = cents(m[1] ?? m[2]);
    if (a === null || a === 0) return null;
    patch.minAmountCents = a;
    patch.maxAmountCents = a;
    return { raw: m[0], kind: "amount", label: `Valor ${formatBRL(a)}` };
  });

  // --- Datas ---------------------------------------------------------------
  const year = Number(today.slice(0, 4));
  const dates: string[] = [];
  take(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/gu, (m) => {
    let y = m[3] ? Number(m[3]) : year;
    if (y < 100) y += 2000;
    const iso = makeISO(y, Number(m[2]), Number(m[1]));
    if (!isISODate(iso)) return null;
    dates.push(iso);
    return { raw: m[0], kind: "date", label: formatDateBR(iso) };
  });
  take(wordRe("anteontem|ontem|hoje"), (m) => {
    const w = normalizeText(m[0]);
    const iso = w === "hoje" ? today : w === "ontem" ? addDays(today, -1) : addDays(today, -2);
    dates.push(iso);
    return { raw: m[0], kind: "date", label: w === "hoje" ? "Hoje" : w === "ontem" ? "Ontem" : "Anteontem" };
  });
  if (dates.length) {
    const sorted = [...dates].sort();
    patch.start = sorted[0];
    patch.end = sorted[sorted.length - 1];
  } else {
    take(wordRe("m[eê]s\\s+passado|m[eê]s\\s+anterior"), (m) => {
      const prev = addMonths(startOfMonth(today), -1);
      patch.start = prev;
      patch.end = endOfMonth(prev);
      return { raw: m[0], kind: "date", label: "Mês anterior" };
    });
    take(wordRe("(?:este|esse|neste|nesse)\\s+m[eê]s"), (m) => {
      patch.start = startOfMonth(today);
      patch.end = endOfMonth(today);
      return { raw: m[0], kind: "date", label: "Este mês" };
    });
    if (!patch.start) {
      take(wordRe(`(${MONTHS.map(([p]) => p).join("|")})(?:\\s+(?:de\\s+)?(\\d{4}))?`), (m) => {
        const name = normalizeText(m[1] ?? "");
        const month = MONTHS.find(([p]) => new RegExp(`^${p}$`, "u").test(name))?.[1];
        if (!month) return null;
        let y = m[2] ? Number(m[2]) : year;
        if (!m[2] && monthKeyFromParts(y, month) > today.slice(0, 7)) y -= 1;
        const key = monthKeyFromParts(y, month);
        const r = monthRange(key);
        patch.start = r.start;
        patch.end = r.end;
        return { raw: m[0], kind: "date", label: formatMonthBR(key, { capitalize: true }) };
      });
    }
  }

  // --- Situação / tipo / origem / forma de pagamento -------------------------
  take(wordRe("sem\\s+categoria|n[aã]o\\s+categorizad[oa]s?"), (m) => {
    patch.uncategorized = true;
    return { raw: m[0], kind: "status", label: "Sem categoria" };
  });
  take(wordRe("pendentes?|a\\s+confirmar|aguardando\\s+confirma[cç][aã]o"), (m) => {
    patch.status = "PENDING";
    return { raw: m[0], kind: "status", label: "Pendentes" };
  });
  for (const [re, value, label] of PAYMENT_PATTERNS) {
    take(wordRe(re), (m) => {
      patch.paymentMethods = [...new Set([...(patch.paymentMethods ?? []), value])];
      return { raw: m[0], kind: "payment", label };
    });
  }
  for (const [re, value, label] of TYPE_PATTERNS) {
    take(wordRe(re), (m) => {
      patch.types = [...new Set([...(patch.types ?? []), value])];
      return { raw: m[0], kind: "type", label };
    });
  }
  for (const [re, values, label] of SOURCE_PATTERNS) {
    take(wordRe(re), (m) => {
      patch.sources = [...new Set([...(patch.sources ?? []), ...values])];
      return { raw: m[0], kind: "source", label };
    });
  }

  // --- Pessoas (nome completo ou primeiro nome) -----------------------------
  for (const member of entities.members) {
    const names = [member.displayName, member.displayName.split(/\s+/)[0] ?? ""].filter((n) => normalizeText(n).length >= 3);
    for (const n of names) {
      if (patch.memberId) break;
      take(wordRe(accentInsensitive(n)), (m) => {
        if (patch.memberId) return null;
        patch.memberId = member.id;
        return { raw: m[0], kind: "person", label: `Pessoa: ${member.displayName}` };
      });
    }
  }

  // --- Categorias e subcategorias (nome mais longo primeiro) -----------------
  const candidates: Array<{ name: string; categoryId: string; subcategoryId?: string; label: string }> = [];
  for (const c of entities.categories) {
    if (c.archivedAt) continue;
    candidates.push({ name: c.name, categoryId: c.id, label: c.name });
    for (const s of c.subcategories) if (!s.archivedAt) candidates.push({ name: s.name, categoryId: c.id, subcategoryId: s.id, label: `${c.name} › ${s.name}` });
  }
  candidates.sort((a, b) => b.name.length - a.name.length);
  for (const cand of candidates) {
    if (normalizeText(cand.name).length < 3) continue;
    take(wordRe(accentInsensitive(cand.name)), (m) => {
      if (cand.subcategoryId) {
        if (patch.subcategoryId) return null;
        patch.subcategoryId = cand.subcategoryId;
      } else {
        patch.categoryIds = [...new Set([...(patch.categoryIds ?? []), cand.categoryId])];
      }
      return { raw: m[0], kind: "category", label: `Categoria: ${cand.label}` };
    });
  }

  // --- Texto restante (remove conectivos soltos nas pontas) -----------------
  const words = text.split(/\s+/).filter(Boolean);
  while (words.length && STOPWORDS.has(normalizeText(words[0] ?? "") || (words[0] ?? ""))) words.shift();
  while (words.length && STOPWORDS.has(normalizeText(words[words.length - 1] ?? "") || (words[words.length - 1] ?? ""))) words.pop();
  return { search: words.join(" ").slice(0, 120), patch, tokens };
}

/** Remove um trecho reconhecido do texto digitado (ao descartar um filtro interpretado). */
export function removeToken(input: string, raw: string): string {
  const idx = input.toLowerCase().indexOf(raw.toLowerCase());
  if (idx < 0) return input;
  return `${input.slice(0, idx)} ${input.slice(idx + raw.length)}`.replace(/\s+/g, " ").trim();
}
