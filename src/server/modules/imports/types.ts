import type { PaymentMethod } from "@prisma/client";

/**
 * Tipos compartilhados da importação de extratos (CSV, OFX, XLSX, PDF).
 * Valores monetários em centavos com sinal: negativo = saída, positivo = entrada.
 */

export type ImportFileFormat = "CSV" | "OFX" | "XLSX" | "PDF";

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
  /** Informações adicionais (ex.: TRNTYPE e MEMO do OFX; na migração de planilha, as correspondências resolvidas). */
  meta: ImportRowMeta;
}

export interface ImportRowMeta {
  trnType?: string | null;
  memo?: string | null;
  checkNum?: string | null;
  /** Migração de planilha: categoria/subcategoria escolhidas nas correspondências (valem sobre o nome). */
  categoryId?: string | null;
  subcategoryId?: string | null;
  payerMemberId?: string | null;
  /** Natureza da coluna PF/PJ (vale como escolha da pessoa, sobre as regras). */
  nature?: "PERSONAL" | "BUSINESS" | "PASSTHROUGH" | null;
  paymentMethod?: PaymentMethod | null;
  notes?: string | null;
  /** Aba e linha da planilha de origem. */
  location?: { sheet: string; row: number } | null;
  installmentInfo?: { number: number; total: number; purchaseTotal: boolean } | null;
  baseDescription?: string | null;
  /** Compra parcelada a criar no cartão: quantidade de parcelas, valor total e numeração original. */
  installmentPlan?: { count: number; amountCents: number; firstNumber: number; ofTotal: number } | null;
  /** Parcela da planilha para conferir com compras parceladas já registradas no app. */
  installmentRef?: { number: number; total: number } | null;
  /** Parcela já coberta por outra linha (a compra parcelada). */
  coveredBy?: number | null;
  /** Total mensal consolidado (matriz categorias × meses): não procura correspondência no app. */
  consolidated?: boolean;
}
