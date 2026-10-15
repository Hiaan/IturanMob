import { z } from "zod";
import { parseAmountToCents } from "@/lib/money";
import { isISODate, makeISO } from "@/lib/dates";
import { normalizeText } from "@/lib/utils";
import type { ColumnMapping, DateFormat, ParsedImportRow, ParsedTable } from "./types";

/**
 * Detecção automática de colunas (data, descrição, valor ou débito/crédito, categoria)
 * por nomes comuns em português e inglês, com fallback pelo conteúdo das células.
 * O usuário pode sobrescrever o mapeamento na prévia.
 */

type Field = "date" | "description" | "amount" | "debit" | "credit" | "category" | "externalId";

const SYNONYMS: Record<Field, string[]> = {
  date: [
    "data",
    "dt",
    "dia",
    "data lancamento",
    "data do lancamento",
    "data de lancamento",
    "data movimento",
    "data movimentacao",
    "data da movimentacao",
    "data mov",
    "dt lancamento",
    "data transacao",
    "data da transacao",
    "data compra",
    "data da compra",
    "data operacao",
    "date",
    "transaction date",
    "posted date",
    "posting date",
  ],
  description: [
    "descricao",
    "historico",
    "lancamento",
    "lancamentos",
    "estabelecimento",
    "detalhes",
    "detalhe",
    "memo",
    "description",
    "details",
    "title",
    "titulo",
    "name",
    "nome",
    "payee",
    "beneficiario",
    "favorecido",
    "observacao",
    "complemento",
    "transacao",
    "descricao do lancamento",
  ],
  amount: [
    "valor",
    "valor r",
    "valor rs",
    "valor em r",
    "valor brl",
    "valor em reais",
    "valor total",
    "valor lancamento",
    "valor do lancamento",
    "quantia",
    "montante",
    "amount",
    "value",
    "total",
  ],
  debit: ["debito", "debitos", "saida", "saidas", "valor debito", "debito r", "debit", "withdrawal", "withdrawals", "despesa"],
  credit: ["credito", "creditos", "entrada", "entradas", "valor credito", "credito r", "credit", "deposit", "deposits", "receita"],
  category: ["categoria", "category", "classificacao", "grupo"],
  externalId: ["identificador", "id", "fitid", "id transacao", "transaction id", "documento", "n documento", "numero documento", "nr documento", "num documento", "doc"],
};

const FIELD_ORDER: Field[] = ["date", "amount", "debit", "credit", "description", "category", "externalId"];

function headerScore(header: string, field: Field): number {
  const h = normalizeText(header);
  if (!h) return 0;
  const syns = SYNONYMS[field];
  if (syns.includes(h)) return 100;
  const words = h.split(" ");
  let best = 0;
  for (const s of syns) {
    if (s.includes(" ")) {
      if (h.startsWith(`${s} `) || h.endsWith(` ${s}`) || h.includes(` ${s} `)) best = Math.max(best, 70);
    } else if (words.includes(s)) {
      best = Math.max(best, words[0] === s ? 60 : 50);
    }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Datas e valores
// -----------------------------------------------------------------------------

/** Converte datas em dd/mm/aaaa, dd-mm-aa, dd.mm.aaaa, aaaa-mm-dd ou aaaa/mm/dd (e mm/dd/aaaa quando indicado). */
export function parseImportDate(value: string | null | undefined, format: DateFormat = "auto"): string | null {
  if (!value) return null;
  const s = value.trim();
  if (!s) return null;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (iso) {
    const out = makeISO(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return isISODate(out) ? out : null;
  }
  const br = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s].*)?$/.exec(s);
  if (br) {
    let year = Number(br[3]);
    if (year < 100) year += 2000;
    const a = Number(br[1]);
    const b = Number(br[2]);
    const [day, month] = format === "mdy" ? [b, a] : [a, b];
    const out = makeISO(year, month, day);
    return isISODate(out) ? out : null;
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) {
    const out = makeISO(Number(compact[1]), Number(compact[2]), Number(compact[3]));
    return isISODate(out) ? out : null;
  }
  return null;
}

/** Detecta se as datas estão em dia/mês ou mês/dia (padrão brasileiro: dia/mês). */
export function detectDateFormat(values: string[]): DateFormat {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    if (Number(m[2]) > 12) mdy++;
  }
  return mdy > 0 && dmy === 0 ? "mdy" : "dmy";
}

/**
 * Valores no formato brasileiro ou internacional: "1.234,56", "-45,90", "(45,90)", "R$ 10,00",
 * "45,90-", "45,90 D" (débito) e "45,90 C" (crédito). Retorna centavos com sinal ou null.
 */
export function parseImportAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  let s = String(value)
    .replace(/[−‒–—]/g, "-")
    .replace(/[  ]/g, " ")
    .trim();
  if (!s) return null;
  let forcedSign = 0;
  const dc = /^(.*?)\s*([DC])$/i.exec(s);
  if (dc && /\d/.test(dc[1] ?? "")) {
    forcedSign = dc[2]!.toUpperCase() === "D" ? -1 : 1;
    s = dc[1]!.trim();
  }
  s = s.replace(/^R\$\s*/i, "").replace(/^-\s*R\$\s*/i, "-").replace(/\s+/g, "");
  const cents = parseAmountToCents(s);
  if (cents === null) return null;
  if (forcedSign) return Math.abs(cents) * forcedSign;
  return cents;
}

// -----------------------------------------------------------------------------
// Cabeçalho e mapeamento
// -----------------------------------------------------------------------------

function rowHeaderScore(row: string[]): { matches: number; hasKey: boolean } {
  let matches = 0;
  let hasKey = false;
  for (const cell of row) {
    if (!cell || parseImportDate(cell) || parseImportAmount(cell) !== null) continue;
    let best: Field | null = null;
    let bestScore = 0;
    for (const f of FIELD_ORDER) {
      const sc = headerScore(cell, f);
      if (sc > bestScore) {
        bestScore = sc;
        best = f;
      }
    }
    if (best && bestScore >= 50) {
      matches++;
      if (best === "date" || best === "amount" || best === "debit" || best === "credit") hasKey = true;
    }
  }
  return { matches, hasKey };
}

/** Encontra a linha de cabeçalho (bancos costumam incluir linhas de identificação antes). -1 = sem cabeçalho. */
export function detectHeaderRow(rows: string[][], maxScan = 20): number {
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const { matches, hasKey } = rowHeaderScore(rows[i] ?? []);
    if (matches >= 2 && hasKey) return i;
  }
  // Sem nomes conhecidos: a primeira linha é cabeçalho se for só texto e a seguinte tiver datas.
  const first = (rows[0] ?? []).filter((c) => c.trim() !== "");
  const second = rows[1] ?? [];
  if (
    first.length >= 2 &&
    first.every((c) => !parseImportDate(c) && parseImportAmount(c) === null) &&
    second.some((c) => parseImportDate(c) !== null)
  ) {
    return 0;
  }
  return -1;
}

/** Monta a tabela (cabeçalhos + dados) a partir das linhas brutas. */
export function buildTable(rawRows: string[][], headerRowIndex?: number): ParsedTable {
  const rows = rawRows.map((r) => r.map((c) => (c ?? "").toString().trim()));
  const idx = headerRowIndex ?? detectHeaderRow(rows);
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  let headers: string[];
  let data: string[][];
  if (idx >= 0 && idx < rows.length) {
    const h = rows[idx] ?? [];
    headers = Array.from({ length: width }, (_, i) => h[i] || `Coluna ${i + 1}`);
    data = rows.slice(idx + 1);
  } else {
    headers = Array.from({ length: width }, (_, i) => `Coluna ${i + 1}`);
    data = rows;
  }
  data = data.filter((r) => r.some((c) => c !== ""));
  return { headers, rows: data, headerRowIndex: idx >= 0 ? idx : -1 };
}

function columnValues(rows: string[][], col: number, sample = 50): string[] {
  const values: string[] = [];
  for (const r of rows) {
    const v = r[col];
    if (v) values.push(v);
    if (values.length >= sample) break;
  }
  return values;
}

function ratio(values: string[], test: (v: string) => boolean): number {
  if (!values.length) return 0;
  return values.filter(test).length / values.length;
}

/** Detecta o mapeamento pelos nomes das colunas e, quando necessário, pelo conteúdo. */
export function detectMapping(headers: string[], rows: string[][] = []): ColumnMapping {
  const mapping: ColumnMapping = { date: null, description: null, amount: null, debit: null, credit: null, category: null, externalId: null, dateFormat: "auto" };
  const used = new Set<number>();
  const pairs: Array<{ field: Field; col: number; score: number }> = [];
  headers.forEach((h, col) => {
    for (const field of FIELD_ORDER) {
      const score = headerScore(h, field);
      if (score > 0) pairs.push({ field, col, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score || FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field) || a.col - b.col);
  for (const p of pairs) {
    if (used.has(p.col) || mapping[p.field] !== null) continue;
    mapping[p.field] = p.col;
    used.add(p.col);
  }

  // Valor único tem precedência; débito/crédito só valem em par (ou um deles com valor ausente).
  if (mapping.amount !== null) {
    if (mapping.debit !== null) used.delete(mapping.debit);
    if (mapping.credit !== null) used.delete(mapping.credit);
    mapping.debit = null;
    mapping.credit = null;
  }

  // Fallback pelo conteúdo.
  const width = headers.length;
  if (mapping.date === null) {
    for (let col = 0; col < width; col++) {
      if (used.has(col)) continue;
      if (ratio(columnValues(rows, col), (v) => parseImportDate(v) !== null) >= 0.8) {
        mapping.date = col;
        used.add(col);
        break;
      }
    }
  }
  if (mapping.amount === null && mapping.debit === null && mapping.credit === null) {
    for (let col = width - 1; col >= 0; col--) {
      if (used.has(col)) continue;
      const values = columnValues(rows, col);
      if (ratio(values, (v) => parseImportAmount(v) !== null && /[.,]\d{2}\b|^-?\d+$/.test(v.trim()) && !parseImportDate(v)) >= 0.8) {
        mapping.amount = col;
        used.add(col);
        break;
      }
    }
  }
  if (mapping.description === null) {
    let best = -1;
    let bestLen = 0;
    for (let col = 0; col < width; col++) {
      if (used.has(col)) continue;
      const values = columnValues(rows, col);
      const textual = values.filter((v) => parseImportAmount(v) === null && !parseImportDate(v));
      if (textual.length < values.length * 0.6) continue;
      const avg = textual.reduce((s, v) => s + v.length, 0) / Math.max(1, textual.length);
      if (avg > bestLen) {
        bestLen = avg;
        best = col;
      }
    }
    if (best >= 0) {
      mapping.description = best;
      used.add(best);
    }
  }
  if (mapping.date !== null) mapping.dateFormat = detectDateFormat(columnValues(rows, mapping.date, 200));
  return mapping;
}

/** Problemas que impedem usar o mapeamento (mensagens em português). */
export function mappingProblems(mapping: ColumnMapping, width: number): string[] {
  const problems: string[] = [];
  const check = (v: number | null, label: string) => {
    if (v !== null && (v < 0 || v >= width)) problems.push(`A coluna de ${label} não existe no arquivo.`);
  };
  check(mapping.date, "data");
  check(mapping.description, "descrição");
  check(mapping.amount, "valor");
  check(mapping.debit, "débito");
  check(mapping.credit, "crédito");
  check(mapping.category, "categoria");
  check(mapping.externalId, "identificador");
  if (mapping.date === null) problems.push("Indique a coluna de data.");
  if (mapping.amount === null && mapping.debit === null && mapping.credit === null) problems.push("Indique a coluna de valor (ou as colunas de débito e crédito).");
  return problems;
}

const BALANCE_LINE = /^(saldo\b.*|s a l d o\b.*|total( geral| da fatura| do dia| de (lancamentos|creditos|debitos|entradas|saidas))?|resumo)$/;

/** Aplica o mapeamento à tabela e produz linhas normalizadas. */
export function applyMapping(table: ParsedTable, mapping: ColumnMapping): ParsedImportRow[] {
  const fmt: DateFormat = mapping.dateFormat === "auto" && mapping.date !== null ? detectDateFormat(columnValues(table.rows, mapping.date, 200)) : mapping.dateFormat;
  const result: ParsedImportRow[] = [];
  table.rows.forEach((cells, rowIndex) => {
    const cell = (col: number | null) => (col === null ? "" : (cells[col] ?? "").trim());
    const raw: Record<string, string> = {};
    table.headers.forEach((h, i) => {
      const v = cells[i];
      if (v !== undefined && v !== "") raw[h] = v.slice(0, 500);
    });
    const description = (cell(mapping.description) || "").replace(/\s+/g, " ").slice(0, 200);
    const dateRaw = cell(mapping.date);
    const date = parseImportDate(dateRaw, fmt);

    let amountCents: number | null = null;
    let amountError: string | null = null;
    if (mapping.amount !== null) {
      const v = cell(mapping.amount);
      amountCents = v ? parseImportAmount(v) : null;
      if (v && amountCents === null) amountError = `Valor inválido: "${v.slice(0, 30)}"`;
    } else {
      const d = cell(mapping.debit);
      const c = cell(mapping.credit);
      const dv = d ? parseImportAmount(d) : null;
      const cv = c ? parseImportAmount(c) : null;
      if (d && dv === null) amountError = `Débito inválido: "${d.slice(0, 30)}"`;
      if (c && cv === null) amountError = `Crédito inválido: "${c.slice(0, 30)}"`;
      if (dv !== null || cv !== null) amountCents = Math.abs(cv ?? 0) - Math.abs(dv ?? 0);
    }

    let skipReason: string | null = null;
    const normDesc = normalizeText(description);
    if (BALANCE_LINE.test(normDesc)) skipReason = "Linha de saldo ou total do extrato (ignorada).";

    let error: string | null = null;
    if (!skipReason) {
      if (!dateRaw) error = "Data ausente.";
      else if (!date) error = `Data inválida: "${dateRaw.slice(0, 30)}"`;
      else if (amountError) error = amountError;
      else if (amountCents === null) error = "Valor ausente.";
      else if (amountCents === 0) skipReason = "Lançamento com valor zero (ignorado).";
    }

    result.push({
      rowIndex,
      date,
      amountCents,
      description: description || "Lançamento importado",
      externalId: cell(mapping.externalId).slice(0, 120) || null,
      categoryName: cell(mapping.category).slice(0, 80) || null,
      raw,
      error,
      skipReason,
      meta: {},
    });
  });
  return result;
}

// -----------------------------------------------------------------------------
// Validação (API)
// -----------------------------------------------------------------------------

const colSchema = z.number().int().min(0).max(200).nullable();

export const columnMappingSchema = z.object({
  date: colSchema,
  description: colSchema.default(null),
  amount: colSchema.default(null),
  debit: colSchema.default(null),
  credit: colSchema.default(null),
  category: colSchema.default(null),
  externalId: colSchema.default(null),
  dateFormat: z.enum(["auto", "dmy", "ymd", "mdy"]).default("auto"),
});
