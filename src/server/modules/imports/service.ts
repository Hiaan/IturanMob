import { z } from "zod";
import type { ImportRowStatus, PaymentMethod, Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { errorInfo, logger } from "../../logger";
import { sha256Hex } from "../../crypto";
import { readStoredFile, storeFile, storedFileExists } from "../../storage";
import { addDays, dateToISO, formatDateBR, instantToISO, isoToDate } from "@/lib/dates";
import { formatBRL, MAX_AMOUNT_CENTS } from "@/lib/money";
import { normalizeText } from "@/lib/utils";
import { audit } from "../audit/service";
import { createPendingItem, resolvePendingWhere } from "../pending/service";
import { createTransaction, deleteTransaction, updateTransaction } from "../transactions/service";
import { getVisibilityScope, visibleAccountWhere, visibleCardWhere, visibleTransactionWhere } from "../visibility/scope";
import { parseCsv } from "./csv";
import { isOfx, ofxDescription, parseOfx, type OfxStatement } from "./ofx";
import { parseXlsx } from "./xlsx";
import { applyMapping, columnMappingSchema, detectMapping, mappingProblems } from "./mapping";
import { descriptionSimilarity, detectInstallment, importRowFingerprint, looksLikeCardBillPayment, looksLikeCardCredit } from "./matching";
import type { ColumnMapping, ImportFileFormat, ParsedImportRow, ParsedTable } from "./types";

// -----------------------------------------------------------------------------
// Limites e schemas
// -----------------------------------------------------------------------------

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5_000;
/** Janela (dias) para considerar uma transação existente como correspondente. */
export const MATCH_WINDOW_DAYS = 3;
/** Diferença relativa máxima de valor para apontar divergência. */
export const DIVERGENCE_MAX_RATIO = 0.3;
const COMMIT_STALE_MS = 10 * 60_000;

const idSchema = z.string().min(1).max(64);

const previewOptionsSchema = z.object({
  format: z.enum(["CSV", "OFX", "XLSX"]).optional(),
  accountId: idSchema.nullish(),
  creditCardId: idSchema.nullish(),
  mapping: columnMappingSchema.nullish(),
  headerRowIndex: z.number().int().min(-1).max(200).nullish(),
  invertSigns: z.boolean().default(false),
});

export const importPreviewSchema = previewOptionsSchema
  .extend({
    fileName: z.string().trim().min(1).max(200),
    /** Conteúdo do arquivo em base64 (até 5 MB). */
    contentBase64: z.string().min(1).max(Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 16),
  })
  .refine((d) => !(d.accountId && d.creditCardId), { message: "Escolha uma conta OU um cartão, não ambos.", path: ["creditCardId"] });
export type ImportPreviewInput = z.input<typeof importPreviewSchema>;

export const importPreviewFileSchema = previewOptionsSchema.refine((d) => !(d.accountId && d.creditCardId), {
  message: "Escolha uma conta OU um cartão, não ambos.",
  path: ["creditCardId"],
});
export type ImportPreviewFileOptions = z.input<typeof importPreviewFileSchema>;

export const importRowsUpdateSchema = z.object({
  rows: z
    .array(
      z.object({
        rowId: idSchema,
        selected: z.boolean().optional(),
        categoryId: idSchema.nullable().optional(),
        /** Importa como novo lançamento mesmo marcado como duplicado/correspondente/divergente. */
        forceNew: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(IMPORT_MAX_ROWS),
});
export type ImportRowsUpdate = z.input<typeof importRowsUpdateSchema>["rows"];

export const importMappingUpdateSchema = z.object({
  mapping: columnMappingSchema.nullish(),
  headerRowIndex: z.number().int().min(-1).max(200).nullish(),
  invertSigns: z.boolean().optional(),
});
export type ImportMappingUpdate = z.input<typeof importMappingUpdateSchema>;

// -----------------------------------------------------------------------------
// Tipos internos
// -----------------------------------------------------------------------------

type RowKind = "EXPENSE" | "INCOME" | "CARD_PAYMENT";

interface ImportScope {
  accountId: string | null;
  creditCardId: string | null;
  accountOwnerId: string | null;
  cardHolderId: string | null;
  label: string | null;
}

interface StatementInfo {
  kind: "BANK" | "CREDIT_CARD";
  bankId: string | null;
  accountIdMasked: string | null;
  startDate: string | null;
  endDate: string | null;
  ledgerBalanceCents: number | null;
}

interface ReconciledFill {
  rowId: string;
  transactionId: string;
  field: "accountId" | "creditCardId";
  value: string;
  previousPaymentMethod: PaymentMethod | null;
}

/** Metadados do lote (armazenados em ImportBatch.mapping). */
export interface ImportBatchMeta {
  version: 1;
  mapping: ColumnMapping | null;
  headers: string[];
  headerRowIndex: number | null;
  delimiter: string | null;
  sheetName: string | null;
  invertSigns: boolean;
  cardPurchasesPositive: boolean | null;
  statement: StatementInfo | null;
  warnings: string[];
  storageKey: string | null;
  commit?: {
    created: number;
    matched: number;
    divergent: number;
    errors: number;
    reconciledFills: ReconciledFill[];
  };
}

interface RowRawData {
  cells: Record<string, string>;
  kind: RowKind;
  cardPaymentCardId?: string | null;
  categoryName?: string | null;
  trnType?: string | null;
  memo?: string | null;
  installment?: { number: number; total: number } | null;
  suggestedPaymentMethod?: PaymentMethod | null;
}

interface PreparedRow {
  rowIndex: number;
  date: string | null;
  amountCents: number | null;
  description: string;
  externalId: string | null;
  fingerprint: string | null;
  categoryId: string | null;
  status: ImportRowStatus | null;
  message: string | null;
  selected: boolean;
  matchedTransactionId: string | null;
  raw: RowRawData;
}

interface Candidate {
  id: string;
  type: string;
  amountCents: number;
  date: string;
  description: string;
  merchantName: string | null;
  accountId: string | null;
  destinationAccountId: string | null;
  creditCardId: string | null;
  paymentMethod: string | null;
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

const MIME: Record<ImportFileFormat, string> = {
  CSV: "text/csv",
  OFX: "application/x-ofx",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function detectImportFormat(fileName: string, content: Buffer): ImportFileFormat {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (content.length >= 2 && content[0] === 0x50 && content[1] === 0x4b) return "XLSX";
  if (ext === "xls") throw new ValidationError("Planilhas .xls (Excel 97-2003) não são suportadas. Salve o arquivo como .xlsx ou CSV.");
  if (ext === "ofx" || ext === "qfx") return "OFX";
  if (isOfx(content.subarray(0, 4000).toString("latin1"))) return "OFX";
  return "CSV";
}

function maskAccount(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\s/g, "");
  return digits.length <= 4 ? digits : `•••${digits.slice(-4)}`;
}

function suggestPaymentMethod(description: string, trnType: string | null | undefined, outflow: boolean): PaymentMethod {
  const n = normalizeText(description);
  const t = (trnType ?? "").toUpperCase();
  if (/\bpix\b/.test(n)) return "PIX";
  if (/\b(boleto|titulo|cobranca)\b/.test(n) || /\bpag(to)? tit\b/.test(n)) return "BANK_SLIP";
  if (/\bdeb(ito)? aut(omatico)?\b/.test(n)) return "AUTO_DEBIT";
  if (/\b(saque|atm)\b/.test(n) || t === "ATM" || t === "CASH") return "CASH";
  if (/\b(ted|doc|tef|transf|transferencia)\b/.test(n) || t === "XFER") return "BANK_TRANSFER";
  if (outflow && (/\b(compra|cartao|elo|visa|maestro|master)\b/.test(n) || t === "POS")) return "DEBIT_CARD";
  return "OTHER";
}

function emptyMeta(): ImportBatchMeta {
  return {
    version: 1,
    mapping: null,
    headers: [],
    headerRowIndex: null,
    delimiter: null,
    sheetName: null,
    invertSigns: false,
    cardPurchasesPositive: null,
    statement: null,
    warnings: [],
    storageKey: null,
  };
}

function readMeta(value: Prisma.JsonValue | null): ImportBatchMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyMeta();
  return { ...emptyMeta(), ...(value as unknown as Partial<ImportBatchMeta>) };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function readRaw(value: Prisma.JsonValue): RowRawData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { cells: {}, kind: "EXPENSE" };
  return value as unknown as RowRawData;
}

function errorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? "Dados inválidos.";
  return "Não foi possível registrar esta linha.";
}

async function resolveScope(ctx: ServiceContext, accountId?: string | null, creditCardId?: string | null): Promise<ImportScope> {
  if (accountId && creditCardId) throw new ValidationError("Escolha uma conta OU um cartão, não ambos.");
  if (accountId) {
    const acc = await prisma.account.findFirst({ where: { id: accountId, ...visibleAccountWhere(ctx) }, select: { id: true, name: true, ownerMemberId: true } });
    if (!acc) throw new ValidationError("Conta inválida.", { field: "accountId" });
    return { accountId: acc.id, creditCardId: null, accountOwnerId: acc.ownerMemberId, cardHolderId: null, label: acc.name };
  }
  if (creditCardId) {
    const card = await prisma.creditCard.findFirst({ where: { id: creditCardId, ...visibleCardWhere(ctx) }, select: { id: true, name: true, holderMemberId: true } });
    if (!card) throw new ValidationError("Cartão inválido.", { field: "creditCardId" });
    return { accountId: null, creditCardId: card.id, accountOwnerId: null, cardHolderId: card.holderMemberId, label: card.name };
  }
  return { accountId: null, creditCardId: null, accountOwnerId: null, cardHolderId: null, label: null };
}

function batchVisibilityWhere(ctx: ServiceContext): Prisma.ImportBatchWhereInput {
  return {
    householdId: ctx.householdId,
    OR: [
      { accountId: null, creditCardId: null },
      { account: { is: visibleAccountWhere(ctx) } },
      { creditCard: { is: visibleCardWhere(ctx) } },
    ],
  };
}

async function loadBatch(ctx: ServiceContext, batchId: string) {
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, ...batchVisibilityWhere(ctx) } });
  if (!batch) throw new NotFoundError("Importação");
  return batch;
}

// -----------------------------------------------------------------------------
// Leitura do arquivo
// -----------------------------------------------------------------------------

interface ParseOptions {
  mapping?: ColumnMapping | null;
  headerRowIndex?: number | null;
}

interface ParseResult {
  rows: ParsedImportRow[];
  meta: Pick<ImportBatchMeta, "mapping" | "headers" | "headerRowIndex" | "delimiter" | "sheetName" | "statement" | "warnings">;
  ofxKind: "BANK" | "CREDIT_CARD" | null;
}

function tableRowsLimit(table: ParsedTable) {
  if (table.rows.length > IMPORT_MAX_ROWS) {
    throw new ValidationError(`O arquivo tem ${table.rows.length.toLocaleString("pt-BR")} linhas. O limite é de 5.000 linhas por importação — divida o arquivo em partes.`);
  }
}

function parseTableRows(table: ParsedTable, opts: ParseOptions, warnings: string[]): { rows: ParsedImportRow[]; mapping: ColumnMapping } {
  tableRowsLimit(table);
  const mapping = opts.mapping ? { ...opts.mapping } : detectMapping(table.headers, table.rows);
  const problems = mappingProblems(mapping, table.headers.length);
  if (problems.length && opts.mapping) throw new ValidationError(problems[0]!, { problems });
  if (problems.length) {
    warnings.push(`Não foi possível identificar todas as colunas automaticamente: ${problems.join(" ")} Ajuste o mapeamento.`);
    const rows = table.rows.map<ParsedImportRow>((cells, rowIndex) => ({
      rowIndex,
      date: null,
      amountCents: null,
      description: cells.join(" ").slice(0, 200) || "Linha",
      externalId: null,
      categoryName: null,
      raw: Object.fromEntries(table.headers.map((h, i) => [h, (cells[i] ?? "").slice(0, 500)]).filter(([, v]) => v !== "")),
      error: "Mapeamento de colunas incompleto.",
      skipReason: null,
      meta: {},
    }));
    return { rows, mapping };
  }
  return { rows: applyMapping(table, mapping), mapping };
}

async function parseImportFile(format: ImportFileFormat, content: Buffer, opts: ParseOptions): Promise<ParseResult> {
  const warnings: string[] = [];
  if (format === "OFX") {
    let st: OfxStatement;
    try {
      st = parseOfx(content);
    } catch (err) {
      throw new ValidationError((err as Error).message || "Arquivo OFX inválido.");
    }
    if (st.transactions.length > IMPORT_MAX_ROWS) throw new ValidationError("O arquivo tem mais de 5.000 lançamentos. Divida o período em partes.");
    if (st.currency && st.currency.toUpperCase() !== "BRL") warnings.push(`O extrato está em ${st.currency}; os valores serão importados como reais (BRL).`);
    const rows = st.transactions.map<ParsedImportRow>((t, rowIndex) => {
      const raw: Record<string, string> = {};
      if (t.trnType) raw.TRNTYPE = t.trnType;
      if (t.datePosted) raw.DTPOSTED = t.datePosted;
      if (t.amountCents !== null) raw.TRNAMT = String(t.amountCents / 100);
      if (t.fitId) raw.FITID = t.fitId;
      if (t.name) raw.NAME = t.name.slice(0, 300);
      if (t.memo) raw.MEMO = t.memo.slice(0, 300);
      let error: string | null = null;
      let skipReason: string | null = null;
      if (!t.datePosted) error = "Data (DTPOSTED) ausente ou inválida.";
      else if (t.amountCents === null) error = "Valor (TRNAMT) ausente ou inválido.";
      else if (t.amountCents === 0) skipReason = "Lançamento com valor zero (ignorado).";
      return {
        rowIndex,
        date: t.datePosted,
        amountCents: t.amountCents,
        description: ofxDescription(t),
        externalId: t.fitId?.slice(0, 120) ?? null,
        categoryName: null,
        raw,
        error,
        skipReason,
        meta: { trnType: t.trnType, memo: t.memo, checkNum: t.checkNum },
      };
    });
    return {
      rows,
      ofxKind: st.kind,
      meta: {
        mapping: null,
        headers: [],
        headerRowIndex: null,
        delimiter: null,
        sheetName: null,
        statement: {
          kind: st.kind,
          bankId: st.bankId,
          accountIdMasked: maskAccount(st.accountId),
          startDate: st.startDate,
          endDate: st.endDate,
          ledgerBalanceCents: st.ledgerBalanceCents,
        },
        warnings,
      },
    };
  }

  let table: ParsedTable;
  if (format === "XLSX") {
    try {
      table = await parseXlsx(content, { headerRowIndex: opts.headerRowIndex ?? undefined, maxRows: IMPORT_MAX_ROWS + 50 });
    } catch (err) {
      throw new ValidationError((err as Error).message || "Planilha inválida.");
    }
  } else {
    table = parseCsv(content, { headerRowIndex: opts.headerRowIndex ?? undefined });
  }
  const { rows, mapping } = parseTableRows(table, opts, warnings);
  return {
    rows,
    ofxKind: null,
    meta: {
      mapping,
      headers: table.headers,
      headerRowIndex: table.headerRowIndex,
      delimiter: table.delimiter ?? null,
      sheetName: table.sheetName ?? null,
      statement: null,
      warnings,
    },
  };
}

// -----------------------------------------------------------------------------
// Preparação (sinais, tipos, categorias) e classificação
// -----------------------------------------------------------------------------

async function prepareRows(
  ctx: ServiceContext,
  scope: ImportScope,
  parsed: ParsedImportRow[],
  opts: { invertSigns: boolean; warnings: string[] },
): Promise<{ rows: PreparedRow[]; cardPurchasesPositive: boolean | null }> {
  const isCard = Boolean(scope.creditCardId);
  const valid = parsed.filter((r) => !r.error && !r.skipReason && r.amountCents);

  // Cartão: compras são a maioria das linhas. Detecta o sinal usado pelo banco.
  let cardPurchasesPositive: boolean | null = null;
  if (isCard) {
    const purchases = valid.filter((r) => !looksLikeCardCredit(r.description));
    const positives = purchases.filter((r) => (r.amountCents ?? 0) > 0).length;
    const negatives = purchases.length - positives;
    cardPurchasesPositive = positives > negatives;
  }
  const signFactor = (isCard && cardPurchasesPositive ? -1 : 1) * (opts.invertSigns ? -1 : 1);

  const [categories, subcategories, cards] = await Promise.all([
    prisma.category.findMany({ where: { householdId: ctx.householdId, archivedAt: null }, select: { id: true, name: true, kind: true } }),
    prisma.subcategory.findMany({ where: { householdId: ctx.householdId, archivedAt: null }, select: { name: true, categoryId: true, category: { select: { kind: true } } } }),
    scope.accountId
      ? prisma.creditCard.findMany({ where: { ...visibleCardWhere(ctx), archivedAt: null }, select: { id: true, name: true, issuer: true, last4: true } })
      : Promise.resolve([] as Array<{ id: string; name: string; issuer: string | null; last4: string | null }>),
  ]);
  const catByName = new Map<string, string>();
  for (const c of categories) catByName.set(`${c.kind}|${normalizeText(c.name)}`, c.id);
  for (const s of subcategories) {
    const key = `${s.category.kind}|${normalizeText(s.name)}`;
    if (!catByName.has(key)) catByName.set(key, s.categoryId);
  }
  const resolveCard = (description: string): string | null => {
    const n = normalizeText(description);
    const hits = cards.filter(
      (c) =>
        (normalizeText(c.name) && n.includes(normalizeText(c.name))) ||
        (c.issuer && normalizeText(c.issuer) && n.includes(normalizeText(c.issuer))) ||
        (c.last4 && n.includes(c.last4)),
    );
    if (hits.length === 1) return hits[0]!.id;
    if (!hits.length && cards.length === 1) return cards[0]!.id;
    return null;
  };

  const scopeKey = scope.accountId ?? scope.creditCardId ?? `household:${ctx.householdId}`;
  const occurrences = new Map<string, number>();
  const seenExternal = new Map<string, number>();
  let cardPaymentSkipped = 0;

  const rows = parsed.map<PreparedRow>((r) => {
    const amount = r.amountCents === null ? null : r.amountCents * signFactor;
    const outflow = (amount ?? 0) < 0;
    const raw: RowRawData = {
      cells: r.raw,
      kind: outflow ? "EXPENSE" : "INCOME",
      categoryName: r.categoryName,
      trnType: r.meta.trnType ?? null,
      memo: r.meta.memo ?? null,
    };
    const row: PreparedRow = {
      rowIndex: r.rowIndex,
      date: r.date,
      amountCents: amount,
      description: r.description.slice(0, 200),
      externalId: r.externalId,
      fingerprint: null,
      categoryId: null,
      status: null,
      message: null,
      selected: true,
      matchedTransactionId: null,
      raw,
    };

    if (r.error) return { ...row, status: "ERROR", message: r.error, selected: false };
    if (r.skipReason) return { ...row, status: "SKIPPED", message: r.skipReason, selected: false };
    if (amount === null) return { ...row, status: "ERROR", message: "Valor ausente.", selected: false };
    if (Math.abs(amount) > MAX_AMOUNT_CENTS) return { ...row, status: "ERROR", message: "Valor acima do limite permitido.", selected: false };

    const dupKey = `${r.date}|${amount}|${normalizeText(r.description)}`;
    const occurrence = (occurrences.get(dupKey) ?? 0) + 1;
    occurrences.set(dupKey, occurrence);
    row.fingerprint = importRowFingerprint(scopeKey, r.date!, amount, r.description, occurrence);

    if (r.externalId) {
      const seen = (seenExternal.get(r.externalId) ?? 0) + 1;
      seenExternal.set(r.externalId, seen);
      if (seen > 1) {
        return { ...row, externalId: `${r.externalId}~${seen}`.slice(0, 120), status: "DUPLICATE", message: "Identificador repetido no próprio arquivo.", selected: false };
      }
    }

    if (isCard) {
      if (amount > 0 || /\b(pagamento|pagto|pgto)\b.*\b(recebido|efetuado|fatura)\b/.test(normalizeText(r.description))) {
        cardPaymentSkipped++;
        return {
          ...row,
          status: "SKIPPED",
          message: "Pagamento ou crédito na fatura (ignorado). O pagamento da fatura é registrado na conta pagadora; estornos podem ser lançados manualmente.",
          selected: false,
        };
      }
      raw.installment = detectInstallment(r.description);
    } else if (scope.accountId && outflow && looksLikeCardBillPayment(r.description)) {
      const cardId = resolveCard(r.description);
      if (!cardId) {
        return {
          ...row,
          status: "SKIPPED",
          message: "Pagamento de fatura de cartão: não foi possível identificar o cartão. Registre o pagamento pela tela do cartão (não é despesa — evita dupla contagem).",
          selected: false,
        };
      }
      raw.kind = "CARD_PAYMENT";
      raw.cardPaymentCardId = cardId;
    }

    if (raw.kind !== "CARD_PAYMENT") {
      raw.suggestedPaymentMethod = scope.accountId ? suggestPaymentMethod(r.description, r.meta.trnType, outflow) : null;
      if (r.categoryName) {
        row.categoryId = catByName.get(`${outflow ? "EXPENSE" : "INCOME"}|${normalizeText(r.categoryName)}`) ?? null;
      }
    }
    return row;
  });

  if (cardPaymentSkipped) opts.warnings.push(`${cardPaymentSkipped} linha(s) de pagamento/crédito da fatura foram ignoradas (não são compras).`);
  return { rows, cardPurchasesPositive };
}

function compatible(row: PreparedRow, tx: Candidate, scope: ImportScope): boolean {
  const outflow = (row.amountCents ?? 0) < 0;
  if (scope.creditCardId) {
    if (tx.type !== "EXPENSE") return false;
    if (tx.creditCardId) return tx.creditCardId === scope.creditCardId;
    return !tx.accountId && (tx.paymentMethod === null || tx.paymentMethod === "CREDIT_CARD");
  }
  if (scope.accountId) {
    const a = scope.accountId;
    if (row.raw.kind === "CARD_PAYMENT") return tx.type === "CARD_PAYMENT" && tx.accountId === a;
    if (outflow) {
      if (tx.type === "EXPENSE") return tx.accountId === a || (!tx.accountId && !tx.creditCardId && tx.paymentMethod !== "CREDIT_CARD");
      if (tx.type === "CARD_PAYMENT" || tx.type === "TRANSFER" || tx.type === "ADJUSTMENT") return tx.accountId === a;
      return false;
    }
    if (tx.type === "INCOME") return tx.accountId === a || !tx.accountId;
    if (tx.type === "TRANSFER" || tx.type === "ADJUSTMENT") return tx.destinationAccountId === a;
    return false;
  }
  return outflow ? tx.type === "EXPENSE" : tx.type === "INCOME";
}

function txSimilarity(row: PreparedRow, tx: Candidate): number {
  return Math.max(descriptionSimilarity(row.description, tx.description), tx.merchantName ? descriptionSimilarity(row.description, tx.merchantName) : 0);
}

async function classifyRows(ctx: ServiceContext, scope: ImportScope, rows: PreparedRow[], excludeBatchId?: string): Promise<PreparedRow[]> {
  const pending = rows.filter((r) => r.status === null && r.date && r.amountCents);
  if (!pending.length) return rows;

  // 1) Duplicidade com lotes anteriores (mesmo FITID ou mesma linha), na mesma conta/cartão.
  const externalIds = [...new Set(pending.map((r) => r.externalId).filter(Boolean) as string[])];
  const fingerprints = [...new Set(pending.map((r) => r.fingerprint).filter(Boolean) as string[])];
  const previous = await prisma.importRow.findMany({
    where: {
      householdId: ctx.householdId,
      ...(excludeBatchId ? { batchId: { not: excludeBatchId } } : {}),
      batch: { status: "IMPORTED", accountId: scope.accountId, creditCardId: scope.creditCardId },
      OR: [...(externalIds.length ? [{ externalId: { in: externalIds } }] : []), ...(fingerprints.length ? [{ fingerprint: { in: fingerprints } }] : [])],
    },
    select: { externalId: true, fingerprint: true, batch: { select: { fileName: true, importedAt: true, createdAt: true } } },
  });
  const byExternal = new Map(previous.filter((p) => p.externalId).map((p) => [p.externalId!, p]));
  const byFingerprint = new Map(previous.filter((p) => p.fingerprint).map((p) => [p.fingerprint!, p]));
  for (const r of pending) {
    const prev = (r.externalId && byExternal.get(r.externalId)) || (r.fingerprint && byFingerprint.get(r.fingerprint));
    if (!prev) continue;
    const when = prev.batch.importedAt ?? prev.batch.createdAt;
    r.status = "DUPLICATE";
    r.selected = false;
    r.message = `Já importado em ${formatDateBR(instantToISO(when, ctx.timezone))} (arquivo "${prev.batch.fileName.slice(0, 60)}").`;
  }

  const open = pending.filter((r) => r.status === null);
  if (!open.length) return rows;

  // 2) Parcelas de compras parceladas já registradas no app (fatura de cartão).
  const used = new Set<string>();
  if (scope.creditCardId) {
    const instRows = open.filter((r) => r.raw.installment);
    if (instRows.length) {
      const installments = await prisma.installment.findMany({
        where: {
          householdId: ctx.householdId,
          number: { in: [...new Set(instRows.map((r) => r.raw.installment!.number))] },
          amountCents: { in: [...new Set(instRows.map((r) => Math.abs(r.amountCents!)))] },
          transaction: { creditCardId: scope.creditCardId, deletedAt: null },
        },
        select: { transactionId: true, number: true, totalInstallments: true, amountCents: true },
      });
      for (const r of instRows) {
        const inst = r.raw.installment!;
        const hit = installments.find(
          (i) => i.number === inst.number && i.totalInstallments === inst.total && i.amountCents === Math.abs(r.amountCents!) && !used.has(`${i.transactionId}#${i.number}`),
        );
        if (hit) {
          used.add(`${hit.transactionId}#${hit.number}`);
          r.status = "MATCHED";
          r.matchedTransactionId = hit.transactionId;
          r.message = `Parcela ${inst.number}/${inst.total} de compra parcelada já registrada no app.`;
        } else if (inst.number > 1) {
          r.status = "NEW";
          r.selected = false;
          r.message = `Parcela ${inst.number}/${inst.total}: se a compra original já foi registrada no app, as parcelas são geradas automaticamente. Caso contrário, registre a compra com ${inst.total} parcelas.`;
        } else {
          r.message = `Compra parcelada em ${inst.total} vezes: será registrada com ${inst.total} parcelas de ${formatBRL(Math.abs(r.amountCents!))}.`;
        }
      }
    }
  }

  // 3) Correspondência com transações existentes (ex.: registradas pelo WhatsApp).
  const toMatch = open.filter((r) => r.status === null);
  if (!toMatch.length) return rows;
  const dates = toMatch.map((r) => r.date!).sort();
  const visibility = await getVisibilityScope(ctx);
  const txs = await prisma.transaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      ...visibleTransactionWhere(visibility),
      type: { in: ["EXPENSE", "INCOME", "TRANSFER", "CARD_PAYMENT", "ADJUSTMENT"] },
      date: { gte: isoToDate(addDays(dates[0]!, -MATCH_WINDOW_DAYS)), lte: isoToDate(addDays(dates[dates.length - 1]!, MATCH_WINDOW_DAYS)) },
    },
    select: {
      id: true,
      type: true,
      amountCents: true,
      date: true,
      description: true,
      accountId: true,
      destinationAccountId: true,
      creditCardId: true,
      paymentMethod: true,
      merchant: { select: { name: true } },
    },
    take: 20_000,
  });
  const candidates: Candidate[] = txs.map((t) => ({
    id: t.id,
    type: t.type,
    amountCents: t.amountCents,
    date: dateToISO(t.date),
    description: t.description,
    merchantName: t.merchant?.name ?? null,
    accountId: t.accountId,
    destinationAccountId: t.destinationAccountId,
    creditCardId: t.creditCardId,
    paymentMethod: t.paymentMethod,
  }));
  const byDate = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byDate.get(c.date) ?? [];
    list.push(c);
    byDate.set(c.date, list);
  }
  const near = (date: string) => {
    const list: Array<{ tx: Candidate; days: number }> = [];
    for (let d = -MATCH_WINDOW_DAYS; d <= MATCH_WINDOW_DAYS; d++) {
      for (const tx of byDate.get(addDays(date, d)) ?? []) list.push({ tx, days: Math.abs(d) });
    }
    return list;
  };

  const usedTx = new Set<string>();
  type Pair = { row: PreparedRow; tx: Candidate; score: number; days: number; ratio: number };
  const exact: Pair[] = [];
  const divergent: Pair[] = [];
  for (const row of toMatch) {
    const abs = Math.abs(row.amountCents!);
    for (const { tx, days } of near(row.date!)) {
      if (!compatible(row, tx, scope)) continue;
      const sim = txSimilarity(row, tx);
      const exactScope = (scope.accountId && (tx.accountId === scope.accountId || tx.destinationAccountId === scope.accountId)) || (scope.creditCardId && tx.creditCardId === scope.creditCardId);
      if (tx.amountCents === abs) {
        exact.push({ row, tx, days, ratio: 0, score: 100 - days * 10 + sim * 15 + (exactScope ? 5 : 0) });
      } else {
        const ratio = Math.abs(tx.amountCents - abs) / Math.max(tx.amountCents, abs);
        if (ratio <= DIVERGENCE_MAX_RATIO && sim >= 0.5) divergent.push({ row, tx, days, ratio, score: sim * 100 - days * 5 - ratio * 50 });
      }
    }
  }
  exact.sort((a, b) => b.score - a.score || a.row.rowIndex - b.row.rowIndex);
  for (const p of exact) {
    if (p.row.status !== null || usedTx.has(p.tx.id)) continue;
    usedTx.add(p.tx.id);
    p.row.status = "MATCHED";
    p.row.matchedTransactionId = p.tx.id;
    p.row.message = `Corresponde a "${p.tx.description.slice(0, 60)}" de ${formatDateBR(p.tx.date)}${p.days ? ` (${p.days} dia(s) de diferença)` : ""}.`;
  }
  divergent.sort((a, b) => b.score - a.score || a.row.rowIndex - b.row.rowIndex);
  for (const p of divergent) {
    if (p.row.status !== null || usedTx.has(p.tx.id)) continue;
    usedTx.add(p.tx.id);
    p.row.status = "DIVERGENT";
    p.row.matchedTransactionId = p.tx.id;
    p.row.message = `Parece ser "${p.tx.description.slice(0, 60)}" (${formatDateBR(p.tx.date)}), mas o valor no app é ${formatBRL(p.tx.amountCents)} e no extrato ${formatBRL(Math.abs(p.row.amountCents!))}.`;
  }
  for (const r of toMatch) if (r.status === null) r.status = "NEW";
  return rows;
}

// -----------------------------------------------------------------------------
// Persistência das linhas
// -----------------------------------------------------------------------------

function rowCreateData(householdId: string, batchId: string, r: PreparedRow): Prisma.ImportRowCreateManyInput {
  return {
    householdId,
    batchId,
    rowIndex: r.rowIndex,
    rawData: toJson(r.raw),
    date: r.date ? isoToDate(r.date) : null,
    amountCents: r.amountCents,
    description: r.description,
    externalId: r.externalId,
    fingerprint: r.fingerprint,
    status: r.status ?? "NEW",
    message: r.message?.slice(0, 500) ?? null,
    matchedTransactionId: r.matchedTransactionId,
    selected: r.selected,
    categoryId: r.categoryId,
  };
}

async function refreshCounters(db: Prisma.TransactionClient | typeof prisma, batchId: string) {
  const groups = await db.importRow.groupBy({ by: ["status"], where: { batchId }, _count: { _all: true } });
  const count = (s: ImportRowStatus) => groups.find((g) => g.status === s)?._count._all ?? 0;
  const total = groups.reduce((s, g) => s + g._count._all, 0);
  await db.importBatch.update({
    where: { id: batchId },
    data: { totalRows: total, newRows: count("NEW"), duplicateRows: count("DUPLICATE"), matchedRows: count("MATCHED"), importedRows: count("IMPORTED") },
  });
}

async function storeImportFile(ctx: ServiceContext, content: Buffer, fileName: string, sha: string, mimeType: string): Promise<string> {
  const existing = await prisma.attachment.findUnique({ where: { householdId_sha256: { householdId: ctx.householdId, sha256: sha } } });
  if (existing?.storageKey && !existing.contentDeletedAt && (await storedFileExists(existing.storageKey))) return existing.storageKey;
  const stored = await storeFile("imports", content);
  if (existing) {
    await prisma.attachment.update({ where: { id: existing.id }, data: { storageKey: stored.storageKey, contentDeletedAt: null } });
  } else {
    await prisma.attachment.create({
      data: {
        householdId: ctx.householdId,
        kind: "IMPORT_FILE",
        mimeType,
        sizeBytes: content.length,
        sha256: sha,
        storageKey: stored.storageKey,
        originalName: fileName.slice(0, 200),
        processingStatus: "STORED",
        uploadedByMemberId: ctx.memberId,
      },
    });
  }
  return stored.storageKey;
}

async function buildRows(
  ctx: ServiceContext,
  scope: ImportScope,
  format: ImportFileFormat,
  content: Buffer,
  opts: { mapping?: ColumnMapping | null; headerRowIndex?: number | null; invertSigns: boolean; excludeBatchId?: string },
) {
  const parsed = await parseImportFile(format, content, opts);
  if (parsed.ofxKind === "CREDIT_CARD" && scope.accountId) throw new ValidationError("Este OFX é de cartão de crédito. Selecione o cartão correspondente em vez de uma conta.");
  if (parsed.ofxKind === "BANK" && scope.creditCardId) throw new ValidationError("Este OFX é de conta bancária. Selecione a conta correspondente em vez de um cartão.");
  if (!parsed.rows.length) throw new ValidationError("Nenhum lançamento foi encontrado no arquivo.");
  if (parsed.rows.length > IMPORT_MAX_ROWS) throw new ValidationError("O arquivo tem mais de 5.000 linhas. Divida o arquivo em partes.");
  const warnings = [...parsed.meta.warnings];
  if (!scope.accountId && !scope.creditCardId) {
    warnings.push("Nenhuma conta ou cartão foi escolhido: os lançamentos não alterarão saldos e ficarão pendentes de forma de pagamento.");
  }
  const prepared = await prepareRows(ctx, scope, parsed.rows, { invertSigns: opts.invertSigns, warnings });
  const rows = await classifyRows(ctx, scope, prepared.rows, opts.excludeBatchId);
  const meta: ImportBatchMeta = {
    ...emptyMeta(),
    ...parsed.meta,
    warnings,
    invertSigns: opts.invertSigns,
    cardPurchasesPositive: prepared.cardPurchasesPositive,
  };
  return { rows, meta };
}

// -----------------------------------------------------------------------------
// Prévia
// -----------------------------------------------------------------------------

export async function createImportPreview(ctx: ServiceContext, rawInput: ImportPreviewInput) {
  assertCan(ctx, "data:import");
  const input = importPreviewSchema.parse(rawInput);
  const base64 = input.contentBase64.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new ValidationError("Conteúdo do arquivo inválido (base64).");
  const content = Buffer.from(base64, "base64");
  const { contentBase64: _ignored, fileName, ...options } = input;
  return createImportPreviewFromBuffer(ctx, { fileName, content, ...options });
}

/** Prévia a partir do conteúdo binário (upload multipart). */
export async function createImportPreviewFromBuffer(ctx: ServiceContext, input: { fileName: string; content: Buffer } & ImportPreviewFileOptions) {
  assertCan(ctx, "data:import");
  const opts = importPreviewFileSchema.parse(input);
  const fileName = input.fileName.trim().slice(0, 200) || "extrato";
  const content = input.content;
  if (!content.length) throw new ValidationError("O arquivo está vazio.");
  if (content.length > IMPORT_MAX_BYTES) throw new ValidationError("O arquivo excede o limite de 5 MB.");
  const scope = await resolveScope(ctx, opts.accountId, opts.creditCardId);
  const format = opts.format ?? detectImportFormat(fileName, content);
  const { rows, meta } = await buildRows(ctx, scope, format, content, {
    mapping: opts.mapping ?? null,
    headerRowIndex: opts.headerRowIndex ?? null,
    invertSigns: opts.invertSigns,
  });

  const sha = sha256Hex(content);
  const previous = await prisma.importBatch.findFirst({
    where: { householdId: ctx.householdId, fileSha256: sha, status: "IMPORTED", accountId: scope.accountId, creditCardId: scope.creditCardId },
    orderBy: { createdAt: "desc" },
  });
  if (previous) {
    meta.warnings.unshift(
      `Este arquivo já foi importado ${scope.creditCardId ? "neste cartão" : scope.accountId ? "nesta conta" : "anteriormente"} em ${formatDateBR(instantToISO(previous.importedAt ?? previous.createdAt, ctx.timezone))}. As linhas repetidas foram marcadas como duplicadas.`,
    );
  }
  meta.storageKey = await storeImportFile(ctx, content, fileName, sha, MIME[format]);

  const batch = await withTransaction(async (db) => {
    const created = await db.importBatch.create({
      data: {
        householdId: ctx.householdId,
        format,
        fileName,
        fileSha256: sha,
        accountId: scope.accountId,
        creditCardId: scope.creditCardId,
        status: "PREVIEW",
        mapping: toJson(meta),
        createdById: ctx.memberId,
      },
    });
    await db.importRow.createMany({ data: rows.map((r) => rowCreateData(ctx.householdId, created.id, r)) });
    await refreshCounters(db, created.id);
    return created;
  });
  logger.info({ householdId: ctx.householdId, batchId: batch.id, format, rows: rows.length }, "imports: prévia criada");
  await publishEvent(ctx.householdId, "import.changed", batch.id);
  return getImportPreview(ctx, batch.id);
}

const rowInclude = {
  matchedTransaction: { select: { id: true, description: true, amountCents: true, date: true, type: true, status: true, source: true, deletedAt: true } },
} satisfies Prisma.ImportRowInclude;

type RowWithMatch = Prisma.ImportRowGetPayload<{ include: typeof rowInclude }>;

function rowDTO(r: RowWithMatch) {
  const raw = readRaw(r.rawData);
  return {
    id: r.id,
    rowIndex: r.rowIndex,
    date: r.date ? dateToISO(r.date) : null,
    amountCents: r.amountCents,
    description: r.description,
    externalId: r.externalId,
    status: r.status,
    message: r.message,
    selected: r.selected,
    categoryId: r.categoryId,
    kind: raw.kind,
    categoryName: raw.categoryName ?? null,
    installment: raw.installment ?? null,
    cells: raw.cells,
    matchedTransaction: r.matchedTransaction
      ? {
          id: r.matchedTransaction.id,
          description: r.matchedTransaction.description,
          amountCents: r.matchedTransaction.amountCents,
          date: dateToISO(r.matchedTransaction.date),
          type: r.matchedTransaction.type,
          status: r.matchedTransaction.status,
          source: r.matchedTransaction.source,
          deleted: Boolean(r.matchedTransaction.deletedAt),
        }
      : null,
    createdTransactionId: r.createdTransactionId,
  };
}

function batchDTO(
  b: Prisma.ImportBatchGetPayload<{ include: { account: { select: { id: true; name: true } }; creditCard: { select: { id: true; name: true } } } }>,
) {
  const meta = readMeta(b.mapping);
  return {
    id: b.id,
    format: b.format,
    fileName: b.fileName,
    status: b.status,
    account: b.account,
    creditCard: b.creditCard,
    totalRows: b.totalRows,
    newRows: b.newRows,
    duplicateRows: b.duplicateRows,
    matchedRows: b.matchedRows,
    importedRows: b.importedRows,
    createdAt: b.createdAt.toISOString(),
    importedAt: b.status === "PREVIEW" ? null : b.importedAt?.toISOString() ?? null,
    undoneAt: b.undoneAt?.toISOString() ?? null,
    warnings: meta.warnings,
    statement: meta.statement,
  };
}

export async function getImportPreview(ctx: ServiceContext, batchId: string) {
  await loadBatch(ctx, batchId);
  const batch = await prisma.importBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: { account: { select: { id: true, name: true } }, creditCard: { select: { id: true, name: true } } },
  });
  const rows = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowIndex: "asc" }, include: rowInclude });
  const meta = readMeta(batch.mapping);
  const counts: Record<ImportRowStatus, number> = { NEW: 0, DUPLICATE: 0, MATCHED: 0, DIVERGENT: 0, SKIPPED: 0, IMPORTED: 0, ERROR: 0 };
  let selected = 0;
  let selectedNewCents = 0;
  for (const r of rows) {
    counts[r.status]++;
    if (r.selected && r.status === "NEW") {
      selected++;
      selectedNewCents += r.amountCents ?? 0;
    }
  }
  return {
    batch: batchDTO(batch),
    counts: { total: rows.length, ...counts, selectedNew: selected, selectedNewNetCents: selectedNewCents },
    mapping: meta.mapping,
    headers: meta.headers,
    headerRowIndex: meta.headerRowIndex,
    invertSigns: meta.invertSigns,
    cardPurchasesPositive: meta.cardPurchasesPositive,
    rows: rows.map(rowDTO),
  };
}

export async function updateImportRows(ctx: ServiceContext, batchId: string, rawUpdates: ImportRowsUpdate) {
  assertCan(ctx, "data:import");
  const { rows: updates } = importRowsUpdateSchema.parse({ rows: rawUpdates });
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação já foi concluída e não pode mais ser alterada.");
  const rows = await prisma.importRow.findMany({ where: { batchId, id: { in: updates.map((u) => u.rowId) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const categoryIds = [...new Set(updates.map((u) => u.categoryId).filter(Boolean) as string[])];
  const categories = categoryIds.length
    ? await prisma.category.findMany({ where: { id: { in: categoryIds }, householdId: ctx.householdId }, select: { id: true, kind: true } })
    : [];
  const catKind = new Map(categories.map((c) => [c.id, c.kind]));

  await withTransaction(async (db) => {
    for (const u of updates) {
      const row = byId.get(u.rowId);
      if (!row) throw new NotFoundError("Linha da importação");
      const data: Prisma.ImportRowUpdateInput = {};
      if (u.forceNew) {
        if (!["DUPLICATE", "MATCHED", "DIVERGENT"].includes(row.status)) throw new ValidationError("Apenas linhas duplicadas, correspondentes ou divergentes podem ser importadas como novas.");
        data.status = "NEW";
        data.matchedTransaction = { disconnect: true };
        data.selected = true;
        data.message = "Marcada pelo usuário para importar como novo lançamento.";
      }
      if (u.selected !== undefined) {
        const status = (data.status as ImportRowStatus | undefined) ?? row.status;
        if (u.selected && !["NEW", "MATCHED", "DIVERGENT"].includes(status)) {
          throw new ValidationError("Esta linha não pode ser selecionada (duplicada, ignorada ou com erro).", { rowId: row.id });
        }
        data.selected = u.selected;
      }
      if (u.categoryId !== undefined) {
        if (u.categoryId) {
          const kind = catKind.get(u.categoryId);
          if (!kind) throw new ValidationError("Categoria inválida.", { rowId: row.id });
          const raw = readRaw(row.rawData);
          if (raw.kind === "CARD_PAYMENT") throw new ValidationError("Pagamento de fatura não recebe categoria.", { rowId: row.id });
          const expected = (row.amountCents ?? 0) < 0 ? "EXPENSE" : "INCOME";
          if (kind !== expected) throw new ValidationError(expected === "INCOME" ? "Use uma categoria de receita." : "Use uma categoria de despesa.", { rowId: row.id });
        }
        data.categoryId = u.categoryId;
      }
      if (Object.keys(data).length) await db.importRow.update({ where: { id: row.id }, data });
    }
    await refreshCounters(db, batchId);
  });
  await publishEvent(ctx.householdId, "import.changed", batchId);
  return getImportPreview(ctx, batchId);
}

/** Reprocessa a prévia com outro mapeamento de colunas (ou inversão de sinais). */
export async function previewMapping(ctx: ServiceContext, batchId: string, rawInput: ImportMappingUpdate) {
  assertCan(ctx, "data:import");
  const input = importMappingUpdateSchema.parse(rawInput);
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação já foi concluída e não pode mais ser alterada.");
  const meta = readMeta(batch.mapping);
  if (batch.format === "OFX" && input.mapping) throw new ValidationError("Arquivos OFX não usam mapeamento de colunas.");
  if (!meta.storageKey || !(await storedFileExists(meta.storageKey))) throw new ValidationError("O arquivo original não está mais disponível. Envie o arquivo novamente.");
  const content = await readStoredFile(meta.storageKey);
  const scope = await resolveScope(ctx, batch.accountId, batch.creditCardId);
  const { rows, meta: newMeta } = await buildRows(ctx, scope, batch.format, content, {
    mapping: input.mapping ?? (input.headerRowIndex !== undefined && input.headerRowIndex !== null ? null : meta.mapping),
    headerRowIndex: input.headerRowIndex ?? (input.mapping ? meta.headerRowIndex : null),
    invertSigns: input.invertSigns ?? meta.invertSigns,
    excludeBatchId: batchId,
  });
  newMeta.storageKey = meta.storageKey;
  const fileWarning = meta.warnings.find((w) => w.startsWith("Este arquivo já foi importado"));
  if (fileWarning) newMeta.warnings.unshift(fileWarning);
  await withTransaction(async (db) => {
    await db.importRow.deleteMany({ where: { batchId } });
    await db.importRow.createMany({ data: rows.map((r) => rowCreateData(ctx.householdId, batchId, r)) });
    await db.importBatch.update({ where: { id: batchId }, data: { mapping: toJson(newMeta) } });
    await refreshCounters(db, batchId);
  });
  await publishEvent(ctx.householdId, "import.changed", batchId);
  return getImportPreview(ctx, batchId);
}

// -----------------------------------------------------------------------------
// Efetivação e desfazer
// -----------------------------------------------------------------------------

export async function commitImport(ctx: ServiceContext, batchId: string) {
  assertCan(ctx, "data:import");
  assertCan(ctx, "transactions:write");
  const batch = await loadBatch(ctx, batchId);
  if (batch.status === "IMPORTED") return { ...(await getImportPreview(ctx, batchId)), result: { alreadyImported: true, created: 0, matched: 0, divergent: 0, errors: 0 } };
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação foi desfeita. Envie o arquivo novamente para gerar uma nova prévia.");

  const claim = await prisma.importBatch.updateMany({
    where: { id: batchId, status: "PREVIEW", OR: [{ importedAt: null }, { importedAt: { lt: new Date(Date.now() - COMMIT_STALE_MS) } }] },
    data: { importedAt: new Date() },
  });
  if (!claim.count) throw new ConflictError("A importação deste arquivo já está em andamento.");

  const meta = readMeta(batch.mapping);
  const scope = await resolveScope(ctx, batch.accountId, batch.creditCardId);
  let created = 0;
  let matched = 0;
  let divergent = 0;
  let errors = 0;
  const fills: ReconciledFill[] = [...(meta.commit?.reconciledFills ?? [])];

  try {
    const rows = await prisma.importRow.findMany({
      where: { batchId, selected: true, status: { in: ["NEW", "MATCHED", "DIVERGENT"] } },
      orderBy: { rowIndex: "asc" },
      include: rowInclude,
    });
    for (const row of rows) {
      const raw = readRaw(row.rawData);
      if (row.status === "NEW") {
        if (row.createdTransactionId || !row.date || !row.amountCents) continue;
        const amount = Math.abs(row.amountCents);
        const outflow = row.amountCents < 0;
        const installment = scope.creditCardId && raw.installment && raw.installment.number === 1 ? raw.installment : null;
        const fields =
          raw.kind === "CARD_PAYMENT"
            ? { type: "CARD_PAYMENT" as const, creditCardId: raw.cardPaymentCardId ?? null, accountId: scope.accountId, paymentMethod: raw.suggestedPaymentMethod ?? "BANK_TRANSFER" }
            : scope.creditCardId
              ? { type: "EXPENSE" as const, creditCardId: scope.creditCardId, installmentCount: installment?.total ?? 1, payerMemberId: scope.cardHolderId ?? undefined }
              : {
                  type: outflow ? ("EXPENSE" as const) : ("INCOME" as const),
                  accountId: scope.accountId,
                  paymentMethod: raw.suggestedPaymentMethod ?? null,
                  payerMemberId: scope.accountOwnerId ?? undefined,
                };
        try {
          await withTransaction(async (db) => {
            const res = await createTransaction(
              ctx,
              {
                ...fields,
                amountCents: installment ? amount * installment.total : amount,
                description: row.description || "Lançamento importado",
                notes: raw.memo && row.description && !row.description.includes(raw.memo) ? raw.memo.slice(0, 500) : null,
                date: dateToISO(row.date!),
                categoryId: raw.kind === "CARD_PAYMENT" ? null : row.categoryId,
              },
              { source: "IMPORT", importBatchId: batchId, checkDuplicates: false, db },
            );
            await db.importRow.update({ where: { id: row.id }, data: { status: "IMPORTED", createdTransactionId: res.transaction.id } });
          });
          created++;
        } catch (err) {
          errors++;
          logger.warn({ householdId: ctx.householdId, batchId, rowIndex: row.rowIndex, err: errorInfo(err).name }, "imports: linha não importada");
          await prisma.importRow.update({ where: { id: row.id }, data: { status: "ERROR", message: errorMessage(err).slice(0, 500) } });
        }
        continue;
      }

      if (row.status === "MATCHED") {
        matched++;
        const tx = row.matchedTransaction;
        if (!tx || tx.deletedAt || fills.some((f) => f.rowId === row.id)) continue;
        // Conciliação: completa a conta/cartão de lançamentos registrados sem forma de pagamento.
        const full = await prisma.transaction.findUnique({ where: { id: tx.id }, select: { accountId: true, creditCardId: true, type: true, paymentMethod: true } });
        if (!full || full.accountId || full.creditCardId || (full.type !== "EXPENSE" && full.type !== "INCOME")) continue;
        const field = scope.creditCardId ? "creditCardId" : scope.accountId ? "accountId" : null;
        const value = scope.creditCardId ?? scope.accountId;
        if (!field || !value || (field === "creditCardId" && full.type !== "EXPENSE")) continue;
        try {
          await updateTransaction(
            ctx,
            tx.id,
            field === "creditCardId" ? { creditCardId: value } : { accountId: value, paymentMethod: full.paymentMethod ?? raw.suggestedPaymentMethod ?? undefined },
            { reason: "Conciliação com extrato importado" },
          );
          fills.push({ rowId: row.id, transactionId: tx.id, field, value, previousPaymentMethod: full.paymentMethod });
        } catch (err) {
          logger.warn({ householdId: ctx.householdId, batchId, err: errorInfo(err).name }, "imports: conciliação não aplicada");
        }
        continue;
      }

      if (row.status === "DIVERGENT" && row.matchedTransaction) {
        divergent++;
        const tx = row.matchedTransaction;
        await createPendingItem(prisma, {
          householdId: ctx.householdId,
          type: "IMPORT_DIVERGENCE",
          title: `Valor divergente: ${row.description}`.slice(0, 200),
          description: `No extrato: ${formatBRL(Math.abs(row.amountCents ?? 0))} em ${formatDateBR(row.date)}. No app: ${formatBRL(tx.amountCents)} em ${formatDateBR(tx.date)} ("${tx.description}"). Verifique qual valor está correto.`,
          importRowId: row.id,
          relatedTransactionId: tx.id,
          dedupeKey: `import-div:${row.id}`,
          data: { batchId, statementAmountCents: Math.abs(row.amountCents ?? 0), appAmountCents: tx.amountCents },
        });
      }
    }

    meta.commit = { created, matched, divergent, errors, reconciledFills: fills };
    await withTransaction(async (db) => {
      await refreshCounters(db, batchId);
      await db.importBatch.update({ where: { id: batchId }, data: { status: "IMPORTED", importedAt: new Date(), mapping: toJson(meta) } });
      await audit(
        ctx,
        {
          action: "IMPORT",
          entityType: "ImportBatch",
          entityId: batchId,
          after: { fileName: batch.fileName, format: batch.format, created, matched, divergent, errors },
          metadata: { accountId: batch.accountId, creditCardId: batch.creditCardId },
        },
        db,
      );
    });
  } catch (err) {
    // Libera o lote para nova tentativa (linhas já importadas não são recriadas).
    await prisma.importBatch.updateMany({ where: { id: batchId, status: "PREVIEW" }, data: { importedAt: null } });
    throw err;
  }

  logger.info({ householdId: ctx.householdId, batchId, created, matched, divergent, errors }, "imports: lote importado");
  await publishEvent(ctx.householdId, "import.changed", batchId);
  await publishEvent(ctx.householdId, "transaction.changed");
  await publishEvent(ctx.householdId, "account.changed");
  await publishEvent(ctx.householdId, "pending.changed");
  return { ...(await getImportPreview(ctx, batchId)), result: { alreadyImported: false, created, matched, divergent, errors } };
}

/** Desfaz a importação: exclusão lógica (auditada) das transações criadas pelo lote. */
export async function undoImport(ctx: ServiceContext, batchId: string) {
  assertCan(ctx, "data:import");
  const batch = await loadBatch(ctx, batchId);
  if (batch.status === "UNDONE") return { ...(await getImportPreview(ctx, batchId)), result: { alreadyUndone: true, removed: 0 } };
  if (batch.status !== "IMPORTED") throw new ValidationError("Somente importações concluídas podem ser desfeitas.");
  const meta = readMeta(batch.mapping);

  const rows = await prisma.importRow.findMany({ where: { batchId }, select: { id: true, createdTransactionId: true } });
  let removed = 0;
  for (const row of rows) {
    if (!row.createdTransactionId) continue;
    const tx = await prisma.transaction.findUnique({ where: { id: row.createdTransactionId }, select: { deletedAt: true } });
    if (!tx || tx.deletedAt) continue;
    await deleteTransaction(ctx, row.createdTransactionId, { reason: "Importação desfeita" });
    removed++;
  }

  // Reverte a conciliação (conta/cartão preenchidos em lançamentos correspondentes).
  for (const fill of meta.commit?.reconciledFills ?? []) {
    const tx = await prisma.transaction.findFirst({ where: { id: fill.transactionId, householdId: ctx.householdId }, select: { accountId: true, creditCardId: true, deletedAt: true } });
    if (!tx || tx.deletedAt || tx[fill.field] !== fill.value) continue;
    try {
      await updateTransaction(
        ctx,
        fill.transactionId,
        fill.field === "creditCardId" ? { creditCardId: null, paymentMethod: fill.previousPaymentMethod ?? "CREDIT_CARD" } : { accountId: null, paymentMethod: fill.previousPaymentMethod },
        { reason: "Importação desfeita" },
      );
    } catch (err) {
      logger.warn({ householdId: ctx.householdId, batchId, err: errorInfo(err).name }, "imports: falha ao reverter conciliação");
    }
  }

  await resolvePendingWhere(
    prisma,
    { householdId: ctx.householdId, type: "IMPORT_DIVERGENCE", importRowId: { in: rows.map((r) => r.id) } },
    "Importação desfeita",
    ctx.memberId,
    "DISMISSED",
  );

  const updated = await prisma.importBatch.updateMany({ where: { id: batchId, status: "IMPORTED" }, data: { status: "UNDONE", undoneAt: new Date() } });
  if (updated.count) {
    await audit(ctx, {
      action: "UNDO_IMPORT",
      entityType: "ImportBatch",
      entityId: batchId,
      before: { status: "IMPORTED", importedRows: batch.importedRows },
      after: { status: "UNDONE", removed },
      metadata: { fileName: batch.fileName },
    });
  }
  await publishEvent(ctx.householdId, "import.changed", batchId);
  await publishEvent(ctx.householdId, "transaction.changed");
  await publishEvent(ctx.householdId, "account.changed");
  await publishEvent(ctx.householdId, "pending.changed");
  return { ...(await getImportPreview(ctx, batchId)), result: { alreadyUndone: false, removed } };
}

// -----------------------------------------------------------------------------
// Conciliação e histórico
// -----------------------------------------------------------------------------

export async function getReconciliation(ctx: ServiceContext, batchId: string) {
  const preview = await getImportPreview(ctx, batchId);
  const rows = preview.rows;
  const dated = rows.filter((r) => r.date).map((r) => r.date!) as string[];
  dated.sort();
  const period = dated.length ? { start: dated[0]!, end: dated[dated.length - 1]! } : null;

  const linkedIds = new Set<string>();
  for (const r of rows) {
    if (r.matchedTransaction) linkedIds.add(r.matchedTransaction.id);
    if (r.createdTransactionId) linkedIds.add(r.createdTransactionId);
  }

  // Lançamentos do app no período da conta/cartão que não aparecem no extrato.
  let missingInStatement: Array<{ id: string; description: string; amountCents: number; date: string; type: string; source: string }> = [];
  const batch = preview.batch;
  if (period && (batch.account || batch.creditCard)) {
    const visibility = await getVisibilityScope(ctx);
    const where: Prisma.TransactionWhereInput = {
      householdId: ctx.householdId,
      deletedAt: null,
      ...visibleTransactionWhere(visibility),
      date: { gte: isoToDate(period.start), lte: isoToDate(period.end) },
      ...(batch.creditCard
        ? { creditCardId: batch.creditCard.id, type: "EXPENSE" }
        : { OR: [{ accountId: batch.account!.id }, { destinationAccountId: batch.account!.id }] }),
    };
    const txs = await prisma.transaction.findMany({
      where,
      orderBy: { date: "asc" },
      take: 1_000,
      select: { id: true, description: true, amountCents: true, date: true, type: true, source: true },
    });
    missingInStatement = txs.filter((t) => !linkedIds.has(t.id)).map((t) => ({ ...t, date: dateToISO(t.date) }));
  }

  const sum = (list: typeof rows, sign: 1 | -1) => list.reduce((s, r) => s + (r.amountCents && Math.sign(r.amountCents) === sign ? Math.abs(r.amountCents) : 0), 0);
  const considered = rows.filter((r) => !["ERROR", "SKIPPED", "DUPLICATE"].includes(r.status));
  return {
    batch,
    period,
    totals: {
      statementInflowCents: sum(considered, 1),
      statementOutflowCents: sum(considered, -1),
      statementLedgerBalanceCents: batch.statement?.ledgerBalanceCents ?? null,
    },
    counts: preview.counts,
    matched: rows.filter((r) => r.status === "MATCHED"),
    notInApp: rows.filter((r) => r.status === "NEW" || r.status === "IMPORTED"),
    divergent: rows
      .filter((r) => r.status === "DIVERGENT")
      .map((r) => ({ ...r, differenceCents: r.matchedTransaction ? Math.abs(r.amountCents ?? 0) - r.matchedTransaction.amountCents : null })),
    duplicates: rows.filter((r) => r.status === "DUPLICATE"),
    ignored: rows.filter((r) => r.status === "SKIPPED" || r.status === "ERROR"),
    missingInStatement,
    notes: [
      "Correspondentes: lançamentos do extrato que já existiam no app (mesmo valor, até 3 dias de diferença).",
      "Não registradas no app: linhas novas do extrato (importadas ou aguardando importação).",
      "Divergências: descrição e data semelhantes, mas com valor diferente (até 30%). Ficam como pendência para revisão.",
      "Ausentes no extrato: lançamentos do app na mesma conta/cartão e período que não aparecem no arquivo.",
    ],
  };
}

export async function listImports(ctx: ServiceContext, opts: { limit?: number } = {}) {
  const batches = await prisma.importBatch.findMany({
    where: batchVisibilityWhere(ctx),
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    include: { account: { select: { id: true, name: true } }, creditCard: { select: { id: true, name: true } } },
  });
  return batches.map(batchDTO);
}

