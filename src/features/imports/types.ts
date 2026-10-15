/** Tipos do cliente para importação e conciliação (espelham as respostas de /api/v1/imports). */

export type ImportRowStatus = "NEW" | "DUPLICATE" | "MATCHED" | "DIVERGENT" | "SKIPPED" | "IMPORTED" | "ERROR";
export type ImportBatchStatus = "PREVIEW" | "IMPORTED" | "UNDONE" | "FAILED";
export type ImportFormat = "CSV" | "OFX" | "XLSX";
export type DateFormat = "auto" | "dmy" | "ymd" | "mdy";

export interface ColumnMapping {
  date: number | null;
  description: number | null;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  category: number | null;
  externalId: number | null;
  dateFormat: DateFormat;
}

export interface ImportBatchDTO {
  id: string;
  format: ImportFormat;
  fileName: string;
  status: ImportBatchStatus;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string } | null;
  totalRows: number;
  newRows: number;
  duplicateRows: number;
  matchedRows: number;
  importedRows: number;
  createdAt: string;
  importedAt: string | null;
  undoneAt: string | null;
  warnings: string[];
  statement: { kind: "BANK" | "CREDIT_CARD"; bankId: string | null; accountIdMasked: string | null; startDate: string | null; endDate: string | null; ledgerBalanceCents: number | null } | null;
}

export interface ImportRowDTO {
  id: string;
  rowIndex: number;
  date: string | null;
  amountCents: number | null;
  description: string | null;
  externalId: string | null;
  status: ImportRowStatus;
  message: string | null;
  selected: boolean;
  categoryId: string | null;
  kind: "EXPENSE" | "INCOME" | "CARD_PAYMENT";
  categoryName: string | null;
  installment: { number: number; total: number } | null;
  cells: Record<string, string>;
  matchedTransaction: { id: string; description: string; amountCents: number; date: string; type: string; status: string; source: string; deleted: boolean } | null;
  createdTransactionId: string | null;
}

export interface ImportPreview {
  batch: ImportBatchDTO;
  counts: Record<ImportRowStatus, number> & { total: number; selectedNew: number; selectedNewNetCents: number };
  mapping: ColumnMapping | null;
  headers: string[];
  headerRowIndex: number | null;
  invertSigns: boolean;
  cardPurchasesPositive: boolean | null;
  rows: ImportRowDTO[];
  result?: { alreadyImported?: boolean; alreadyUndone?: boolean; created?: number; matched?: number; divergent?: number; errors?: number; removed?: number };
}

export interface Reconciliation {
  batch: ImportBatchDTO;
  period: { start: string; end: string } | null;
  totals: { statementInflowCents: number; statementOutflowCents: number; statementLedgerBalanceCents: number | null };
  counts: ImportPreview["counts"];
  matched: ImportRowDTO[];
  notInApp: ImportRowDTO[];
  divergent: Array<ImportRowDTO & { differenceCents: number | null }>;
  duplicates: ImportRowDTO[];
  ignored: ImportRowDTO[];
  missingInStatement: Array<{ id: string; description: string; amountCents: number; date: string; type: string; source: string }>;
  notes: string[];
}

export interface RowUpdate {
  rowId: string;
  selected?: boolean;
  categoryId?: string | null;
  forceNew?: boolean;
}
