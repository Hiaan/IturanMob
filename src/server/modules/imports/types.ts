/**
 * Tipos compartilhados da importação de extratos (CSV, OFX, XLSX).
 * Valores monetários em centavos com sinal: negativo = saída, positivo = entrada.
 */

export type ImportFileFormat = "CSV" | "OFX" | "XLSX";

export type DateFormat = "auto" | "dmy" | "ymd" | "mdy";

/** Mapeamento de colunas (índices base 0 da tabela de dados). */
export interface ColumnMapping {
  date: number | null;
  description: number | null;
  /** Coluna única de valor (com sinal). Alternativa: débito/crédito. */
  amount: number | null;
  debit: number | null;
  credit: number | null;
  category: number | null;
  externalId: number | null;
  dateFormat: DateFormat;
}

/** Tabela extraída de CSV/XLSX, já com a linha de cabeçalho identificada. */
export interface ParsedTable {
  headers: string[];
  /** Linhas de dados (após o cabeçalho). */
  rows: string[][];
  /** Índice da linha de cabeçalho no arquivo original (-1 = sem cabeçalho). */
  headerRowIndex: number;
  delimiter?: string;
  sheetName?: string;
}

/** Linha normalizada, pronta para classificação. */
export interface ParsedImportRow {
  rowIndex: number;
  date: string | null;
  /** Centavos com sinal (negativo = saída). */
  amountCents: number | null;
  description: string;
  externalId: string | null;
  categoryName: string | null;
  raw: Record<string, string>;
  /** Erro de leitura (data/valor inválidos). */
  error: string | null;
  /** Linha informativa a ignorar (saldo, total). */
  skipReason: string | null;
  /** Informações adicionais (ex.: TRNTYPE e MEMO do OFX). */
  meta: { trnType?: string | null; memo?: string | null; checkNum?: string | null };
}
