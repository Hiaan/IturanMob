/** Tipos do cliente para importação e conciliação (espelham as respostas de /api/v1/imports). */

export type ImportRowStatus = "NEW" | "DUPLICATE" | "MATCHED" | "DIVERGENT" | "SKIPPED" | "IMPORTED" | "ERROR";
export type ImportBatchStatus = "PREVIEW" | "IMPORTED" | "UNDONE" | "FAILED";
export type ImportFormat = "CSV" | "OFX" | "XLSX" | "PDF";
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
  statement: StatementInfoDTO | null;
  /** PDF cujo tipo (extrato/fatura) não bate com o destino escolhido: nenhuma linha vem selecionada; warnings[0] explica. */
  scopeMismatch?: boolean;
  /** Linhas que a confirmação marcou como duplicadas (já criadas por outro arquivo ou registradas depois da prévia). */
  duplicatesAtCommit?: number;
  origin?: "WHATSAPP" | null;
}

/** Dados do extrato (OFX e PDF). Em PDFs, `bank` traz o banco identificado e alguns campos podem faltar. */
export interface StatementInfoDTO {
  kind: "BANK" | "CREDIT_CARD" | (string & {});
  bank?: string | null;
  /** PDF: lido do texto do arquivo ou pela IA (PDF digitalizado). */
  source?: "TEXT" | "AI" | null;
  bankId?: string | null;
  accountIdMasked?: string | null;
  startDate: string | null;
  endDate: string | null;
  ledgerBalanceCents?: number | null;
}

/** Transferência entre contas próprias (aplicação/resgate, mesma titularidade). OUT: sai da conta do extrato; IN: volta para ela. */
export interface ImportRowTransfer {
  accountId: string | null;
  accountName: string | null;
  direction: "OUT" | "IN";
  reason: "INVESTMENT" | "OWN_ACCOUNTS" | "RULE" | "MANUAL" | null;
}

export interface ImportRowDTO {
  id: string;
  /** Só em linhas TRANSFER; accountId null = falta escolher a conta do outro lado (a linha vem desmarcada). */
  transfer: ImportRowTransfer | null;
  rowIndex: number;
  date: string | null;
  amountCents: number | null;
  description: string | null;
  externalId: string | null;
  status: ImportRowStatus;
  message: string | null;
  selected: boolean;
  categoryId: string | null;
  kind: "EXPENSE" | "INCOME" | "CARD_PAYMENT" | "TRANSFER";
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

/** Corpo de POST /api/v1/imports/:id/transfer (transferAccountId null volta a linha para receita/despesa). */
export interface RowsTransferInput {
  rowIds: string[];
  transferAccountId: string | null;
  applyToSimilar?: boolean;
  remember?: boolean;
}

export type RowsTransferResult = ImportPreview & { updatedRows: number; ruleCreated: boolean };

export interface RowUpdate {
  rowId: string;
  selected?: boolean;
  categoryId?: string | null;
  forceNew?: boolean;
}

/** Resultado de POST /api/v1/imports/bulk-commit. */
export interface BulkCommitFileResult {
  batchId: string;
  fileName: string;
  ok: boolean;
  created: number;
  matched: number;
  divergent: number;
  duplicatesAtCommit: number;
  errors: number;
  /** O lote já tinha sido confirmado antes (por exemplo, na revisão individual): nada novo foi gravado. */
  alreadyImported?: boolean;
  error?: string;
}

export interface BulkCommitResponse {
  results: BulkCommitFileResult[];
  totals: { created: number; matched: number; divergent: number; duplicatesAtCommit: number; errors: number; files?: number; ok?: number };
}
