import { normalizeText } from "@/lib/utils";
import { isMonthKey, monthKeyFromParts, type MonthKey } from "@/lib/dates";
import { parseImportAmount, parseImportDate } from "../imports/mapping";
import { detectColumns, emptyColumns, findHeaderRow, isTotalLabel, parseDayValue, type ColumnMap } from "./columns";
import type { RawSheet } from "./workbook";

/**
 * Tipo de cada aba:
 * - LIST: lista de lançamentos (data completa ou dia/mês);
 * - MONTH: aba de um mês com só o dia ("Janeiro", "Jan/25", "01-2025") — o nome dá o mês/ano;
 * - MATRIX: categorias × meses (orçamento ou consolidado);
 * - SUMMARY: resumo, gráfico, cálculo — ignorada;
 * - EMPTY: sem conteúdo útil.
 */

export type SheetKind = "LIST" | "MONTH" | "MATRIX" | "SUMMARY" | "EMPTY";

export interface MatrixLayout {
  headerRowIndex: number;
  labelColumn: number;
  months: Array<{ column: number; month: MonthKey }>;
}

export interface SheetAnalysis {
  kind: SheetKind;
  reason: string;
  headerRowIndex: number;
  headers: string[];
  columns: ColumnMap;
  /** Mês/ano tirado do nome da aba (abas mensais ou datas sem ano). */
  month: MonthKey | null;
  /** O ano não estava no nome: veio do arquivo ou do ano atual (confira). */
  yearGuessed: boolean;
  matrix: MatrixLayout | null;
  /** Linhas de dados (após o cabeçalho, sem linhas de total). */
  dataRows: number;
  /** Nenhum valor negativo e sem coluna de tipo/débito/crédito: o sinal vem da escolha da aba. */
  unsigned: boolean;
  /** Sugestão para valores sem sinal pelo nome da aba ("Receitas" → entradas). */
  unsignedDefault: "EXPENSE" | "INCOME" | "BY_CATEGORY";
}

// -----------------------------------------------------------------------------
// Mês no nome da aba ou do cabeçalho
// -----------------------------------------------------------------------------

const MONTH_WORDS: Record<string, number> = {
  janeiro: 1, jan: 1, january: 1,
  fevereiro: 2, fev: 2, february: 2, feb: 2,
  marco: 3, mar: 3, march: 3,
  abril: 4, abr: 4, april: 4, apr: 4,
  maio: 5, mai: 5, may: 5,
  junho: 6, jun: 6, june: 6,
  julho: 7, jul: 7, july: 7,
  agosto: 8, ago: 8, august: 8, aug: 8,
  setembro: 9, set: 9, september: 9, sep: 9, sept: 9,
  outubro: 10, out: 10, october: 10, oct: 10,
  novembro: 11, nov: 11, november: 11,
  dezembro: 12, dez: 12, december: 12, dec: 12,
};

export interface MonthName {
  month: number;
  year: number | null;
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** "Janeiro", "Jan/25", "jan-2025", "01-2025", "2025-01", "Janeiro de 2025", "Gastos Março 2024". */
export function parseMonthName(text: string): MonthName | null {
  const raw = text.trim();
  if (!raw || raw.length > 40) return null;
  const n = normalizeText(raw.replace(/([a-z])(\d)/gi, "$1 $2"));
  let m = /^(\d{4})\s+(\d{1,2})$/.exec(n);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { month: Number(m[2]), year: Number(m[1]) };
  m = /^(\d{1,2})\s+(\d{2}|\d{4})$/.exec(n);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && /[-/._ ]/.test(raw)) return { month: Number(m[1]), year: fullYear(m[2]!) };
  // Data completa no cabeçalho de matriz ("01/01/2025").
  const iso = parseImportDate(raw);
  if (iso) return { month: Number(iso.slice(5, 7)), year: Number(iso.slice(0, 4)) };
  const words = n.split(" ").filter(Boolean);
  const monthWords = words.filter((w) => MONTH_WORDS[w] !== undefined);
  if (monthWords.length !== 1) return null;
  // Palavras soltas demais ("Gastos com mar e praia") não são nome de mês.
  const others = words.filter((w) => MONTH_WORDS[w] === undefined && !/^\d+$/.test(w) && !["de", "do", "da", "mes", "gastos", "despesas", "receitas", "lancamentos", "contas", "controle", "planilha", "financas", "orcamento", "extrato", "movimento", "movimentacao", "fatura"].includes(w));
  if (others.length > 1) return null;
  const month = MONTH_WORDS[monthWords[0]!]!;
  const idx = words.indexOf(monthWords[0]!);
  const four = words.find((w) => /^\d{4}$/.test(w));
  const next = words[idx + 1];
  const y = four ? Number(four) : next && /^\d{2}$/.test(next) ? 2000 + Number(next) : null;
  return { month, year: y !== null && y >= 1990 && y <= 2100 ? y : null };
}

// -----------------------------------------------------------------------------
// Classificação
// -----------------------------------------------------------------------------

const SUMMARY_NAME = /\b(resumo|dashboard|painel|grafico|graficos|totais|consolidado|analise|indicadores|relatorio|calculo|calculos|config|configuracoes|listas|cadastro|cadastros|parametros|instrucoes|leia me|leiame|sumario)\b/;
const INCOME_NAME = /\b(receita|receitas|entrada|entradas|ganho|ganhos|renda|rendas|recebimento|recebimentos|salario|salarios)\b/;
const EXPENSE_NAME = /\b(despesa|despesas|gasto|gastos|saida|saidas|pagamento|pagamentos|contas|compras|cartao|fatura)\b/;

function nonEmpty(row: string[] | undefined): number {
  return (row ?? []).filter((c) => c.trim() !== "").length;
}

/**
 * Matriz: linha de cabeçalho com 3+ meses e rótulos de categoria à esquerda. Meses sem ano usam
 * `baseYear` (o ano do arquivo/contexto) e `guessed` avisa para conferir.
 */
function detectMatrix(rows: string[][], baseYear: number): (MatrixLayout & { guessed: boolean }) | null {
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? [];
    const months: Array<{ column: number; month: MonthName }> = [];
    row.forEach((cell, column) => {
      const mn = parseMonthName(cell);
      if (mn) months.push({ column, month: mn });
    });
    if (months.length < 3) continue;
    const distinct = new Set(months.map((m) => `${m.month.year ?? ""}-${m.month.month}`));
    if (distinct.size < 3) continue;
    const firstMonthCol = Math.min(...months.map((m) => m.column));
    // Rótulos (categorias) à esquerda dos meses: a coluna textual mais preenchida.
    let labelColumn = -1;
    let bestText = 0;
    for (let c = 0; c < firstMonthCol; c++) {
      const texts = rows.slice(i + 1).filter((r) => (r[c] ?? "").trim() && parseImportAmount(r[c]) === null).length;
      if (texts > bestText) {
        bestText = texts;
        labelColumn = c;
      }
    }
    if (labelColumn < 0 || bestText < 2) continue;
    // Os valores sob os meses precisam ser números.
    const cells = rows.slice(i + 1).flatMap((r) => months.map((m) => (r[m.column] ?? "").trim())).filter(Boolean);
    if (!cells.length || cells.filter((c) => parseImportAmount(c) !== null).length / cells.length < 0.7) continue;
    // Anos ausentes: o do primeiro mês com ano, avançando quando o mês "volta" (dez → jan).
    const known = months.find((m) => m.month.year)?.month.year ?? null;
    let year = known ?? baseYear;
    let prev = 0;
    const resolved = months
      .sort((a, b) => a.column - b.column)
      .map((m) => {
        if (m.month.year) year = m.month.year;
        else if (m.month.month < prev) year++;
        prev = m.month.month;
        return { column: m.column, month: monthKeyFromParts(m.month.year ?? year, m.month.month) };
      });
    return { headerRowIndex: i, labelColumn, months: resolved, guessed: known === null };
  }
  return null;
}

export interface ClassifyContext {
  /** Ano de referência para nomes sem ano (do nome do arquivo, de outras abas ou do ano atual). */
  year: number;
  yearFromContext: boolean;
}

/** Ano de referência: anos nos nomes das abas e do arquivo, ou datas completas nas abas. */
export function contextYear(fileName: string, sheets: RawSheet[], today: string): ClassifyContext {
  const counts = new Map<number, number>();
  const add = (y: number | null | undefined, w = 1) => {
    if (y && y >= 1990 && y <= 2100) counts.set(y, (counts.get(y) ?? 0) + w);
  };
  for (const s of sheets) add(parseMonthName(s.name)?.year, 5);
  const fileYear = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(fileName);
  if (fileYear) add(Number(fileYear[1]), 3);
  for (const s of sheets) {
    let seen = 0;
    for (const r of s.rows) {
      for (const c of r) {
        const d = parseImportDate(c);
        if (d) {
          add(Number(d.slice(0, 4)));
          if (++seen > 300) break;
        }
      }
      if (seen > 300) break;
    }
  }
  if (!counts.size) return { year: Number(today.slice(0, 4)), yearFromContext: false };
  const [year] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
  return { year, yearFromContext: true };
}

/** Valores sem sinal: "Receitas" → entradas, "Despesas"/"Gastos" → saídas; senão pelo tipo da categoria. */
export function unsignedDefaultFor(sheetName: string): "EXPENSE" | "INCOME" | "BY_CATEGORY" {
  const name = normalizeText(sheetName);
  return INCOME_NAME.test(name) ? "INCOME" : EXPENSE_NAME.test(name) ? "EXPENSE" : "BY_CATEGORY";
}

export { detectMatrix };

export function classifySheet(sheet: RawSheet, ctx: ClassifyContext, monthOverride?: MonthKey | null): SheetAnalysis {
  const base: SheetAnalysis = {
    kind: "EMPTY",
    reason: "",
    headerRowIndex: -1,
    headers: [],
    columns: emptyColumns(),
    month: null,
    yearGuessed: false,
    matrix: null,
    dataRows: 0,
    unsigned: false,
    unsignedDefault: "BY_CATEGORY",
  };
  const name = normalizeText(sheet.name);
  base.unsignedDefault = unsignedDefaultFor(sheet.name);
  const useful = sheet.rows.filter((r) => nonEmpty(r) >= 2);
  if (useful.length < 2) return { ...base, kind: "EMPTY", reason: "Aba vazia ou com uma linha só." };

  const nameMonth = parseMonthName(sheet.name);
  if (monthOverride && isMonthKey(monthOverride)) {
    base.month = monthOverride;
  } else if (nameMonth) {
    base.month = monthKeyFromParts(nameMonth.year ?? ctx.year, nameMonth.month);
    base.yearGuessed = !nameMonth.year;
  }

  // 1) Lista de lançamentos (com cabeçalho reconhecido).
  const headerRowIndex = findHeaderRow(sheet.rows);
  if (headerRowIndex >= 0) {
    const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
    const h = sheet.rows[headerRowIndex] ?? [];
    const headers = Array.from({ length: width }, (_, i) => (h[i] ?? "").trim() || `Coluna ${i + 1}`);
    const data = sheet.rows.slice(headerRowIndex + 1);
    const columns = detectColumns(headers, data);
    const amountCols = [columns.amount, columns.debit, columns.credit].filter((c): c is number => c !== null);
    const hasDate = columns.date !== null || columns.day !== null;
    if (hasDate && amountCols.length) {
      const dataRows = data.filter((r) => nonEmpty(r) >= 2 && !isTotalLabel(r[columns.description ?? -1]) && !isTotalLabel(r[columns.date ?? columns.day ?? -1])).length;
      const negatives = columns.amount !== null && data.some((r) => (parseImportAmount(r[columns.amount!]) ?? 0) < 0);
      const unsigned = columns.amount !== null && !negatives && columns.type === null;
      const analysis = { ...base, headerRowIndex, headers, columns, dataRows, unsigned };
      if (SUMMARY_NAME.test(name) && dataRows < 5) return { ...analysis, kind: "SUMMARY", reason: "Aba de resumo (poucas linhas): ignorada." };
      if (columns.date === null) {
        if (!base.month) {
          return { ...analysis, kind: "SUMMARY", reason: "A aba tem só o dia, mas o nome não indica o mês (ex.: \"Janeiro\" ou \"01-2025\"). Informe o mês para usá-la." };
        }
        return { ...analysis, kind: "MONTH", reason: `Aba do mês: o dia vem da coluna "${headers[columns.day!]}" e o mês/ano do nome da aba.` };
      }
      // Datas sem ano ("15/03"): o ano vem do nome da aba ou do arquivo.
      const dates = data.map((r) => (r[columns.date!] ?? "").trim()).filter(Boolean);
      const withoutYear = dates.filter((d) => /^\d{1,2}[-/.]\d{1,2}$/.test(d)).length;
      if (withoutYear > dates.length / 2 && !base.month) base.yearGuessed = !ctx.yearFromContext;
      return { ...analysis, yearGuessed: base.yearGuessed || (withoutYear > dates.length / 2 && !nameMonth?.year && !ctx.yearFromContext), kind: "LIST", reason: "Lista de lançamentos." };
    }
  }

  // 2) Matriz categorias × meses.
  // Meses sem ano: o ano do nome da aba ("Gastos 2025") ou o do arquivo — e a tela pede para conferir.
  const nameYear = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(sheet.name)?.[1];
  const detected = detectMatrix(sheet.rows, nameYear ? Number(nameYear) : ctx.year);
  if (detected) {
    const { guessed, ...matrix } = detected;
    const rows = sheet.rows.slice(matrix.headerRowIndex + 1).filter((r) => (r[matrix.labelColumn] ?? "").trim() && !isTotalLabel(r[matrix.labelColumn]));
    return {
      ...base,
      kind: "MATRIX",
      reason: `Categorias × meses (${matrix.months.length} meses). Use como lançamentos consolidados por mês ou como orçamento.`,
      headerRowIndex: matrix.headerRowIndex,
      headers: (sheet.rows[matrix.headerRowIndex] ?? []).map((c, i) => c.trim() || `Coluna ${i + 1}`),
      matrix,
      yearGuessed: guessed && !nameYear,
      dataRows: rows.length,
    };
  }

  // 3) Aba do mês sem cabeçalho reconhecido: dia + descrição + valor pelo conteúdo.
  if (base.month) {
    const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
    const dayCol = Array.from({ length: width }, (_, c) => c).find((c) => {
      const vs = sheet.rows.map((r) => (r[c] ?? "").trim()).filter(Boolean);
      return vs.length >= 3 && vs.filter((v) => parseDayValue(v) !== null).length / vs.length >= 0.7;
    });
    if (dayCol !== undefined) {
      const headers = Array.from({ length: width }, (_, i) => `Coluna ${i + 1}`);
      const columns = detectColumns(headers, sheet.rows);
      columns.day = dayCol;
      if (columns.date === dayCol) columns.date = null;
      if (columns.amount !== null || columns.debit !== null || columns.credit !== null) {
        const negatives = columns.amount !== null && sheet.rows.some((r) => (parseImportAmount(r[columns.amount!]) ?? 0) < 0);
        return {
          ...base,
          kind: "MONTH",
          reason: "Aba do mês sem cabeçalho: colunas identificadas pelo conteúdo (confira).",
          headerRowIndex: -1,
          headers,
          columns,
          dataRows: sheet.rows.filter((r) => parseDayValue(r[dayCol] ?? "") !== null).length,
          unsigned: columns.amount !== null && !negatives && columns.type === null,
        };
      }
    }
  }

  if (SUMMARY_NAME.test(name)) return { ...base, kind: "SUMMARY", reason: "Aba de resumo, gráfico ou cálculo: ignorada." };
  return { ...base, kind: "SUMMARY", reason: "Não encontrei colunas de data e valor: parece resumo, gráfico ou cálculo (ignorada). Se for uma lista, indique as colunas." };
}
