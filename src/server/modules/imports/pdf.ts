import { addDays, isISODate, makeISO, type ISODate } from "@/lib/dates";
import { looksLikeCardCredit } from "./matching";

/**
 * Leitura de extratos bancários e faturas de cartão em PDF (texto), sem IA.
 *
 * 1. O texto de cada página é remontado em linhas e células a partir da posição dos trechos (pdf.js).
 * 2. Linhas com data + valor viram lançamentos. Também reconhece:
 *    - datas "15/10/2026", "15/10", "15 OUT", "15 OUT 2026", "15 de outubro de 2026" (início da linha
 *      ou cabeçalho de dia, como no Nubank e no Inter);
 *    - valores "1.234,56", "-1.234,56", "1.234,56-", "(1.234,56)", "R$ 1.234,56", "−R$ 50,00",
 *      "50,00 D" / "50,00 C" (BB, Caixa); valores em dólar (US$) são ignorados;
 *    - colunas pelo cabeçalho (Valor, Débito/Crédito, Entradas/Saídas, Saldo): saldo nunca vira lançamento;
 *    - seções "Total de entradas/saídas" (Nubank) e palavras da descrição para deduzir o sinal.
 * 3. Linhas de saldo, totais, limites e resumos são ignoradas; descrições quebradas em duas linhas
 *    são juntadas.
 * O resultado passa pela mesma prévia/conciliação dos outros formatos: nada é gravado sem revisão.
 */

/** Minúsculas e sem acentos, preservando a pontuação (datas "15/10", valores "1.234,56"). */
export function normalizePdfText(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height?: number;
  fontSize?: number;
}

export interface PdfCell {
  x: number;
  x2: number;
  text: string;
  /** Posição da célula no texto da linha. */
  start: number;
}

export interface PdfLine {
  page: number;
  y: number;
  cells: PdfCell[];
  text: string;
}

export type PdfStatementKind = "BANK" | "CREDIT_CARD" | "UNKNOWN";

export interface PdfRow {
  date: ISODate;
  description: string;
  /** Centavos com sinal: negativo = saída (no cartão: compra positiva, crédito negativo). */
  amountCents: number;
  /** O sinal foi deduzido (seção ou palavras da descrição), não estava explícito no PDF. */
  inferredSign: boolean;
  line: string;
  page: number;
}

export interface PdfStatement {
  kind: PdfStatementKind;
  bank: string | null;
  /** Banco achado no cabeçalho/rodapé das páginas (não só em descrições de lançamentos). */
  bankConfident: boolean;
  rows: PdfRow[];
  startDate: ISODate | null;
  endDate: ISODate | null;
  pages: number;
  textChars: number;
  warnings: string[];
}

export class PdfPasswordError extends Error {
  constructor() {
    super("O PDF está protegido por senha. Envie uma versão sem senha (no app do banco, baixe ou salve o extrato de novo sem senha).");
    this.name = "PdfPasswordError";
  }
}

export class PdfReadError extends Error {
  constructor(message = "Não consegui abrir o PDF. O arquivo pode estar corrompido.") {
    super(message);
    this.name = "PdfReadError";
  }
}

export const PDF_MAX_PAGES = 60;

// -----------------------------------------------------------------------------
// Texto → linhas
// -----------------------------------------------------------------------------

/** Lê o texto do PDF com posições. Lança PdfPasswordError / PdfReadError. */
export async function readPdfItems(content: Buffer): Promise<{ pages: number; items: PdfTextItem[][] }> {
  const { getDocumentProxy, extractTextItems } = await import("unpdf");
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(new Uint8Array(content));
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "PasswordException" || /password/i.test((err as Error)?.message ?? "")) throw new PdfPasswordError();
    throw new PdfReadError();
  }
  try {
    if (doc.numPages > PDF_MAX_PAGES) throw new PdfReadError(`O PDF tem ${doc.numPages} páginas; o limite é ${PDF_MAX_PAGES}. Divida o período em partes.`);
    const { totalPages, items } = await extractTextItems(doc);
    return { pages: totalPages, items: items.map((page) => page.map((i) => ({ str: i.str, x: i.x, y: i.y, width: i.width, height: i.height, fontSize: i.fontSize }))) };
  } finally {
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

/** Agrupa os trechos de cada página em linhas (mesma altura) e células (trechos próximos). */
export function buildLines(pages: PdfTextItem[][]): PdfLine[] {
  const lines: PdfLine[] = [];
  pages.forEach((items, pageIndex) => {
    const sorted = items.filter((i) => i.str && i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
    const groups: PdfTextItem[][] = [];
    for (const item of sorted) {
      const tol = Math.max(2, (item.fontSize ?? item.height ?? 10) * 0.45);
      const g = groups.find((grp) => Math.abs(grp[0]!.y - item.y) <= tol);
      if (g) g.push(item);
      else groups.push([item]);
    }
    for (const g of groups) {
      g.sort((a, b) => a.x - b.x);
      const cells: PdfCell[] = [];
      for (const item of g) {
        const size = item.fontSize ?? item.height ?? 10;
        const last = cells[cells.length - 1];
        const text = item.str.replace(/\s+/g, " ");
        if (last && item.x - last.x2 <= size * 0.8) {
          const gap = item.x - last.x2 > size * 0.15 && !last.text.endsWith(" ") && !text.startsWith(" ") ? " " : "";
          last.text += gap + text;
          last.x2 = Math.max(last.x2, item.x + item.width);
        } else {
          cells.push({ x: item.x, x2: item.x + item.width, text, start: 0 });
        }
      }
      const clean = cells.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
      if (!clean.length) continue;
      let offset = 0;
      for (const c of clean) {
        c.start = offset;
        offset += c.text.length + 2;
      }
      lines.push({ page: pageIndex + 1, y: g[0]!.y, cells: clean, text: clean.map((c) => c.text).join("  ") });
    }
  });
  return lines;
}

// -----------------------------------------------------------------------------
// Datas e valores
// -----------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const MONTH_RE = "(jan(?:eiro)?|fev(?:ereiro)?|mar(?:co)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)";

interface DateHit {
  day: number;
  month: number;
  year: number | null;
  /** Fim do trecho da data no texto normalizado. */
  end: number;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

/** Data no início do texto (normalizado, minúsculo, sem acentos). */
export function dateAtStart(norm: string): DateHit | null {
  let m = new RegExp(`^(\\d{1,2})\\s+de\\s+${MONTH_RE}\\s+de\\s+(\\d{4})\\b`).exec(norm);
  if (m) return { day: Number(m[1]), month: MONTHS[m[2]!]!, year: Number(m[3]), end: m[0].length };
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/])/.exec(norm);
  if (m) return { day: Number(m[1]), month: Number(m[2]), year: fullYear(m[3]!), end: m[0].length };
  m = new RegExp(`^(\\d{1,2})\\s*[/ ]\\s*${MONTH_RE}\\.?(?:\\s*[/ ]\\s*(\\d{4}))?(?![a-z])`).exec(norm);
  if (m) return { day: Number(m[1]), month: MONTHS[m[2]!]!, year: m[3] ? Number(m[3]) : null, end: m[0].length };
  m = /^(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(norm);
  if (m) return { day: Number(m[1]), month: Number(m[2]), year: null, end: m[0].length };
  return null;
}

/** Todas as datas completas do documento (para deduzir o ano das datas sem ano). */
function fullDates(norm: string): ISODate[] {
  const out: ISODate[] = [];
  for (const m of norm.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const iso = safeISO(Number(m[3]), Number(m[2]), Number(m[1]));
    if (iso) out.push(iso);
  }
  for (const m of norm.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?${MONTH_RE}\\.?\\s+(?:de\\s+)?(\\d{4})\\b`, "g"))) {
    const iso = safeISO(Number(m[3]), MONTHS[m[2]!]!, Number(m[1]));
    if (iso) out.push(iso);
  }
  return out;
}

function safeISO(year: number, month: number, day: number): ISODate | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = makeISO(year, month, day);
  const d = new Date(`${iso}T00:00:00Z`);
  if (!isISODate(iso) || d.getUTCDate() !== day) return null;
  return iso;
}

export interface AmountHit {
  cents: number;
  /** -1 / +1 quando o sinal está explícito; 0 quando não. */
  sign: -1 | 0 | 1;
  /** Posição (início) no texto da linha. */
  index: number;
  end: number;
  /** Lado do crédito/débito marcado por letra (BB, Caixa). */
  marker: "D" | "C" | null;
}

const AMOUNT_RE = /(\()?\s*([-−–+])?\s*(?:r\$)?\s*([-−–])?\s*(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})(?![\d,%])(?:\s*(\)))?(?:([-−–])(?=\s|$))?(?:\s+([dc])\b)?/gi;

/** Valores em reais de um trecho de texto (ignora dólares, percentuais e números sem centavos). */
export function findAmounts(text: string): AmountHit[] {
  const out: AmountHit[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 6), start).toLowerCase();
    if (/u\$\s*$|us\$\s*$|usd\s*$|eur\s*$|€\s*$/.test(before)) continue;
    const intPart = m[4]!.replace(/\./g, "");
    const cents = Number(intPart) * 100 + Number(m[5]);
    if (!Number.isFinite(cents) || cents <= 0) continue;
    const neg = Boolean(m[1] && m[6]) || /[-−–]/.test(m[2] ?? "") || /[-−–]/.test(m[3] ?? "") || /[-−–]/.test(m[7] ?? "");
    const pos = m[2] === "+";
    const marker = m[8] ? (m[8].toUpperCase() as "D" | "C") : null;
    const sign: -1 | 0 | 1 = neg || marker === "D" ? -1 : pos || marker === "C" ? 1 : 0;
    out.push({ cents, sign, index: start, end: start + m[0].length, marker });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Tipo de documento, banco e linhas a ignorar
// -----------------------------------------------------------------------------

/** `re`: como o banco aparece no documento; `alias`: como a família costuma nomear a conta/cartão no app. */
const BANKS: Array<{ name: string; re: RegExp; alias: RegExp }> = [
  { name: "Nubank", re: /\bnubank\b|\bnu pagamentos\b|\bnu financeira\b/, alias: /\bnu(bank| pagamentos)?\b|\broxinho\b/ },
  { name: "Itaú", re: /\bitau\b|\bitau unibanco\b|\biti\b/, alias: /\bitau\b|\biti\b|\bpersonnalite\b|\buniclass\b/ },
  { name: "Bradesco", re: /\bbradesco\b|\bbradescard\b/, alias: /\bbradesco\b|\bbradescard\b|\bnext\b/ },
  { name: "Banco do Brasil", re: /\bbanco do brasil\b|\bourocard\b|\bbb\.com\.br\b/, alias: /\bbanco do brasil\b|\bbb\b|\bourocard\b/ },
  { name: "Caixa", re: /\bcaixa economica\b|\bcaixa\.gov\b|\bcef\b/, alias: /\bcaixa\b|\bcef\b/ },
  { name: "Santander", re: /\bsantander\b/, alias: /\bsantander\b/ },
  { name: "Inter", re: /\bbanco inter\b|\binter\.co\b|\binter&co\b/, alias: /\binter\b/ },
  { name: "C6 Bank", re: /\bc6 ?bank\b|\bbanco c6\b/, alias: /\bc6\b|\bc6 ?bank\b/ },
];

export function detectBank(norm: string): string | null {
  return BANKS.find((b) => b.re.test(norm))?.name ?? null;
}

/**
 * Banco do documento pelo "quadro" das páginas (primeiras e últimas linhas: cabeçalho, agência/conta,
 * rodapé com app e atendimento). Descrições de lançamentos citam outros bancos ("Pix para NU
 * PAGAMENTOS"), então o corpo só decide quando o quadro não cita nenhum — e aí sem confiança.
 */
/** Linhas de identificação/rodapé (app, atendimento, ouvidoria, CNPJ): nunca são lançamento nem continuação. */
const IDENTITY = /\b(app|aplicativo|atendimento|sac|ouvidoria|central de|agencia|cnpj|instituicao|www|com br|extrato|fatura|pagina)\b/;

/** Linhas de canal de atendimento (app, SAC, ouvidoria, site): identificam o emissor onde estiverem. */
const SERVICE_CHANNEL = /\b(app|aplicativo|atendimento|sac|ouvidoria|central de|cnpj|www|com br)\b/;

export function detectBankFromLines(lines: PdfLine[]): { bank: string | null; confident: boolean } {
  const byPage = new Map<number, PdfLine[]>();
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l]);
  const scores = new Map<string, number>();
  for (const pageLines of byPage.values()) {
    pageLines.forEach((l, i) => {
      // Só linhas sem valor: lançamentos citam outros bancos ("Pix para NU PAGAMENTOS").
      if (findAmounts(l.text).length) return;
      const n = normalizePdfText(l.text);
      const flat = n.replace(/\./g, " ");
      const inFrame = i < 8 || i >= pageLines.length - 4;
      // No quadro da página (cabeçalho/rodapé) vale qualquer menção; fora dele, só a linha de canal de
      // atendimento — rodapés longos que aparecem só na última página ("No app do C6 Bank …").
      const weight = inFrame ? (IDENTITY.test(flat) ? 5 : 1) : SERVICE_CHANNEL.test(flat) ? 5 : 0;
      if (!weight) return;
      for (const b of BANKS) if (b.re.test(n)) scores.set(b.name, (scores.get(b.name) ?? 0) + weight);
    });
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (top && (!second || top[1] >= second[1] * 2)) return { bank: top[0], confident: true };
  const body = detectBank(normalizePdfText(lines.map((l) => l.text).join("\n")));
  return { bank: top?.[0] ?? body, confident: false };
}

/** O nome/instituição de uma conta ou cartão do app (texto normalizado) corresponde ao banco identificado no PDF. */
export function bankMatches(bank: string, norm: string): boolean {
  const entry = BANKS.find((b) => b.name === bank);
  return Boolean(entry && (entry.alias.test(norm) || entry.re.test(norm)));
}

export function detectKind(norm: string): PdfStatementKind {
  const count = (re: RegExp) => (norm.match(re) ?? []).length;
  const card =
    count(/\bfatura (do|de) cartao\b|\bfatura do seu cartao\b|\bresumo da fatura\b/g) * 2 +
    count(/\b(data de )?vencimento\b/g) +
    count(/\bpagamento minimo\b|\blimite (total|disponivel|de credito)\b/g) +
    (/\bfatura\b/.test(norm) ? 1 : 0);
  const bank = count(/\bextrato\b/g) * 2 + count(/\b(saldo anterior|saldo do dia|saldo final|saldo em conta|conta corrente|conta de pagamento|agencia)\b/g);
  if (!card && !bank) return "UNKNOWN";
  return card > bank ? "CREDIT_CARD" : "BANK";
}

/** Linhas informativas: saldos, totais, limites, resumos e cabeçalhos. */
const SKIP_LINE =
  /\b(saldo|total|subtotal|limite|valor da fatura|pagamento minimo|valor minimo|encargos previstos|proxima fatura|proximas faturas|melhor dia|resumo|cotacao|taxa de juros|cet\b|custo efetivo|lancamentos futuros|demais faturas|fatura anterior|vencimento|fechamento)\b/;
/** Resumo do mês/período: "Outubro 2026 ( 01/10/2026 - 15/10/2026 ) Entradas: R$ … • Saídas: R$ …". */
const SUMMARY_LINE = /\b(entradas|saidas|creditos|debitos)\s*:\s*(r\$|[+-]?\s*\d)|\(\s*\d{1,2}\/\d{1,2}\/\d{4}\s*(-|a|ate)\s*\d{1,2}\/\d{1,2}\/\d{4}\s*\)/;
const SECTION_IN = /^(total de )?(entradas|creditos|depositos|recebimentos)\b/;
const SECTION_OUT = /^(total de )?(saidas|debitos|pagamentos e saidas|gastos)\b/;
const INCOME_WORDS = /\b(recebid[oa]s?|recebimento|credito em conta|deposito|salario|estorno|rendimento|resgate|reembolso|devolucao|transferencia recebida|ted recebida|doc recebido|pix recebido|cashback)\b/;

interface Columns {
  value: number[];
  debit: number[];
  credit: number[];
  balance: number[];
}

function headerColumns(line: PdfLine): Columns | null {
  const cols: Columns = { value: [], debit: [], credit: [], balance: [] };
  let hits = 0;
  for (const c of line.cells) {
    const n = normalizePdfText(c.text);
    const center = (c.x + c.x2) / 2;
    if (/^(saldo|saldo \(r\$\)|saldo r\$)$/.test(n) || /^saldo\b/.test(n)) cols.balance.push(center);
    else if (/\b(debitos?|saidas?)\b/.test(n) && n.length <= 20) cols.debit.push(center);
    else if (/\b(creditos?|entradas?)\b/.test(n) && n.length <= 20) cols.credit.push(center);
    else if (/^valor\b/.test(n) && n.length <= 20) cols.value.push(center);
    else continue;
    hits++;
  }
  const labelled = cols.value.length + cols.debit.length + cols.credit.length;
  const hasDescription = line.cells.some((c) => /\b(historico|descricao|lancamento|lancamentos|estabelecimento|transacao)\b/.test(normalizePdfText(c.text)));
  return hits >= 2 && labelled >= 1 && (hasDescription || cols.balance.length > 0) ? cols : null;
}

function nearestRole(x: number, cols: Columns): keyof Columns | null {
  let best: { role: keyof Columns; d: number } | null = null;
  for (const role of ["value", "debit", "credit", "balance"] as const) {
    for (const cx of cols[role]) {
      const d = Math.abs(cx - x);
      if (!best || d < best.d) best = { role, d };
    }
  }
  return best && best.d < 90 ? best.role : null;
}

// -----------------------------------------------------------------------------
// Linhas → lançamentos
// -----------------------------------------------------------------------------

/** Data no começo da linha (ou na segunda célula), no texto original. */
const LEADING_DATE = /^\s*(?:\S{1,12}\s{2,})?(\d{1,2}\s+de\s+\p{L}+\s+de\s+\d{4}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{1,2}\s*[/ ]\s*\p{L}{3,9}\.?(?:\s*[/ ]\s*\d{4})?)(?![\d/])/u;

function cleanDescription(text: string, amounts: AmountHit[]): string {
  let s = text;
  for (const a of [...amounts].sort((x, y) => y.index - x.index)) s = s.slice(0, a.index) + " " + s.slice(a.end);
  const d = LEADING_DATE.exec(s);
  if (d && d.index === 0) s = s.slice(0, d.index + d[0].length - d[1]!.length) + " " + s.slice(d.index + d[0].length);
  // Segunda data logo em seguida (data contábil, como no C6: "09/09 09/09 Entradas …").
  s = s.replace(/^\s*\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?(?![\d/])\s+/, " ");
  return s
    .replace(/\bU?S\$\s*\d[\d.,]*/gi, " ")
    .replace(/\bR\$\s*/gi, " ")
    .replace(/[•·*]{2,}\s*\d{4}/g, " ")
    // Números de documento/lote soltos (5+ dígitos) não fazem parte da descrição.
    .replace(/(^|\s)\d{5,}(?=\s|$)/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, "")
    .trim();
}

/** Converte as linhas do PDF em lançamentos. `today` é usado só quando o documento não tem nenhuma data completa. */
export function parseStatementLines(lines: PdfLine[], opts: { today: ISODate; pages?: number }): PdfStatement {
  const fullText = normalizePdfText(lines.map((l) => l.text).join("\n"));
  const kind = detectKind(fullText);
  const { bank, confident: bankConfident } = detectBankFromLines(lines);
  // Extrato que marca as saídas com sinal ("-R$ 8,00", "-245,90"): valor sem sinal é entrada.
  let datedWithAmount = 0;
  let explicitNegative = 0;
  for (const l of lines) {
    const n = normalizePdfText(l.text);
    if (!dateAtStart(n) || SUMMARY_LINE.test(n) || SKIP_LINE.test(n)) continue;
    const first = findAmounts(l.text)[0];
    if (!first) continue;
    datedWithAmount++;
    if (first.sign === -1 && first.marker === null) explicitNegative++;
  }
  const unsignedIsCredit = kind !== "CREDIT_CARD" && explicitNegative >= 2 && explicitNegative / Math.max(1, datedWithAmount) >= 0.15;
  const warnings: string[] = [];
  const docDates = fullDates(fullText).sort();
  const reference = docDates.length ? docDates[docDates.length - 1]! : opts.today;
  const refYear = Number(reference.slice(0, 4));

  const resolveDate = (hit: DateHit): ISODate | null => {
    // Ano fora do intervalo (ex.: "05 OUT 1234", final do cartão): trata como data sem ano.
    if (hit.year && hit.year >= 2000 && hit.year <= 2100) return safeISO(hit.year, hit.month, hit.day);
    const candidate = safeISO(refYear, hit.month, hit.day);
    if (!candidate) return null;
    return candidate > addDays(reference, 7) ? safeISO(refYear - 1, hit.month, hit.day) : candidate;
  };

  const rows: PdfRow[] = [];
  let columns: Columns | null = null;
  let currentDate: ISODate | null = null;
  let section: -1 | 0 | 1 = 0;
  let inferred = 0;
  /** Último lançamento lido e onde começa a descrição dele (x), para aceitar continuações. */
  let last: { row: PdfRow; page: number; appended: number; descX: number } | null = null;

  for (const line of lines) {
    const norm = normalizePdfText(line.text);
    const header = headerColumns(line);
    if (header) {
      columns = header;
      last = null;
      continue;
    }
    if (SUMMARY_LINE.test(norm)) {
      last = null;
      continue;
    }
    if (SECTION_IN.test(norm)) section = 1;
    else if (SECTION_OUT.test(norm)) section = -1;

    const date = dateAtStart(norm) ?? (line.cells.length > 1 ? dateAtStart(normalizePdfText(line.cells[1]!.text)) : null);
    const amounts = findAmounts(line.text);

    if (date && (!amounts.length || SKIP_LINE.test(norm))) {
      // Cabeçalho de dia ("01 OUT 2026", "15 de outubro de 2026 Saldo do dia: R$ 1.000,00").
      const iso = resolveDate(date);
      if (iso && (norm.length - date.end < 4 || SKIP_LINE.test(norm.slice(date.end)))) {
        currentDate = iso;
        section = 0;
        last = null;
        continue;
      }
    }
    if (SKIP_LINE.test(norm) || SECTION_IN.test(norm) || SECTION_OUT.test(norm)) {
      last = null;
      continue;
    }
    if (!amounts.length) {
      // Continuação da descrição da linha anterior (nome do favorecido, cidade etc.).
      const footer = IDENTITY.test(norm.replace(/\./g, " "));
      if (footer) {
        // Rodapé (app, atendimento, ouvidoria): daqui em diante na página nada é continuação.
        last = null;
        continue;
      }
      // Continuação começa na coluna da descrição; texto que começa bem à esquerda dela é rodapé/aviso.
      const startsInDescription = !last || (line.cells[0]?.x ?? 0) >= last.descX - 30;
      if (last && last.page === line.page && last.appended < 2 && !date && startsInDescription && norm.length <= 80 && last.row.description.length < 90) {
        last.row.description = `${last.row.description} ${line.text.replace(/\s{2,}/g, " ")}`.trim().slice(0, 140);
        last.appended++;
      }
      continue;
    }

    const rowDate: ISODate | null = date ? resolveDate(date) : currentDate;
    if (!rowDate) continue;
    if (date) currentDate = rowDate;

    // Valor do lançamento: pela coluna do cabeçalho; sem cabeçalho, o primeiro valor (o último costuma ser o saldo).
    let chosen: AmountHit | null = null;
    let columnSign: -1 | 0 | 1 = 0;
    if (columns) {
      for (const a of amounts) {
        const at = a.index + (line.text.slice(a.index, a.end).search(/\d/) || 0);
        const cell = line.cells.find((c) => c.start <= at && at < c.start + c.text.length) ?? null;
        const role = cell ? nearestRole((cell.x + cell.x2) / 2, columns) : null;
        if (role === "balance") continue;
        chosen = a;
        columnSign = role === "debit" ? -1 : role === "credit" ? 1 : 0;
        break;
      }
    }
    if (!chosen) chosen = kind === "CREDIT_CARD" ? amounts[amounts.length - 1]! : amounts[0]!;
    if (!chosen) continue;

    const description = cleanDescription(line.text, amounts) || "Lançamento";
    let sign: -1 | 1;
    let wasInferred = false;
    if (chosen.sign !== 0) sign = chosen.sign;
    else if (columnSign !== 0) sign = columnSign;
    else if (kind === "CREDIT_CARD") {
      // Compras positivas; pagamentos, estornos e créditos no sentido oposto.
      sign = looksLikeCardCredit(description) ? -1 : 1;
    } else if (section !== 0) {
      sign = section;
    } else if (unsignedIsCredit) {
      sign = 1;
    } else {
      sign = INCOME_WORDS.test(normalizePdfText(description)) ? 1 : -1;
      wasInferred = true;
    }
    if (wasInferred) inferred++;
    const row: PdfRow = { date: rowDate, description: description.slice(0, 140), amountCents: sign * chosen.cents, inferredSign: wasInferred, line: line.text.slice(0, 300), page: line.page };
    rows.push(row);
    const descCell = line.cells.find((c) => {
      const t = normalizePdfText(c.text);
      return /[a-z]/.test(t) && !dateAtStart(t) && !findAmounts(c.text).length;
    });
    last = { row, page: line.page, appended: 0, descX: descCell?.x ?? line.cells[0]?.x ?? 0 };
  }

  if (inferred) warnings.push(`${inferred} lançamento(s) sem sinal explícito no PDF: entrada ou saída foi deduzida pela descrição. Confira na prévia.`);
  const dates = rows.map((r) => r.date).sort();
  const period = periodFromText(fullText);
  return {
    kind,
    bank,
    bankConfident,
    rows,
    startDate: period?.start ?? dates[0] ?? null,
    endDate: period?.end ?? dates[dates.length - 1] ?? null,
    pages: opts.pages ?? Math.max(0, ...lines.map((l) => l.page)),
    textChars: fullText.replace(/\s/g, "").length,
    warnings,
  };
}

function periodFromText(norm: string): { start: ISODate; end: ISODate } | null {
  const m = /\b(?:periodo|de)\s*:?\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*(?:a|ate|-)\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(norm);
  if (!m) return null;
  const start = safeISO(Number(m[3]), Number(m[2]), Number(m[1]));
  const end = safeISO(Number(m[6]), Number(m[5]), Number(m[4]));
  return start && end && start <= end ? { start, end } : null;
}

/** Lê e interpreta o PDF (texto). */
export async function parsePdfStatement(content: Buffer, opts: { today: ISODate }): Promise<PdfStatement & { lines: PdfLine[] }> {
  const { pages, items } = await readPdfItems(content);
  const lines = buildLines(items);
  const statement = parseStatementLines(lines, { today: opts.today, pages });
  return { ...statement, lines };
}

/** PDF sem texto (digitalizado/foto): menos de 40 caracteres por página. */
export function isScanned(st: Pick<PdfStatement, "textChars" | "pages">): boolean {
  return st.pages > 0 && st.textChars / st.pages < 40;
}

/** Extrato/fatura (vários lançamentos) × comprovante único × outro documento. */
export function classifyPdf(st: Pick<PdfStatement, "kind" | "rows">, normText: string): "STATEMENT" | "RECEIPT" | "OTHER" {
  if (st.rows.length >= 3 || (st.rows.length >= 1 && st.kind !== "UNKNOWN")) return "STATEMENT";
  if (/\b(comprovante|transferencia realizada|pix enviado|pagamento realizado|pagamento efetuado|autenticacao|recibo)\b/.test(normText)) return "RECEIPT";
  return st.rows.length >= 2 ? "STATEMENT" : "OTHER";
}
