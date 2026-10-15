import Papa from "papaparse";
import { buildTable } from "./mapping";
import type { ParsedTable } from "./types";

/**
 * Leitura de CSV de bancos brasileiros: codificação UTF-8 ou Windows-1252, delimitador
 * ";" (padrão no Brasil), "," ou tabulação, linhas de identificação antes do cabeçalho.
 */

export type CsvDelimiter = ";" | "," | "\t";

const CANDIDATES: CsvDelimiter[] = [";", "\t", ","];

/** Decodifica o arquivo: UTF-8 (com ou sem BOM) ou, se inválido, Windows-1252. */
export function decodeText(input: Buffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

function countOutsideQuotes(line: string, ch: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ch && !inQuotes) count++;
  }
  return count;
}

/** Detecta o delimitador pela consistência da contagem nas primeiras linhas. */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== "")
    .slice(0, 30);
  if (!lines.length) return ";";
  let best: CsvDelimiter = ";";
  let bestScore = -1;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    if (!freq.size) continue;
    const [mode, modeFreq] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    const consistency = modeFreq / lines.length;
    const score = consistency * 100 + Math.min(mode, 20) * 0.1;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Converte o texto em linhas de células (sem interpretar cabeçalho). */
export function parseCsvRows(text: string, delimiter?: CsvDelimiter): { rows: string[][]; delimiter: CsvDelimiter } {
  const d = delimiter ?? detectDelimiter(text);
  const parsed = Papa.parse<string[]>(text, { delimiter: d, skipEmptyLines: "greedy", quoteChar: '"' });
  const rows = parsed.data.map((r) => r.map((c) => (c ?? "").toString()));
  return { rows, delimiter: d };
}

/** CSV completo → tabela com cabeçalho detectado. */
export function parseCsv(input: Buffer | Uint8Array | string, opts: { delimiter?: CsvDelimiter; headerRowIndex?: number } = {}): ParsedTable {
  const text = typeof input === "string" ? input.replace(/^﻿/, "") : decodeText(input);
  const { rows, delimiter } = parseCsvRows(text, opts.delimiter);
  const table = buildTable(rows, opts.headerRowIndex);
  return { ...table, delimiter };
}
