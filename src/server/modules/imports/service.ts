import { z } from "zod";
import type { FinancialRule, ImportRowStatus, PaymentMethod, Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { errorInfo, logger } from "../../logger";
import { sha256Hex } from "../../crypto";
import { readStoredFile, storeFile, storedFileExists } from "../../storage";
import { addDays, dateToISO, formatDateBR, instantToISO, isoToDate, todayISO } from "@/lib/dates";
import { formatBRL, formatMoney, MAX_AMOUNT_CENTS } from "@/lib/money";
import { normalizeText } from "@/lib/utils";
import { audit } from "../audit/service";
import { createRule } from "../categories/service";
import { createPendingItem, resolvePendingWhere } from "../pending/service";
import { createTransaction, deleteTransaction, updateTransaction } from "../transactions/service";
import { NATURES, setTransactionNature, type Nature } from "../transactions/nature";
import { findMatchingRule } from "../rules/matcher";
import { getVisibilityScope, visibleAccountWhere, visibleCardWhere, visibleTransactionWhere } from "../visibility/scope";
import { parseCsv } from "./csv";
import { isOfx, ofxDescription, parseOfx, type OfxStatement } from "./ofx";
import { parseXlsx } from "./xlsx";
import { bankMatches, type PdfRow, type PdfStatementKind } from "./pdf";
import { readPdfForImport } from "./pdf-import";
import { resolveOwnMove, similarityKey, type AccountLite, type OwnMoveKind } from "../transfers/own-moves";
import { applyMapping, columnMappingSchema, detectMapping, mappingProblems } from "./mapping";
import { descriptionSimilarity, detectInstallment, importRowFingerprint, looksLikeCardBillPayment, looksLikeCardCredit } from "./matching";
import type { ColumnMapping, ImportFileFormat, ParsedImportRow, ParsedTable } from "./types";

// -----------------------------------------------------------------------------
// Limites e schemas
// -----------------------------------------------------------------------------

export const IMPORT_MAX_MB = 15;
export const IMPORT_MAX_BYTES = IMPORT_MAX_MB * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5_000;
/** Janela (dias) para considerar uma transação existente como correspondente. */
export const MATCH_WINDOW_DAYS = 3;
/** Diferença relativa máxima de valor para apontar divergência. */
export const DIVERGENCE_MAX_RATIO = 0.3;
const COMMIT_STALE_MS = 10 * 60_000;

const idSchema = z.string().min(1).max(64);

const previewOptionsSchema = z.object({
  format: z.enum(["CSV", "OFX", "XLSX", "PDF"]).optional(),
  accountId: idSchema.nullish(),
  creditCardId: idSchema.nullish(),
  mapping: columnMappingSchema.nullish(),
  headerRowIndex: z.number().int().min(-1).max(200).nullish(),
  invertSigns: z.boolean().default(false),
});

export const importPreviewSchema = previewOptionsSchema
  .extend({
    fileName: z.string().trim().min(1).max(200),
    /** Conteúdo do arquivo em base64 (limitado pelo tamanho das requisições JSON; arquivos maiores, via multipart). */
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

type RowKind = "EXPENSE" | "INCOME" | "CARD_PAYMENT" | "TRANSFER";

/** Confirmar fatura: cada compra nova é importada (padrão) ou não. */
export const REVIEW_DECISIONS = ["IMPORT", "SKIP"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

interface ImportScope {
  accountId: string | null;
  creditCardId: string | null;
  accountOwnerId: string | null;
  cardHolderId: string | null;
  label: string | null;
}

interface StatementInfo {
  kind: "BANK" | "CREDIT_CARD";
  /** Banco identificado no PDF. */
  bank?: string | null;
  /** PDF: lido do texto (local) ou pela IA (digitalizado). */
  source?: "TEXT" | "AI";
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

/** Lançamento existente (receita/despesa) convertido em transferência na confirmação. */
interface ConvertedTransfer {
  rowId: string;
  transactionId: string;
  before: { type: "EXPENSE" | "INCOME"; accountId: string | null; destinationAccountId: string | null; categoryId: string | null; subcategoryId: string | null; paymentMethod: PaymentMethod | null };
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
  /** PDF lido pela IA: guarda as linhas para reprocessar a prévia sem nova chamada. */
  pdfAi?: { kind: PdfStatementKind; bank: string | null; rows: PdfRow[] } | null;
  /** Duplicados encontrados na confirmação (linhas de outros arquivos importados depois da prévia). */
  duplicatesAtCommit?: number;
  /** PDF cujo tipo (extrato × fatura) não bate com o destino escolhido: exige revisão no site. */
  scopeMismatch?: boolean;
  /** Prévia criada a partir de um PDF enviado no WhatsApp (confirmação pela conversa). */
  origin?: { channel: "WHATSAPP"; chatId: string; messageId: string } | null;
  /** Natureza padrão das linhas sem regra (ex.: PDF enviado no grupo da empresa). */
  defaultNature?: "BUSINESS" | null;
  /** Confirmar fatura: sugestões de regra dispensadas nesta importação. */
  reviewDismissed?: string[];
  commit?: {
    created: number;
    matched: number;
    divergent: number;
    errors: number;
    reconciledFills: ReconciledFill[];
    convertedTransfers?: ConvertedTransfer[];
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
  /** TRANSFER: conta do outro lado (saída da linha → destino; entrada → origem). */
  transferAccountId?: string | null;
  /** Por que virou transferência: investimento, contas próprias, regra aprendida ou escolha manual. */
  transferReason?: OwnMoveKind | "RULE" | "MANUAL" | null;
  /** EXPENSE/INCOME quando a pessoa desfaz a transferência na prévia. */
  originalKind?: RowKind | null;
  /** Transferência entre moedas: valor na moeda da outra conta (informado pela pessoa). */
  counterpartAmountCents?: number | null;
  /** Natureza escolhida na prévia (vale sobre as regras ao importar). */
  nature?: Nature | null;
  /** Natureza sugerida por regra (Pessoal/Empresa/Repasse) e pedido de escolha ("perguntar"). */
  natureSuggested?: Nature | null;
  natureAsk?: boolean;
  /** Sugestão veio da natureza do grupo do WhatsApp (não de regra). */
  natureFromGroup?: boolean;
  /** Migração de planilha: aba/linha de origem, subcategoria, pessoa, compra parcelada e totais mensais. */
  location?: { sheet: string; row: number } | null;
  subcategory?: { id: string; categoryId: string } | null;
  payerMemberId?: string | null;
  installmentPlan?: { count: number; amountCents: number; firstNumber: number; ofTotal: number } | null;
  consolidated?: boolean;
  /** Confirmar fatura: "não importar" escolhido pela pessoa (ou por uma regra, com skipRuleId). */
  review?: "SKIP" | null;
  skipRuleId?: string | null;
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
  PDF: "application/pdf",
};

export function detectImportFormat(fileName: string, content: Buffer): ImportFileFormat {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (content.subarray(0, 1024).includes("%PDF-")) return "PDF";
  if (ext === "pdf") throw new ValidationError("O arquivo tem extensão .pdf, mas não é um PDF válido.");
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

const TRANSFER_WHY: Record<string, string> = {
  INVESTMENT: "aplicação/resgate de investimento",
  OWN_ACCOUNTS: "transferência entre contas próprias",
  RULE: "regra aprendida",
  FOREIGN: "remessa/câmbio entre contas próprias",
  MANUAL: "marcado por você",
};

function transferMessage(raw: RowRawData, amountCents: number, accountName: string): string {
  const outflow = amountCents < 0;
  return `Transferência ${outflow ? "para" : "vinda de"} ${accountName} (${TRANSFER_WHY[raw.transferReason ?? "MANUAL"] ?? "transferência"}): não conta como receita nem despesa.`;
}

async function crossCurrencyMessage(r: PreparedRow, name: string, scopeCurrency: string, otherCurrency: string): Promise<string> {
  const outflow = (r.amountCents ?? 0) < 0;
  const { rateOn } = await import("../fx/service");
  let hint = "";
  if (scopeCurrency === "BRL" && r.date) {
    const rate = await rateOn(otherCurrency, r.date);
    if (rate) hint = ` Referência: pela PTAX de ${formatDateBR(rate.date)}, ${formatBRL(Math.abs(r.amountCents!))} ≈ ${formatMoney(Math.round(Math.abs(r.amountCents!) / rate.rate), otherCurrency)} (o valor real depende do câmbio da operação).`;
  }
  return `Transferência ${outflow ? "para" : "vinda de"} ${name} (${otherCurrency}): informe quanto ${outflow ? "chegou" : "saiu"} em ${otherCurrency} para importar.${hint}`;
}

/** Mensagens das linhas de transferência e linhas sem a conta do outro lado (ficam desmarcadas). */
/**
 * Natureza sugerida pelas regras (Pessoal/Empresa/Repasse) e linhas em que uma regra pede para
 * escolher (ex.: anúncios no cartão que podem ser da empresa, de cliente ou pessoais).
 */
async function annotateNature(
  ctx: ServiceContext,
  rows: PreparedRow[],
  scope: { accountId: string | null; creditCardId: string | null },
  warnings: string[],
  defaultNature: "BUSINESS" | null = null,
) {
  const candidates = rows.filter((r) => (r.raw.kind === "EXPENSE" || r.raw.kind === "INCOME") && r.amountCents && (r.status === "NEW" || r.status === "MATCHED"));
  if (!candidates.length) return;
  const rules = await prisma.financialRule.findMany({
    where: { householdId: ctx.householdId, active: true, setTransferAccountId: null, OR: [{ setExcludeFromReports: true }, { setScope: { not: null } }, { askNature: true }] },
  });
  if (!rules.length && !defaultNature) return;
  let asks = 0;
  for (const r of candidates) {
    const subject = { description: r.description, merchant: null, amountCents: Math.abs(r.amountCents!), type: r.raw.kind, accountId: scope.accountId, creditCardId: scope.creditCardId };
    const ex = findMatchingRule(rules.filter((x) => x.setExcludeFromReports), subject);
    const sc = ex ? null : findMatchingRule(rules.filter((x) => x.setScope), subject);
    const ask = ex || sc ? null : findMatchingRule(rules.filter((x) => x.askNature), subject);
    // Regra vence a natureza do grupo de origem.
    r.raw.natureSuggested = ex ? "PASSTHROUGH" : sc?.setScope === "BUSINESS" ? "BUSINESS" : sc ? "PERSONAL" : ask ? null : defaultNature;
    r.raw.natureAsk = Boolean(ask);
    r.raw.natureFromGroup = !ex && !sc && !ask && Boolean(defaultNature);
    if (ask && r.status === "NEW") asks++;
  }
  if (asks) warnings.push(`${asks} lançamento(s) pedem a natureza (Pessoal, Empresa ou Repasse de cliente): escolha na prévia ou depois em Pendências.`);
}

/** Regras "não importar" (Confirmar fatura): a compra vem desmarcada, com o nome da regra. */
async function annotateSkipRules(ctx: ServiceContext, rows: PreparedRow[], scope: { accountId: string | null; creditCardId: string | null }, warnings: string[]) {
  const candidates = rows.filter((r) => r.raw.kind === "EXPENSE" && r.amountCents && r.status === "NEW" && r.selected);
  if (!candidates.length) return;
  const rules = await prisma.financialRule.findMany({ where: { householdId: ctx.householdId, active: true, skipOnImport: true } });
  if (!rules.length) return;
  let skipped = 0;
  for (const r of candidates) {
    const rule = findMatchingRule(rules, { description: r.description, merchant: null, amountCents: Math.abs(r.amountCents!), type: r.raw.kind, accountId: scope.accountId, creditCardId: scope.creditCardId });
    if (!rule) continue;
    r.selected = false;
    r.raw.review = "SKIP";
    r.raw.skipRuleId = rule.id;
    r.message = `Regra "${rule.name}": não importar.${r.message ? ` ${r.message}` : ""}`;
    skipped++;
  }
  if (skipped) warnings.push(`${skipped} compra(s) desmarcada(s) por regra "não importar". Confira em "Confirmar fatura".`);
}

async function annotateTransfers(ctx: ServiceContext, rows: PreparedRow[], warnings: string[], scopeAccountId: string | null) {
  const transfers = rows.filter((r) => r.raw.kind === "TRANSFER" && r.amountCents);
  if (!transfers.length) return;
  const ids = [...new Set([...(transfers.map((r) => r.raw.transferAccountId).filter(Boolean) as string[]), ...(scopeAccountId ? [scopeAccountId] : [])])];
  const matchedIds = transfers.filter((r) => r.matchedTransactionId).map((r) => r.matchedTransactionId!);
  const [accounts, matched, investmentAccounts] = await Promise.all([
    prisma.account.findMany({ where: { id: { in: ids }, householdId: ctx.householdId }, select: { id: true, name: true, currency: true } }),
    matchedIds.length ? prisma.transaction.findMany({ where: { id: { in: matchedIds } }, select: { id: true, type: true } }) : Promise.resolve([]),
    prisma.account.count({ where: { ...visibleAccountWhere(ctx), archivedAt: null, type: { in: ["INVESTMENT", "SAVINGS"] } } }),
  ]);
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const currencies = new Map(accounts.map((a) => [a.id, a.currency]));
  const scopeCurrency = scopeAccountId ? currencies.get(scopeAccountId) ?? "BRL" : "BRL";
  const matchedType = new Map(matched.map((t) => [t.id, t.type]));
  let unresolved = 0;
  for (const r of transfers) {
    const name = r.raw.transferAccountId ? names.get(r.raw.transferAccountId) : undefined;
    const otherCurrency = r.raw.transferAccountId ? currencies.get(r.raw.transferAccountId) ?? "BRL" : scopeCurrency;
    if (r.status === "NEW" && name && otherCurrency !== scopeCurrency && !r.raw.counterpartAmountCents) {
      // Entre moedas: o valor do outro lado não está neste extrato — a pessoa informa (nada é estimado).
      r.selected = false;
      r.message = await crossCurrencyMessage(r, name, scopeCurrency, otherCurrency);
      continue;
    }
    if (r.status === "NEW") {
      if (!name) {
        unresolved++;
        r.selected = false;
        r.message = "Parece aplicação/resgate de investimento ou transferência entre contas próprias: escolha a conta do outro lado (ou crie uma conta de investimento) para importar como transferência.";
      } else {
        r.message = transferMessage(r.raw, r.amountCents!, name);
      }
    } else if (r.status === "MATCHED" && name) {
      const type = r.matchedTransactionId ? matchedType.get(r.matchedTransactionId) : undefined;
      if (type === "EXPENSE" || type === "INCOME") {
        r.message = `${r.message ?? "Já registrado no app."} Está como ${type === "INCOME" ? "receita" : "despesa"}: ao confirmar, vira transferência ${r.amountCents! < 0 ? "para" : "vinda de"} ${name}.`;
      }
    }
  }
  if (unresolved) {
    warnings.push(
      investmentAccounts
        ? `${unresolved} linha(s) parecem aplicação/resgate ou transferência entre contas próprias, mas não deu para saber qual conta é a do outro lado. Escolha a conta nessas linhas para importá-las como transferência.`
        : `${unresolved} linha(s) parecem aplicação/resgate de investimento, mas a família não tem conta de investimento cadastrada. Crie uma (ex.: "Investimentos" ou "CDB <banco>") e escolha-a nessas linhas: assim o dinheiro aplicado não vira despesa nem o resgate vira receita.`,
    );
  }
}

/**
 * Conta (extrato) ou cartão (fatura) do banco identificado no PDF. Só sugere quando há exatamente
 * uma opção compatível entre as visíveis para quem importa; com dúvida, devolve null.
 */
export async function suggestPdfScope(
  ctx: ServiceContext,
  kind: PdfStatementKind,
  bank: string | null,
): Promise<{ accountId: string | null; creditCardId: string | null; label: string } | null> {
  if (!bank || kind === "UNKNOWN") return null;
  if (kind === "CREDIT_CARD") {
    const cards = await prisma.creditCard.findMany({ where: { ...visibleCardWhere(ctx), archivedAt: null }, select: { id: true, name: true, issuer: true } });
    const hits = cards.filter((c) => bankMatches(bank, normalizeText(`${c.name} ${c.issuer ?? ""}`)));
    return hits.length === 1 ? { accountId: null, creditCardId: hits[0]!.id, label: hits[0]!.name } : null;
  }
  const accounts = await prisma.account.findMany({
    where: { ...visibleAccountWhere(ctx), archivedAt: null, type: { in: ["CHECKING", "DIGITAL", "SAVINGS", "OTHER"] } },
    select: { id: true, name: true, institution: true, type: true },
  });
  const hits = accounts.filter((a) => bankMatches(bank, normalizeText(`${a.name} ${a.institution ?? ""}`)));
  // Conta corrente/digital antes de poupança do mesmo banco.
  const main = hits.filter((a) => a.type === "CHECKING" || a.type === "DIGITAL");
  const pick = main.length === 1 ? main[0] : hits.length === 1 ? hits[0] : null;
  return pick ? { accountId: pick.id, creditCardId: null, label: pick.name } : null;
}

// -----------------------------------------------------------------------------
// Leitura do arquivo
// -----------------------------------------------------------------------------

interface ParseOptions {
  mapping?: ColumnMapping | null;
  headerRowIndex?: number | null;
  /** PDF: família (para a leitura por IA, quando autorizada), data de referência e nome do arquivo. */
  householdId?: string | null;
  timezone?: string;
  fileName?: string;
  messageId?: string | null;
  pdfAi?: ImportBatchMeta["pdfAi"];
}

interface ParseResult {
  rows: ParsedImportRow[];
  meta: Pick<ImportBatchMeta, "mapping" | "headers" | "headerRowIndex" | "delimiter" | "sheetName" | "statement" | "warnings" | "pdfAi">;
  ofxKind: "BANK" | "CREDIT_CARD" | null;
  /** PDF: tipo identificado pelo conteúdo (heurística; divergência com a conta escolhida vira aviso). */
  pdf: { kind: PdfStatementKind; bank: string | null; bankConfident: boolean; classification: "STATEMENT" | "RECEIPT" | "OTHER" } | null;
}

function tableRowsLimit(table: ParsedTable) {
  if (table.rows.length > IMPORT_MAX_ROWS) {
    throw new ValidationError(`O arquivo tem ${table.rows.length.toLocaleString("pt-BR")} linhas. O limite é de ${IMPORT_MAX_ROWS.toLocaleString("pt-BR")} linhas por importação — divida o arquivo em partes.`);
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
  if (format === "PDF") {
    const pdf = await readPdfForImport(content, {
      today: todayISO(opts.timezone),
      householdId: opts.householdId,
      fileName: opts.fileName,
      messageId: opts.messageId,
      aiRows: opts.pdfAi?.rows ?? null,
      aiMeta: opts.pdfAi ?? null,
      maxRows: IMPORT_MAX_ROWS,
    });
    return {
      rows: pdf.rows,
      ofxKind: null,
      pdf: { kind: pdf.kind, bank: pdf.bank, bankConfident: pdf.bankConfident, classification: pdf.classification },
      meta: {
        mapping: null,
        headers: [],
        headerRowIndex: null,
        delimiter: null,
        sheetName: null,
        statement: {
          kind: pdf.kind === "CREDIT_CARD" ? "CREDIT_CARD" : "BANK",
          bank: pdf.bank,
          source: pdf.source,
          bankId: null,
          accountIdMasked: null,
          startDate: pdf.startDate,
          endDate: pdf.endDate,
          ledgerBalanceCents: null,
        },
        warnings: pdf.warnings,
        pdfAi: pdf.aiRows ? { kind: pdf.kind, bank: pdf.bank, rows: pdf.aiRows } : null,
      },
    };
  }
  if (format === "OFX") {
    let st: OfxStatement;
    try {
      st = parseOfx(content);
    } catch (err) {
      throw new ValidationError((err as Error).message || "Arquivo OFX inválido.");
    }
    if (st.transactions.length > IMPORT_MAX_ROWS) throw new ValidationError(`O arquivo tem mais de ${IMPORT_MAX_ROWS.toLocaleString("pt-BR")} lançamentos. Divida o período em partes.`);
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
      pdf: null,
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
        pdfAi: null,
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
    pdf: null,
    meta: {
      mapping,
      headers: table.headers,
      headerRowIndex: table.headerRowIndex,
      delimiter: table.delimiter ?? null,
      sheetName: table.sheetName ?? null,
      statement: null,
      warnings,
      pdfAi: null,
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

  const [categories, subcategories, cards, ownAccounts, transferRules] = await Promise.all([
    prisma.category.findMany({ where: { householdId: ctx.householdId, archivedAt: null }, select: { id: true, name: true, kind: true } }),
    prisma.subcategory.findMany({ where: { householdId: ctx.householdId, archivedAt: null }, select: { name: true, categoryId: true, category: { select: { kind: true } } } }),
    scope.accountId
      ? prisma.creditCard.findMany({ where: { ...visibleCardWhere(ctx), archivedAt: null }, select: { id: true, name: true, issuer: true, last4: true } })
      : Promise.resolve([] as Array<{ id: string; name: string; issuer: string | null; last4: string | null }>),
    scope.accountId
      ? prisma.account.findMany({ where: { ...visibleAccountWhere(ctx), archivedAt: null }, select: { id: true, name: true, institution: true, type: true, currency: true } })
      : Promise.resolve([] as AccountLite[]),
    scope.accountId
      ? prisma.financialRule.findMany({ where: { householdId: ctx.householdId, active: true, setTransferAccountId: { not: null } } })
      : Promise.resolve([]),
  ]);
  const scopeAccount = ownAccounts.find((a) => a.id === scope.accountId) ?? null;
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

  let repeatedIds = 0;
  const rows = parsed.map<PreparedRow>((r) => {
    // Identificadores repetidos no próprio arquivo (alguns bancos repetem FITID/documento):
    // recebem sufixo para manter a unicidade; a duplicidade passa a depender de data/valor/descrição.
    let externalId = r.externalId;
    if (externalId) {
      const seen = (seenExternal.get(externalId) ?? 0) + 1;
      seenExternal.set(externalId, seen);
      if (seen > 1) {
        repeatedIds++;
        externalId = `${externalId.slice(0, 110)}~${seen}`;
      }
    }
    const amount = r.amountCents === null ? null : r.amountCents * signFactor;
    const outflow = (amount ?? 0) < 0;
    const raw: RowRawData = {
      cells: r.raw,
      kind: outflow ? "EXPENSE" : "INCOME",
      categoryName: r.categoryName,
      trnType: r.meta.trnType ?? null,
      memo: r.meta.memo ?? r.meta.notes ?? null,
      ...(r.meta.location ? { location: r.meta.location } : {}),
      ...(r.meta.subcategoryId && r.meta.categoryId ? { subcategory: { id: r.meta.subcategoryId, categoryId: r.meta.categoryId } } : {}),
      ...(r.meta.payerMemberId ? { payerMemberId: r.meta.payerMemberId } : {}),
      ...(r.meta.nature ? { nature: r.meta.nature } : {}),
      ...(r.meta.consolidated ? { consolidated: true } : {}),
      ...(r.meta.installmentPlan && isCard ? { installmentPlan: r.meta.installmentPlan } : {}),
    };
    const row: PreparedRow = {
      rowIndex: r.rowIndex,
      date: r.date,
      amountCents: amount,
      description: r.description.slice(0, 200),
      externalId,
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
      // Migração: a parcela vem da coluna/descrição já interpretada (e agrupada por compra).
      raw.installment = r.meta.location ? r.meta.installmentRef ?? null : detectInstallment(r.description);
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
    } else if (scopeAccount) {
      // Aplicação/resgate de investimento ou transferência entre contas próprias: não é receita nem despesa.
      const move = resolveOwnMove(r.description, amount, scopeAccount, ownAccounts, transferRules);
      if (move) {
        raw.originalKind = raw.kind;
        raw.kind = "TRANSFER";
        raw.transferAccountId = move.counterpartId;
        raw.transferReason = move.kind;
      }
    }

    if (raw.kind !== "CARD_PAYMENT") {
      raw.suggestedPaymentMethod = r.meta.paymentMethod ?? (scope.accountId ? suggestPaymentMethod(r.description, r.meta.trnType, outflow) : null);
      if (raw.kind !== "TRANSFER") {
        // Migração: a categoria escolhida nas correspondências (ou nenhuma) vale sobre o nome.
        if (r.meta.categoryId !== undefined) row.categoryId = r.meta.categoryId;
        else if (r.categoryName) row.categoryId = catByName.get(`${outflow ? "EXPENSE" : "INCOME"}|${normalizeText(r.categoryName)}`) ?? null;
      }
    }
    return row;
  });

  if (repeatedIds) opts.warnings.push("O arquivo contém identificadores repetidos; a detecção de duplicidade também considera data, valor e descrição.");
  if (cardPaymentSkipped) opts.warnings.push(`${cardPaymentSkipped} linha(s) de pagamento/crédito da fatura foram ignoradas (não são compras).`);
  return { rows, cardPurchasesPositive };
}

function installmentPlanMessage(plan: NonNullable<RowRawData["installmentPlan"]>): string {
  const per = formatBRL(Math.round(plan.amountCents / plan.count));
  return plan.firstNumber > 1
    ? `Compra parcelada: parcelas ${plan.firstNumber} a ${plan.ofTotal} de ${plan.ofTotal} (${plan.count} × ${per}). As parcelas futuras entram nas próximas faturas.`
    : `Compra parcelada em ${plan.count}× de ${per} (total ${formatBRL(plan.amountCents)}). As parcelas futuras entram nas próximas faturas.`;
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
    select: { externalId: true, fingerprint: true, amountCents: true, batch: { select: { fileName: true, importedAt: true, createdAt: true } } },
  });
  const byExternal = new Map(previous.filter((p) => p.externalId).map((p) => [p.externalId!, p]));
  const byFingerprint = new Map(previous.filter((p) => p.fingerprint).map((p) => [p.fingerprint!, p]));
  for (const r of pending) {
    const sameId = r.externalId ? byExternal.get(r.externalId) : undefined;
    // Mesmo identificador só conta como duplicado com o mesmo valor (protege contra FITIDs reaproveitados).
    const prev = (sameId && sameId.amountCents === r.amountCents ? sameId : undefined) || (r.fingerprint ? byFingerprint.get(r.fingerprint) : undefined);
    if (!prev) continue;
    const when = prev.batch.importedAt ?? prev.batch.createdAt;
    r.status = "DUPLICATE";
    r.selected = false;
    r.message = `Já importado em ${formatDateBR(instantToISO(when, ctx.timezone))} (arquivo "${prev.batch.fileName.slice(0, 60)}").`;
  }

  // Totais mensais (matriz da planilha): não correspondem a lançamentos individuais do app.
  for (const r of pending) {
    if (r.status === null && r.raw.consolidated) {
      r.status = "NEW";
      r.message = "Total do mês por categoria (importado de planilha): não altera saldos.";
    }
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
        } else if (r.raw.installmentPlan) {
          r.message = installmentPlanMessage(r.raw.installmentPlan);
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

  for (const r of open) if (r.status === null && r.raw.installmentPlan && !r.message) r.message = installmentPlanMessage(r.raw.installmentPlan);

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
      destinationAmountCents: true,
      creditCardId: true,
      paymentMethod: true,
      merchant: { select: { name: true } },
    },
    take: 20_000,
  });
  const candidates: Candidate[] = txs.map((t) => ({
    id: t.id,
    type: t.type,
    // Transferência entre moedas: do lado da conta do extrato, o valor é o creditado no destino.
    amountCents: t.type === "TRANSFER" && t.destinationAmountCents !== null && t.destinationAccountId === scope.accountId ? t.destinationAmountCents : t.amountCents,
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

export async function storeImportFile(ctx: ServiceContext, content: Buffer, fileName: string, sha: string, mimeType: string): Promise<string> {
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
  opts: {
    mapping?: ColumnMapping | null;
    headerRowIndex?: number | null;
    invertSigns: boolean;
    excludeBatchId?: string;
    /** Arquivo já lido (PDF: evita ler/chamar a IA duas vezes). */
    parsed?: ParseResult;
    fileName?: string;
    pdfAi?: ImportBatchMeta["pdfAi"];
    defaultNature?: ImportBatchMeta["defaultNature"];
    /** Limite de linhas (a migração de planilha aceita mais que a importação comum). */
    maxRows?: number;
  },
) {
  const parsed = opts.parsed ?? (await parseImportFile(format, content, { ...opts, householdId: ctx.householdId, timezone: ctx.timezone }));
  if (parsed.ofxKind === "CREDIT_CARD" && scope.accountId) throw new ValidationError("Este OFX é de cartão de crédito. Selecione o cartão correspondente em vez de uma conta.");
  if (parsed.ofxKind === "BANK" && scope.creditCardId) throw new ValidationError("Este OFX é de conta bancária. Selecione a conta correspondente em vez de um cartão.");
  if (!parsed.rows.length) throw new ValidationError("Nenhum lançamento foi encontrado no arquivo.");
  const maxRows = opts.maxRows ?? IMPORT_MAX_ROWS;
  if (parsed.rows.length > maxRows) throw new ValidationError(`O arquivo tem mais de ${maxRows.toLocaleString("pt-BR")} linhas. Divida o arquivo em partes.`);
  const warnings = [...parsed.meta.warnings];
  if (!scope.accountId && !scope.creditCardId) {
    warnings.push("Nenhuma conta ou cartão foi escolhido: os lançamentos não alterarão saldos e ficarão pendentes de forma de pagamento.");
  }
  // PDF: o tipo vem de heurística. Se não bate com o destino escolhido, avisa e não deixa nada
  // selecionado (valor de fatura não pode virar movimentação da conta por engano).
  const pdfMismatch =
    parsed.pdf?.kind === "CREDIT_CARD" && scope.accountId
      ? "Este PDF parece uma FATURA DE CARTÃO, mas foi escolhida uma conta bancária. Refaça a prévia escolhendo o cartão. Se for mesmo o extrato da conta, selecione as linhas e confira os sinais (entrada/saída) antes de importar."
      : parsed.pdf?.kind === "BANK" && scope.creditCardId
        ? "Este PDF parece um EXTRATO DE CONTA, mas foi escolhido um cartão. Refaça a prévia escolhendo a conta. Se for mesmo a fatura do cartão, selecione as linhas antes de importar."
        : null;
  const prepared = await prepareRows(ctx, scope, parsed.rows, { invertSigns: opts.invertSigns, warnings });
  const rows = await classifyRows(ctx, scope, prepared.rows, opts.excludeBatchId);
  await annotateTransfers(ctx, rows, warnings, scope.accountId);
  await annotateNature(ctx, rows, scope, warnings, opts.defaultNature ?? null);
  await annotateSkipRules(ctx, rows, scope, warnings);
  if (pdfMismatch) {
    warnings.unshift(pdfMismatch);
    for (const r of rows) r.selected = false;
  }
  const meta: ImportBatchMeta = {
    ...emptyMeta(),
    ...parsed.meta,
    warnings,
    invertSigns: opts.invertSigns,
    cardPurchasesPositive: prepared.cardPurchasesPositive,
    scopeMismatch: Boolean(pdfMismatch),
  };
  return { rows, meta };
}

// -----------------------------------------------------------------------------
// Prévia
// -----------------------------------------------------------------------------

/** Aviso quando outra prévia ainda não confirmada (mesma conta/cartão) tem as mesmas linhas. */
async function overlappingPreviews(ctx: ServiceContext, scope: ImportScope, rows: PreparedRow[]): Promise<string | null> {
  const fingerprints = [...new Set(rows.filter((r) => r.selected && r.fingerprint).map((r) => r.fingerprint!))];
  if (!fingerprints.length) return null;
  const overlap = await prisma.importRow.findMany({
    where: {
      householdId: ctx.householdId,
      fingerprint: { in: fingerprints },
      batch: { status: "PREVIEW", accountId: scope.accountId, creditCardId: scope.creditCardId, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } },
    },
    select: { fingerprint: true, batch: { select: { fileName: true } } },
    distinct: ["fingerprint"],
  });
  if (!overlap.length) return null;
  const names = [...new Set(overlap.map((o) => `"${o.batch.fileName.slice(0, 60)}"`))].slice(0, 3).join(", ");
  return `${overlap.length} lançamento(s) também aparecem em ${names} (prévia ainda não confirmada). Se você confirmar os dois arquivos, eles entram uma única vez.`;
}

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
export async function createImportPreviewFromBuffer(
  ctx: ServiceContext,
  input: { fileName: string; content: Buffer; messageId?: string | null; origin?: ImportBatchMeta["origin"]; defaultNature?: ImportBatchMeta["defaultNature"] } & ImportPreviewFileOptions,
) {
  assertCan(ctx, "data:import");
  const opts = importPreviewFileSchema.parse(input);
  const fileName = input.fileName.trim().slice(0, 200) || "extrato";
  const content = input.content;
  if (!content.length) throw new ValidationError("O arquivo está vazio.");
  if (content.length > IMPORT_MAX_BYTES) throw new ValidationError(`O arquivo excede o limite de ${IMPORT_MAX_MB} MB.`);
  let scope = await resolveScope(ctx, opts.accountId, opts.creditCardId);
  const format = opts.format ?? detectImportFormat(fileName, content);
  let parsed: ParseResult | undefined;
  let autoScope: string | null = null;
  if (format === "PDF") {
    parsed = await parseImportFile("PDF", content, { householdId: ctx.householdId, timezone: ctx.timezone, fileName, messageId: input.messageId });
    // Sem destino escolhido: usa a conta/cartão do banco identificado no PDF, quando há só uma opção.
    if (!scope.accountId && !scope.creditCardId && parsed.pdf?.bankConfident) {
      const suggestion = await suggestPdfScope(ctx, parsed.pdf.kind, parsed.pdf.bank);
      if (suggestion) {
        scope = await resolveScope(ctx, suggestion.accountId, suggestion.creditCardId);
        autoScope = `${suggestion.creditCardId ? "Cartão" : "Conta"} escolhid${suggestion.creditCardId ? "o" : "a"} automaticamente pelo banco do PDF (${parsed.pdf.bank}): ${scope.label}. Se não for ${suggestion.creditCardId ? "este" : "esta"}, envie de novo escolhendo o destino.`;
      }
    }
  }
  const { rows, meta } = await buildRows(ctx, scope, format, content, {
    mapping: opts.mapping ?? null,
    headerRowIndex: opts.headerRowIndex ?? null,
    invertSigns: opts.invertSigns,
    parsed,
    fileName,
    defaultNature: input.defaultNature ?? null,
  });
  if (autoScope) meta.warnings.unshift(autoScope);
  meta.origin = input.origin ?? null;
  meta.defaultNature = input.defaultNature ?? null;
  const overlap = await overlappingPreviews(ctx, scope, rows);
  if (overlap) meta.warnings.push(overlap);

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

/**
 * Prévia de um destino (conta, cartão, sem destino ou totais mensais) da migração de planilha: as
 * linhas já chegam lidas e com as correspondências resolvidas; a classificação (duplicados, já
 * registrados, transferências, regras, natureza) é a mesma da importação comum.
 */
export async function createMigrationBatch(
  ctx: ServiceContext,
  input: {
    migrationId: string;
    fileName: string;
    format: "XLSX" | "XLS" | "ODS" | "CSV";
    sha256: string;
    storageKey: string | null;
    accountId: string | null;
    creditCardId: string | null;
    rows: ParsedImportRow[];
    consolidated?: boolean;
    maxRows: number;
  },
): Promise<string | null> {
  assertCan(ctx, "data:import");
  if (!input.rows.length) return null;
  const scope = await resolveScope(ctx, input.accountId, input.creditCardId);
  const parsed: ParseResult = {
    rows: input.rows.map((r, i) => ({ ...r, rowIndex: i })),
    ofxKind: null,
    pdf: null,
    meta: { mapping: null, headers: [], headerRowIndex: null, delimiter: null, sheetName: null, statement: null, warnings: [], pdfAi: null },
  };
  const { rows, meta } = await buildRows(ctx, scope, "CSV", Buffer.alloc(0), { parsed, invertSigns: false, fileName: input.fileName, maxRows: input.maxRows });
  if (input.consolidated) {
    meta.warnings = meta.warnings.filter((w) => !w.startsWith("Nenhuma conta ou cartão"));
    meta.warnings.unshift("Totais mensais por categoria da planilha: entram como lançamentos consolidados, sem conta ou cartão (não alteram saldos).");
  }
  const overlap = await overlappingPreviews(ctx, scope, rows);
  if (overlap) meta.warnings.push(overlap);
  const previous = await prisma.importBatch.findFirst({
    where: { householdId: ctx.householdId, fileSha256: input.sha256, status: "IMPORTED", accountId: scope.accountId, creditCardId: scope.creditCardId },
    orderBy: { createdAt: "desc" },
  });
  if (previous) {
    meta.warnings.unshift(`Esta planilha já foi importada ${scope.creditCardId ? "neste cartão" : scope.accountId ? "nesta conta" : "antes"} em ${formatDateBR(instantToISO(previous.importedAt ?? previous.createdAt, ctx.timezone))}. As linhas repetidas foram marcadas como duplicadas.`);
  }
  meta.storageKey = input.storageKey;
  const label = scope.label ?? (input.consolidated ? "totais mensais" : "sem conta");
  const batch = await withTransaction(async (db) => {
    const created = await db.importBatch.create({
      data: {
        householdId: ctx.householdId,
        format: input.format,
        fileName: `${input.fileName.slice(0, 150)} — ${label}`.slice(0, 200),
        fileSha256: input.sha256,
        accountId: scope.accountId,
        creditCardId: scope.creditCardId,
        status: "PREVIEW",
        mapping: toJson(meta),
        createdById: ctx.memberId,
        migrationId: input.migrationId,
      },
    });
    for (let i = 0; i < rows.length; i += 2000) {
      await db.importRow.createMany({ data: rows.slice(i, i + 2000).map((r) => rowCreateData(ctx.householdId, created.id, r)) });
    }
    await refreshCounters(db, created.id);
    return created;
  }, { timeout: 120_000 });
  logger.info({ householdId: ctx.householdId, batchId: batch.id, migrationId: input.migrationId, rows: rows.length }, "imports: prévia da migração criada");
  return batch.id;
}

/** Marca linhas de uma prévia da migração como duplicadas (ex.: a mesma transferência vista pelas duas contas). */
export async function markMigrationRowsDuplicate(batchId: string, marks: Array<{ rowId: string; message: string }>) {
  if (!marks.length) return;
  await withTransaction(async (db) => {
    for (const m of marks) {
      await db.importRow.updateMany({ where: { id: m.rowId, batchId, status: "NEW", createdTransactionId: null }, data: { status: "DUPLICATE", selected: false, message: m.message.slice(0, 500) } });
    }
    await refreshCounters(db, batchId);
  });
}

/** Descarta uma prévia (lote ainda não importado) da migração de planilha. */
export async function discardMigrationBatch(ctx: ServiceContext, batchId: string) {
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") return false;
  await prisma.importBatch.deleteMany({ where: { id: batchId, status: "PREVIEW", importedAt: null } });
  return true;
}

const rowInclude = {
  matchedTransaction: { select: { id: true, description: true, amountCents: true, date: true, type: true, status: true, source: true, deletedAt: true } },
} satisfies Prisma.ImportRowInclude;

type RowWithMatch = Prisma.ImportRowGetPayload<{ include: typeof rowInclude }>;

const INTERNATIONAL = /\b(iof|usd|eur|gbp|internacional|international|exterior|intl)\b|us\$|u\$s|€/i;

function rowFlags(description: string, raw: RowRawData) {
  // Colunas de valor em moeda estrangeira contam só quando têm valor.
  const cells = Object.entries(raw.cells ?? {})
    .filter(([, v]) => v && !/^[\s0.,-]*$/.test(v))
    .map(([k, v]) => `${k} ${v}`)
    .join(" ");
  return { installment: Boolean(raw.installment || raw.installmentPlan), international: INTERNATIONAL.test(`${description} ${cells}`) };
}

function merchantLabel(description: string): string {
  const star = description.indexOf("*");
  if (star >= 3) return description.slice(0, star).trim().slice(0, 40);
  const words = description.replace(/[0-9/.,:-]+/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  return (words.slice(0, 2).join(" ") || description).slice(0, 40);
}

function wholePurchase(amountCents: number | null, raw: RowRawData): { installments: number; totalCents: number } | null {
  if (raw.kind !== "EXPENSE" || amountCents === null) return null;
  if (raw.installmentPlan) return { installments: raw.installmentPlan.ofTotal, totalCents: raw.installmentPlan.amountCents };
  if (raw.installment && raw.installment.total > 1) return { installments: raw.installment.total, totalCents: Math.abs(amountCents) * raw.installment.total };
  return null;
}

/** Linha da conferência: compra (saída) nova, ainda não importada. */
function reviewable(r: { status: ImportRowStatus; amountCents: number | null }, raw: RowRawData) {
  return raw.kind === "EXPENSE" && r.status === "NEW" && (r.amountCents ?? 0) < 0;
}

/** Importar ou não; "DEFAULT" = como veio da prévia (ex.: parcela de compra antiga já vem desmarcada). */
function rowReview(r: { status: ImportRowStatus; selected: boolean; amountCents: number | null }, raw: RowRawData) {
  if (!reviewable(r, raw)) return null;
  const decision: ReviewDecision = r.selected ? "IMPORT" : "SKIP";
  const source = raw.skipRuleId && !r.selected ? ("RULE" as const) : raw.review === "SKIP" && !r.selected ? ("MANUAL" as const) : ("DEFAULT" as const);
  return { decision, source, skipRuleId: source === "RULE" ? raw.skipRuleId! : null };
}

function rowDTO(r: RowWithMatch, accounts: Map<string, { name: string; currency: string }> = new Map(), scopeCurrency = "BRL") {
  const raw = readRaw(r.rawData);
  const other = raw.transferAccountId ? accounts.get(raw.transferAccountId) : undefined;
  const crossCurrency = Boolean(other && other.currency !== scopeCurrency);
  return {
    id: r.id,
    /** Transferência entre contas próprias (aplicação/resgate): a conta do outro lado e o sentido. */
    transfer:
      raw.kind === "TRANSFER"
        ? {
            accountId: raw.transferAccountId ?? null,
            accountName: other?.name ?? null,
            accountCurrency: other?.currency ?? null,
            direction: (r.amountCents ?? 0) < 0 ? ("OUT" as const) : ("IN" as const),
            reason: raw.transferReason ?? null,
            /** Moedas diferentes: valor do outro lado (na moeda da outra conta), informado pela pessoa. */
            counterpartAmountCents: crossCurrency ? raw.counterpartAmountCents ?? null : null,
            needsCounterpartAmount: crossCurrency && !raw.counterpartAmountCents,
          }
        : null,
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
    /** Receitas/despesas: natureza que vai valer (escolhida, sugerida por regra ou Pessoal). */
    nature:
      raw.kind === "EXPENSE" || raw.kind === "INCOME"
        ? {
            value: (raw.nature ?? raw.natureSuggested ?? "PERSONAL") as Nature,
            source: raw.nature ? ("MANUAL" as const) : raw.natureSuggested ? (raw.natureFromGroup ? ("GROUP" as const) : ("RULE" as const)) : ("DEFAULT" as const),
            ask: Boolean(raw.natureAsk && !raw.nature),
          }
        : null,
    categoryName: raw.categoryName ?? null,
    installment: raw.installment ?? null,
    /** Migração de planilha: compra parcelada a criar, aba/linha de origem e total mensal consolidado. */
    installmentPlan: raw.installmentPlan ?? null,
    location: raw.location ?? null,
    consolidated: Boolean(raw.consolidated),
    /** Confirmar fatura: importar ou não (null = linha que não é compra nova). */
    review: rowReview(r, raw),
    flags: rowFlags(r.description ?? "", raw),
    /** Estabelecimento (filtro): o que vem antes do "*" ou o começo da descrição. */
    merchantLabel: merchantLabel(r.description ?? ""),
    /** Compra parcelada: a escolha vale para a compra inteira (todas as parcelas). */
    wholePurchase: wholePurchase(r.amountCents, raw),
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
    /** PDF cujo tipo não bate com o destino: nenhuma linha vem selecionada. */
    scopeMismatch: meta.scopeMismatch ?? false,
    duplicatesAtCommit: meta.duplicatesAtCommit ?? 0,
    origin: meta.origin?.channel ?? null,
    migrationId: b.migrationId,
  };
}

export async function getImportPreview(ctx: ServiceContext, batchId: string) {
  await loadBatch(ctx, batchId);
  const batch = await prisma.importBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: { account: { select: { id: true, name: true, institution: true, currency: true } }, creditCard: { select: { id: true, name: true } } },
  });
  const rows = await prisma.importRow.findMany({ where: { batchId }, orderBy: { rowIndex: "asc" }, include: rowInclude });
  const meta = readMeta(batch.mapping);
  const transferIds = [...new Set(rows.map((r) => readRaw(r.rawData).transferAccountId).filter(Boolean) as string[])];
  const transferAccounts = new Map(
    (transferIds.length
      ? await prisma.account.findMany({ where: { id: { in: transferIds }, householdId: ctx.householdId }, select: { id: true, name: true, currency: true } })
      : []
    ).map((a) => [a.id, { name: a.name, currency: a.currency }]),
  );
  const counts: Record<ImportRowStatus, number> = { NEW: 0, DUPLICATE: 0, MATCHED: 0, DIVERGENT: 0, SKIPPED: 0, IMPORTED: 0, ERROR: 0 };
  let selected = 0;
  let selectedNewCents = 0;
  for (const r of rows) {
    counts[r.status]++;
    if (r.selected && r.status === "NEW") {
      selected++;
      // Transferências (aplicação/resgate) não são receita nem despesa: ficam fora do líquido.
      if (readRaw(r.rawData).kind !== "TRANSFER") selectedNewCents += r.amountCents ?? 0;
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
    /** Confirmar fatura: totais (arquivo × app) e sugestões de regra "não importar". */
    review: { ...reviewSummary(rows, Boolean(batch.creditCardId)), suggestions: batch.status === "PREVIEW" ? await ruleSuggestions(ctx, batch, rows) : [] },
    rows: rows.map((r) => rowDTO(r, transferAccounts, batch.account?.currency ?? "BRL")),
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
        // Confirmar fatura: desmarcar = "não importar" escolhido pela pessoa; marcar desfaz (inclusive a regra).
        const raw = readRaw(row.rawData);
        if (reviewable(row, raw)) data.rawData = toJson(applyDecision(raw, u.selected ? "IMPORT" : "SKIP").raw);
      }
      if (u.categoryId !== undefined) {
        if (u.categoryId) {
          const kind = catKind.get(u.categoryId);
          if (!kind) throw new ValidationError("Categoria inválida.", { rowId: row.id });
          const raw = readRaw(row.rawData);
          if (raw.kind === "CARD_PAYMENT") throw new ValidationError("Pagamento de fatura não recebe categoria.", { rowId: row.id });
          if (raw.kind === "TRANSFER") throw new ValidationError("Transferência entre contas não recebe categoria. Volte a linha para receita/despesa se ela não for transferência.", { rowId: row.id });
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

export const importRowsTransferSchema = z.object({
  rowIds: z.array(idSchema).min(1).max(IMPORT_MAX_ROWS),
  /** Conta do outro lado; null desfaz (a linha volta a ser receita/despesa). */
  transferAccountId: idSchema.nullable(),
  /** Aplica também às linhas parecidas do arquivo (mesma descrição sem números, mesmo sentido). */
  applyToSimilar: z.boolean().default(false),
  /** Cria uma regra: próximas importações (e o WhatsApp) já tratam essas linhas como transferência. */
  remember: z.boolean().default(false),
  /** Conta em outra moeda: valor do outro lado (só para uma linha por vez). */
  counterpartAmountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS).nullish(),
});
export type ImportRowsTransfer = z.input<typeof importRowsTransferSchema>;

/** Marca linhas da prévia como transferência entre contas próprias (ou desfaz). */
export async function setImportRowsTransfer(ctx: ServiceContext, batchId: string, rawInput: ImportRowsTransfer) {
  assertCan(ctx, "data:import");
  const input = importRowsTransferSchema.parse(rawInput);
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação já foi concluída e não pode mais ser alterada.");
  if (!batch.accountId) throw new ValidationError("Transferência só vale para extrato de conta: escolha a conta da importação (faturas de cartão não têm transferências).");
  let accountName: string | null = null;
  let otherCurrency = "BRL";
  if (input.transferAccountId) {
    if (input.transferAccountId === batch.accountId) throw new ValidationError("Escolha uma conta diferente da conta do extrato.", { field: "transferAccountId" });
    const acc = await prisma.account.findFirst({ where: { id: input.transferAccountId, ...visibleAccountWhere(ctx), archivedAt: null }, select: { name: true, currency: true } });
    if (!acc) throw new ValidationError("Conta inválida.", { field: "transferAccountId" });
    accountName = acc.name;
    otherCurrency = acc.currency;
  }
  const ownCurrency = (await prisma.account.findUnique({ where: { id: batch.accountId }, select: { currency: true } }))?.currency ?? "BRL";
  if (input.counterpartAmountCents && (input.rowIds.length !== 1 || input.applyToSimilar)) {
    throw new ValidationError("O valor na outra moeda é informado linha a linha.", { field: "counterpartAmountCents" });
  }
  const chosen = await prisma.importRow.findMany({ where: { batchId, id: { in: input.rowIds } } });
  if (chosen.length !== new Set(input.rowIds).size) throw new NotFoundError("Linha da importação");
  let rows = chosen;
  if (input.applyToSimilar) {
    const keys = new Set(chosen.map((r) => `${similarityKey(r.description)}|${Math.sign(r.amountCents ?? 0)}`));
    const others = await prisma.importRow.findMany({ where: { batchId, id: { notIn: input.rowIds }, status: { in: ["NEW", "MATCHED"] } } });
    rows = [...chosen, ...others.filter((r) => similarityKey(r.description) && keys.has(`${similarityKey(r.description)}|${Math.sign(r.amountCents ?? 0)}`))];
  }
  const eligible = rows.filter((r) => (r.status === "NEW" || r.status === "MATCHED") && r.amountCents && readRaw(r.rawData).kind !== "CARD_PAYMENT");
  if (!eligible.length) throw new ValidationError("Nenhuma das linhas pode virar transferência (só lançamentos novos ou já registrados, fora pagamentos de fatura).");

  await withTransaction(async (db) => {
    for (const r of eligible) {
      const raw = readRaw(r.rawData);
      const outflow = (r.amountCents ?? 0) < 0;
      if (input.transferAccountId) {
        const next: RowRawData = {
          ...raw,
          originalKind: raw.kind === "TRANSFER" ? raw.originalKind ?? (outflow ? "EXPENSE" : "INCOME") : raw.kind,
          kind: "TRANSFER",
          transferAccountId: input.transferAccountId,
          transferReason: "MANUAL",
          counterpartAmountCents: input.counterpartAmountCents ?? (raw.transferAccountId === input.transferAccountId ? raw.counterpartAmountCents ?? null : null),
        };
        const needsAmount = otherCurrency !== ownCurrency && !next.counterpartAmountCents;
        const message = needsAmount
          ? await crossCurrencyMessage({ ...(r as unknown as PreparedRow), date: r.date ? dateToISO(r.date) : null, raw: next }, accountName!, ownCurrency, otherCurrency)
          : transferMessage(next, r.amountCents!, accountName!);
        await db.importRow.update({
          where: { id: r.id },
          data: {
            rawData: toJson(next),
            categoryId: null,
            ...(r.status === "NEW" ? { selected: !needsAmount, message } : {}),
          },
        });
      } else if (raw.kind === "TRANSFER") {
        const next: RowRawData = { ...raw, kind: raw.originalKind && raw.originalKind !== "TRANSFER" ? raw.originalKind : outflow ? "EXPENSE" : "INCOME", transferAccountId: null, transferReason: null, originalKind: null, counterpartAmountCents: null };
        await db.importRow.update({ where: { id: r.id }, data: { rawData: toJson(next), ...(r.status === "NEW" ? { message: null } : {}) } });
      }
    }
    await refreshCounters(db, batchId);
    // Atualiza o aviso de linhas sem a conta do outro lado.
    const all = await db.importRow.findMany({ where: { batchId, status: "NEW" }, select: { rawData: true } });
    const unresolved = all.filter((r) => {
      const raw = readRaw(r.rawData);
      return raw.kind === "TRANSFER" && !raw.transferAccountId;
    }).length;
    const meta = readMeta(batch.mapping);
    const kept = meta.warnings.filter((w) => !/linha\(s\) parecem aplica[cç][aã]o\/resgate/.test(w));
    if (unresolved) kept.push(`${unresolved} linha(s) parecem aplicação/resgate ou transferência entre contas próprias, mas não deu para saber qual conta é a do outro lado. Escolha a conta nessas linhas para importá-las como transferência.`);
    if (kept.length !== meta.warnings.length || kept.some((w, i) => w !== meta.warnings[i])) await db.importBatch.update({ where: { id: batchId }, data: { mapping: toJson({ ...meta, warnings: kept }) } });
  });

  let ruleCreated = false;
  if (input.remember && input.transferAccountId) {
    const patterns = [...new Set(eligible.map((r) => similarityKey(r.description)).filter(Boolean) as string[])].slice(0, 5);
    for (const pattern of patterns) {
      const exists = await prisma.financialRule.findFirst({ where: { householdId: ctx.householdId, pattern, setTransferAccountId: input.transferAccountId } });
      if (exists) continue;
      await createRule(ctx, { name: `Transferência: ${pattern}`.slice(0, 80), matchField: "DESCRIPTION", matchType: "CONTAINS", pattern, setTransferAccountId: input.transferAccountId, priority: 150 });
      ruleCreated = true;
    }
  }
  await publishEvent(ctx.householdId, "import.changed", batchId);
  return { ...(await getImportPreview(ctx, batchId)), updatedRows: eligible.length, ruleCreated };
}

/** Reprocessa a prévia com outro mapeamento de colunas (ou inversão de sinais). */
export async function previewMapping(ctx: ServiceContext, batchId: string, rawInput: ImportMappingUpdate) {
  assertCan(ctx, "data:import");
  const input = importMappingUpdateSchema.parse(rawInput);
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação já foi concluída e não pode mais ser alterada.");
  const meta = readMeta(batch.mapping);
  // Lotes da migração de planilha vêm de várias abas: colunas e abas se ajustam no assistente.
  if (batch.migrationId || batch.format === "XLS" || batch.format === "ODS") throw new ValidationError("Ajuste as colunas e as abas pelo assistente \"Migrar de planilha\".");
  const format: ImportFileFormat = batch.format;
  if ((format === "OFX" || format === "PDF") && input.mapping) throw new ValidationError(`Arquivos ${format} não usam mapeamento de colunas.`);
  if (!meta.storageKey || !(await storedFileExists(meta.storageKey))) throw new ValidationError("O arquivo original não está mais disponível. Envie o arquivo novamente.");
  const content = await readStoredFile(meta.storageKey);
  const scope = await resolveScope(ctx, batch.accountId, batch.creditCardId);
  const { rows, meta: newMeta } = await buildRows(ctx, scope, format, content, {
    // Nova linha de cabeçalho sem mapeamento explícito → detecta as colunas novamente.
    mapping: input.mapping ?? (input.headerRowIndex !== undefined && input.headerRowIndex !== null ? null : meta.mapping),
    headerRowIndex: input.headerRowIndex ?? meta.headerRowIndex,
    invertSigns: input.invertSigns ?? meta.invertSigns,
    excludeBatchId: batchId,
    fileName: batch.fileName,
    pdfAi: meta.pdfAi ?? null,
    defaultNature: meta.defaultNature ?? null,
  });
  newMeta.storageKey = meta.storageKey;
  newMeta.origin = meta.origin ?? null;
  newMeta.defaultNature = meta.defaultNature ?? null;
  const kept = meta.warnings.filter((w) => w.startsWith("Este arquivo já foi importado") || /escolhid[oa] automaticamente pelo banco do PDF/.test(w));
  if (kept.length) newMeta.warnings.unshift(...kept);
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

/**
 * Revalida duplicidade no momento da confirmação: outros arquivos da mesma conta/cartão podem ter
 * sido confirmados depois desta prévia (importação em massa, extratos com períodos sobrepostos, o
 * mesmo extrato em PDF e em OFX). Linhas já importadas por eles são desmarcadas como duplicadas.
 */
async function markDuplicatesAtCommit(ctx: ServiceContext, batch: { id: string; createdAt: Date }, scope: ImportScope): Promise<number> {
  const rows = await prisma.importRow.findMany({
    where: { batchId: batch.id, selected: true, status: "NEW", createdTransactionId: null },
    select: { id: true, externalId: true, fingerprint: true, amountCents: true, date: true, rawData: true },
    orderBy: { rowIndex: "asc" },
  });
  if (!rows.length) return 0;
  const marks = new Map<string, string>();

  // 1) Mesma linha (FITID ou impressão digital) em lotes já confirmados.
  const externalIds = [...new Set(rows.map((r) => r.externalId).filter(Boolean) as string[])];
  const fingerprints = [...new Set(rows.map((r) => r.fingerprint).filter(Boolean) as string[])];
  if (externalIds.length || fingerprints.length) {
    const previous = await prisma.importRow.findMany({
      where: {
        householdId: ctx.householdId,
        batchId: { not: batch.id },
        batch: { status: "IMPORTED", accountId: scope.accountId, creditCardId: scope.creditCardId },
        OR: [...(externalIds.length ? [{ externalId: { in: externalIds } }] : []), ...(fingerprints.length ? [{ fingerprint: { in: fingerprints } }] : [])],
      },
      select: { externalId: true, fingerprint: true, amountCents: true, batch: { select: { fileName: true } } },
    });
    const byExternal = new Map(previous.filter((p) => p.externalId).map((p) => [p.externalId!, p]));
    const byFingerprint = new Map(previous.filter((p) => p.fingerprint).map((p) => [p.fingerprint!, p]));
    for (const r of rows) {
      const sameId = r.externalId ? byExternal.get(r.externalId) : undefined;
      const prev = (sameId && sameId.amountCents === r.amountCents ? sameId : undefined) || (r.fingerprint ? byFingerprint.get(r.fingerprint) : undefined);
      if (prev) marks.set(r.id, `Duplicado: já importado pelo arquivo "${prev.batch.fileName.slice(0, 60)}".`);
    }
  }

  // 2) Lançamentos criados por outra importação depois desta prévia (mesmo extrato em outro formato):
  //    mesma conta/cartão, mesma data e mesmo valor; cada lançamento cobre uma linha só.
  const rest = rows.filter((r) => !marks.has(r.id) && r.date && r.amountCents);
  if (rest.length && (scope.accountId || scope.creditCardId)) {
    const dates = rest.map((r) => r.date!.getTime());
    const txs = await prisma.transaction.findMany({
      where: {
        householdId: ctx.householdId,
        deletedAt: null,
        source: "IMPORT",
        importBatchId: { not: batch.id },
        createdAt: { gt: batch.createdAt },
        date: { gte: new Date(Math.min(...dates)), lte: new Date(Math.max(...dates)) },
        ...(scope.creditCardId
          ? { creditCardId: scope.creditCardId, type: "EXPENSE" as const }
          : {
              OR: [
                { accountId: scope.accountId, type: { in: ["EXPENSE", "INCOME", "CARD_PAYMENT"] as Array<"EXPENSE" | "INCOME" | "CARD_PAYMENT"> } },
                { type: "TRANSFER" as const, OR: [{ accountId: scope.accountId }, { destinationAccountId: scope.accountId }] },
              ],
            }),
      },
      select: { id: true, type: true, amountCents: true, destinationAmountCents: true, date: true, destinationAccountId: true, importBatch: { select: { fileName: true } } },
      orderBy: { createdAt: "asc" },
    });
    const used = new Set<string>();
    for (const r of rest) {
      const abs = Math.abs(r.amountCents!);
      const outflow = r.amountCents! < 0;
      const inst = readRaw(r.rawData).installment;
      const hit = txs.find(
        (t) =>
          !used.has(t.id) &&
          t.date.getTime() === r.date!.getTime() &&
          ((t.destinationAmountCents !== null && t.destinationAccountId === scope.accountId ? t.destinationAmountCents : t.amountCents) === abs ||
            (inst && inst.number === 1 && t.amountCents === abs * inst.total)) &&
          (t.type === "TRANSFER" ? (t.destinationAccountId === scope.accountId) === !outflow : outflow ? t.type !== "INCOME" : t.type === "INCOME"),
      );
      if (!hit) continue;
      used.add(hit.id);
      marks.set(r.id, `Duplicado: o mesmo lançamento acabou de ser importado pelo arquivo "${(hit.importBatch?.fileName ?? "outro arquivo").slice(0, 60)}".`);
    }
  }

  if (!marks.size) return 0;
  await withTransaction(async (db) => {
    for (const [id, message] of marks) {
      await db.importRow.updateMany({ where: { id, status: "NEW", createdTransactionId: null }, data: { status: "DUPLICATE", selected: false, message } });
    }
    await refreshCounters(db, batch.id);
  });
  return marks.size;
}

export async function commitImport(ctx: ServiceContext, batchId: string, opts: { onProgress?: (done: number, total: number) => Promise<void> | void } = {}) {
  assertCan(ctx, "data:import");
  assertCan(ctx, "transactions:write");
  const batch = await loadBatch(ctx, batchId);
  if (batch.status === "IMPORTED") return { ...(await getImportPreview(ctx, batchId)), result: { alreadyImported: true, created: 0, matched: 0, divergent: 0, errors: 0, duplicatesAtCommit: 0 } };
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
  const converted: ConvertedTransfer[] = [...(meta.commit?.convertedTransfers ?? [])];
  let duplicatesAtCommit = 0;

  try {
    duplicatesAtCommit = await markDuplicatesAtCommit(ctx, batch, scope);
    const rows = await prisma.importRow.findMany({
      where: { batchId, selected: true, status: { in: ["NEW", "MATCHED", "DIVERGENT"] } },
      orderBy: { rowIndex: "asc" },
      include: rowInclude,
    });
    let done = 0;
    for (const row of rows) {
      if (opts.onProgress && ++done % 25 === 0) await opts.onProgress(done, rows.length);
      const raw = readRaw(row.rawData);
      if (row.status === "NEW") {
        if (row.createdTransactionId || !row.date || !row.amountCents) continue;
        const amount = Math.abs(row.amountCents);
        const outflow = row.amountCents < 0;
        const installment = scope.creditCardId && raw.installment && raw.installment.number === 1 ? raw.installment : null;
        // Compra parcelada: plano da migração (ex.: parcelas 3 a 10) ou a parcela 1/N do extrato.
        const plan = scope.creditCardId ? raw.installmentPlan ?? (installment ? { count: installment.total, amountCents: amount * installment.total } : null) : null;
        if (raw.kind === "TRANSFER" && (!raw.transferAccountId || !scope.accountId)) {
          errors++;
          await prisma.importRow.update({ where: { id: row.id }, data: { status: "ERROR", message: "Transferência sem a conta do outro lado: escolha a conta na prévia." } });
          continue;
        }
        let crossAmounts: { amountCents: number; destinationAmountCents: number } | null = null;
        if (raw.kind === "TRANSFER") {
          const pair = await prisma.account.findMany({ where: { id: { in: [scope.accountId!, raw.transferAccountId!] } }, select: { id: true, currency: true } });
          const own = pair.find((a) => a.id === scope.accountId)?.currency ?? "BRL";
          const other = pair.find((a) => a.id === raw.transferAccountId)?.currency ?? "BRL";
          if (own !== other) {
            if (!raw.counterpartAmountCents) {
              errors++;
              await prisma.importRow.update({ where: { id: row.id }, data: { status: "ERROR", message: `Transferência entre moedas: informe o valor em ${other} na prévia.` } });
              continue;
            }
            // Saída: o extrato tem a origem; entrada: o extrato tem o destino.
            crossAmounts = outflow ? { amountCents: amount, destinationAmountCents: raw.counterpartAmountCents } : { amountCents: raw.counterpartAmountCents, destinationAmountCents: amount };
          }
        }
        const fields =
          raw.kind === "CARD_PAYMENT"
            ? { type: "CARD_PAYMENT" as const, creditCardId: raw.cardPaymentCardId ?? null, accountId: scope.accountId, paymentMethod: raw.suggestedPaymentMethod ?? "BANK_TRANSFER" }
            : raw.kind === "TRANSFER"
              ? {
                  type: "TRANSFER" as const,
                  accountId: outflow ? scope.accountId : raw.transferAccountId!,
                  destinationAccountId: outflow ? raw.transferAccountId! : scope.accountId,
                  paymentMethod: raw.suggestedPaymentMethod && raw.suggestedPaymentMethod !== "DEBIT_CARD" && raw.suggestedPaymentMethod !== "CASH" ? raw.suggestedPaymentMethod : "BANK_TRANSFER",
                }
            : scope.creditCardId
              ? { type: "EXPENSE" as const, creditCardId: scope.creditCardId, installmentCount: plan?.count ?? 1, payerMemberId: raw.payerMemberId ?? scope.cardHolderId ?? undefined }
              : {
                  type: outflow ? ("EXPENSE" as const) : ("INCOME" as const),
                  accountId: scope.accountId,
                  paymentMethod: raw.suggestedPaymentMethod ?? null,
                  payerMemberId: raw.payerMemberId ?? scope.accountOwnerId ?? undefined,
                };
        try {
          const done = await withTransaction(async (db) => {
            // Reserva a linha (bloqueio de registro): execuções concorrentes não criam a transação duas vezes.
            const claimRow = await db.importRow.updateMany({ where: { id: row.id, status: "NEW", createdTransactionId: null }, data: { status: "IMPORTED" } });
            if (!claimRow.count) return false;
            const res = await createTransaction(
              ctx,
              {
                ...fields,
                amountCents: plan ? plan.amountCents : amount,
                ...(crossAmounts ?? {}),
                description: row.description || "Lançamento importado",
                notes: raw.memo && row.description && !row.description.includes(raw.memo) ? raw.memo.slice(0, 500) : null,
                date: dateToISO(row.date!),
                categoryId: raw.kind === "CARD_PAYMENT" || raw.kind === "TRANSFER" ? null : row.categoryId,
                // Subcategoria da planilha só se a categoria não foi trocada na prévia.
                subcategoryId: raw.kind !== "CARD_PAYMENT" && raw.kind !== "TRANSFER" && raw.subcategory && raw.subcategory.categoryId === row.categoryId ? raw.subcategory.id : null,
                // Natureza escolhida na prévia vale sobre as regras; sem escolha, as regras decidem.
                ...(raw.nature && (raw.kind === "EXPENSE" || raw.kind === "INCOME") ? { nature: raw.nature } : {}),
              },
              {
                source: "IMPORT",
                importBatchId: batchId,
                checkDuplicates: false,
                db,
                // PDF do grupo da empresa: sem escolha nem regra, entra como Empresa.
                natureFallback: raw.natureFromGroup && raw.natureSuggested === "BUSINESS" ? { scope: "BUSINESS" } : null,
                // Total mensal da planilha não tem conta/cartão por natureza: sem pendência de forma de pagamento.
                skipPaymentPending: Boolean(raw.consolidated),
              },
            );
            await db.importRow.update({ where: { id: row.id }, data: { createdTransactionId: res.transaction.id } });
            return true;
          });
          if (done) created++;
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
        // Aplicação/resgate já registrado como receita/despesa: vira transferência (sem duplicar).
        if (raw.kind === "TRANSFER" && raw.transferAccountId && scope.accountId && !converted.some((c) => c.rowId === row.id)) {
          const full = await prisma.transaction.findUnique({
            where: { id: tx.id },
            select: { type: true, accountId: true, destinationAccountId: true, creditCardId: true, categoryId: true, subcategoryId: true, paymentMethod: true },
          });
          if (full && (full.type === "EXPENSE" || full.type === "INCOME") && !full.creditCardId && full.accountId !== raw.transferAccountId) {
            const outflow = (row.amountCents ?? 0) < 0;
            try {
              await updateTransaction(
                ctx,
                tx.id,
                outflow
                  ? { type: "TRANSFER", accountId: scope.accountId, destinationAccountId: raw.transferAccountId }
                  : { type: "TRANSFER", accountId: raw.transferAccountId, destinationAccountId: scope.accountId },
                { reason: "Importação: aplicação/resgate convertido em transferência" },
              );
              converted.push({ rowId: row.id, transactionId: tx.id, before: { type: full.type, accountId: full.accountId, destinationAccountId: full.destinationAccountId, categoryId: full.categoryId, subcategoryId: full.subcategoryId, paymentMethod: full.paymentMethod } });
            } catch (err) {
              logger.warn({ householdId: ctx.householdId, batchId, err: errorInfo(err).name }, "imports: conversão em transferência não aplicada");
            }
            continue;
          }
        }
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

    // Regras "não importar" que desmarcaram compras: contam como aplicadas.
    const skipRuleUses = new Map<string, number>();
    for (const r of await prisma.importRow.findMany({ where: { batchId, selected: false, status: "NEW" }, select: { rawData: true } })) {
      const id = readRaw(r.rawData).skipRuleId;
      if (id) skipRuleUses.set(id, (skipRuleUses.get(id) ?? 0) + 1);
    }
    for (const [id, n] of skipRuleUses) await prisma.financialRule.updateMany({ where: { id, householdId: ctx.householdId }, data: { timesApplied: { increment: n } } });

    // Já registrados (conciliados) com natureza escolhida na prévia: aplica no lançamento existente.
    const natureByChoice = new Map<Nature, string[]>();
    for (const row of rows) {
      const raw = readRaw(row.rawData);
      if (row.status !== "MATCHED" || !raw.nature || !row.matchedTransaction || row.matchedTransaction.deletedAt) continue;
      if (raw.kind !== "EXPENSE" && raw.kind !== "INCOME") continue;
      natureByChoice.set(raw.nature, [...(natureByChoice.get(raw.nature) ?? []), row.matchedTransaction.id]);
    }
    for (const [nature, ids] of natureByChoice) {
      await setTransactionNature(ctx, { transactionIds: ids, nature }, { reason: `Importação ${batch.fileName}: natureza escolhida na prévia` }).catch((err) =>
        logger.warn({ householdId: ctx.householdId, batchId, err: errorInfo(err).name }, "imports: natureza não aplicada aos já registrados"),
      );
    }

    meta.commit = { created, matched, divergent, errors, reconciledFills: fills, convertedTransfers: converted };
    meta.duplicatesAtCommit = (meta.duplicatesAtCommit ?? 0) + duplicatesAtCommit;
    await withTransaction(async (db) => {
      await refreshCounters(db, batchId);
      await db.importBatch.update({ where: { id: batchId }, data: { status: "IMPORTED", importedAt: new Date(), mapping: toJson(meta) } });
      await audit(
        ctx,
        {
          action: "IMPORT",
          entityType: "ImportBatch",
          entityId: batchId,
          after: { fileName: batch.fileName, format: batch.format, created, matched, divergent, errors, duplicatesAtCommit },
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

  logger.info({ householdId: ctx.householdId, batchId, created, matched, divergent, errors, duplicatesAtCommit }, "imports: lote importado");
  await publishEvent(ctx.householdId, "import.changed", batchId);
  await publishEvent(ctx.householdId, "transaction.changed");
  await publishEvent(ctx.householdId, "account.changed");
  await publishEvent(ctx.householdId, "pending.changed");
  return { ...(await getImportPreview(ctx, batchId)), result: { alreadyImported: false, created, matched, divergent, errors, duplicatesAtCommit } };
}

export const bulkCommitSchema = z.object({ batchIds: z.array(idSchema).min(1).max(20) });

/**
 * Confirma várias prévias de uma vez ("confirmar todos"), em ordem. Cada arquivo é confirmado
 * isoladamente: um erro não impede os demais. A deduplicação entre os arquivos acontece na
 * confirmação de cada um (linhas já importadas pelos anteriores viram duplicadas).
 */
export async function bulkCommitImports(ctx: ServiceContext, rawInput: z.input<typeof bulkCommitSchema>) {
  assertCan(ctx, "data:import");
  assertCan(ctx, "transactions:write");
  const { batchIds } = bulkCommitSchema.parse(rawInput);
  const unique = [...new Set(batchIds)];
  const results: Array<{
    batchId: string;
    fileName: string;
    ok: boolean;
    alreadyImported: boolean;
    created: number;
    matched: number;
    divergent: number;
    duplicatesAtCommit: number;
    errors: number;
    error?: string;
  }> = [];
  for (const batchId of unique) {
    let fileName = "";
    try {
      const batch = await loadBatch(ctx, batchId);
      fileName = batch.fileName;
      const res = await commitImport(ctx, batchId);
      results.push({ batchId, fileName, ok: true, ...res.result });
    } catch (err) {
      results.push({
        batchId,
        fileName,
        ok: false,
        alreadyImported: false,
        created: 0,
        matched: 0,
        divergent: 0,
        duplicatesAtCommit: 0,
        errors: 0,
        error: err instanceof AppError ? err.message : "Não foi possível confirmar este arquivo.",
      });
      if (!(err instanceof AppError)) logger.warn({ householdId: ctx.householdId, batchId, err: errorInfo(err).name }, "imports: falha na confirmação em massa");
    }
  }
  const sum = (k: "created" | "matched" | "divergent" | "duplicatesAtCommit" | "errors") => results.reduce((s, r) => s + r[k], 0);
  return {
    results,
    totals: { files: results.length, ok: results.filter((r) => r.ok).length, created: sum("created"), matched: sum("matched"), divergent: sum("divergent"), duplicatesAtCommit: sum("duplicatesAtCommit"), errors: sum("errors") },
  };
}

/**
 * Prévias criadas pelo WhatsApp por quem envia, nesta conversa, ainda não confirmadas.
 * `ready`: têm conta/cartão e nenhuma divergência de tipo — podem ser confirmadas pela conversa.
 */
export async function listWhatsAppPreviews(ctx: ServiceContext, chatId: string, sinceMs: number) {
  const batches = await prisma.importBatch.findMany({
    where: {
      ...batchVisibilityWhere(ctx),
      createdById: ctx.memberId,
      status: "PREVIEW",
      createdAt: { gt: new Date(Date.now() - sinceMs) },
      mapping: { path: ["origin", "chatId"], equals: chatId },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, fileName: true, accountId: true, creditCardId: true, mapping: true, newRows: true, matchedRows: true },
  });
  return batches.map((b) => ({
    id: b.id,
    fileName: b.fileName,
    ready: Boolean(b.accountId || b.creditCardId) && !readMeta(b.mapping).scopeMismatch,
  }));
}

/** Prévia já criada para esta mensagem do WhatsApp (reprocessamento não cria outra). */
export async function findBatchByOriginMessage(ctx: ServiceContext, messageId: string) {
  return prisma.importBatch.findFirst({
    where: { householdId: ctx.householdId, mapping: { path: ["origin", "messageId"], equals: messageId } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, fileName: true },
  });
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

  // Reverte as receitas/despesas que a importação converteu em transferência.
  for (const conv of meta.commit?.convertedTransfers ?? []) {
    const tx = await prisma.transaction.findFirst({ where: { id: conv.transactionId, householdId: ctx.householdId }, select: { type: true, deletedAt: true } });
    if (!tx || tx.deletedAt || tx.type !== "TRANSFER") continue;
    try {
      await updateTransaction(ctx, conv.transactionId, { ...conv.before }, { reason: "Importação desfeita" });
    } catch (err) {
      logger.warn({ householdId: ctx.householdId, batchId, err: errorInfo(err).name }, "imports: falha ao reverter conversão em transferência");
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
    include: { account: { select: { id: true, name: true, institution: true } }, creditCard: { select: { id: true, name: true } } },
  });
  return batches.map(batchDTO);
}



// -----------------------------------------------------------------------------
// Natureza na prévia (Pessoal / Empresa / Repasse)
// -----------------------------------------------------------------------------

/** "FACEBK *ABC123" e "FACEBK *XYZ9" são parecidos (o que vem antes do "*"); senão, o começo da descrição. */
function natureSimilarityKey(description: string | null): string | null {
  const star = (description ?? "").indexOf("*");
  if (star >= 3) {
    const prefix = normalizeText(description!.slice(0, star)).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (prefix.length >= 3) return `*${prefix}`;
  }
  return similarityKey(description);
}

export const importRowsNatureSchema = z.object({
  rowIds: z.array(idSchema).min(1).max(5000),
  /** null volta para o que as regras sugerem. */
  nature: z.enum(NATURES).nullable(),
  /** Também as linhas parecidas do mesmo arquivo (mesmo começo de descrição). */
  applyToSimilar: z.boolean().default(false),
});

/** Escolhe a natureza das linhas (vale sobre as regras ao importar; saldo e fatura não mudam). */
export async function setImportRowsNature(ctx: ServiceContext, batchId: string, rawInput: z.input<typeof importRowsNatureSchema>) {
  assertCan(ctx, "data:import");
  const input = importRowsNatureSchema.parse(rawInput);
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação já foi concluída.");
  const all = await prisma.importRow.findMany({ where: { batchId }, select: { id: true, status: true, description: true, rawData: true } });
  const eligible = all.filter((r) => (r.status === "NEW" || r.status === "MATCHED") && ["EXPENSE", "INCOME"].includes(readRaw(r.rawData).kind));
  const chosen = new Set(input.rowIds);
  let targets = eligible.filter((r) => chosen.has(r.id));
  if (!targets.length) throw new ValidationError("Nenhuma das linhas é receita ou despesa (só elas têm natureza).");
  if (input.applyToSimilar) {
    const keys = new Set(targets.map((r) => natureSimilarityKey(r.description)).filter(Boolean) as string[]);
    targets = eligible.filter((r) => chosen.has(r.id) || (keys.size && keys.has(natureSimilarityKey(r.description) ?? "")));
  }
  await withTransaction(async (db) => {
    for (const r of targets) {
      const raw = readRaw(r.rawData);
      await db.importRow.update({ where: { id: r.id }, data: { rawData: toJson({ ...raw, nature: input.nature }) } });
    }
  });
  await publishEvent(ctx.householdId, "import.changed", batchId);
  return { ...(await getImportPreview(ctx, batchId)), updatedRows: targets.length };
}

// -----------------------------------------------------------------------------
// Confirmar fatura: importar ou não cada compra nova antes da importação final
// -----------------------------------------------------------------------------

type ReviewRow = { id: string; status: ImportRowStatus; selected: boolean; amountCents: number | null; description: string | null; rawData: Prisma.JsonValue };

/** Linhas que estão (ou vão estar) no app: novas selecionadas, já registradas, divergentes e repetidas. */
const IN_APP_STATUSES: ImportRowStatus[] = ["NEW", "MATCHED", "DIVERGENT", "DUPLICATE", "IMPORTED"];

/** Conferência do total: compras no arquivo × o que vai entrar no app; o "não importar" vira diferença. */
function reviewSummary(rows: ReviewRow[], isCard: boolean) {
  const decisions = Object.fromEntries(REVIEW_DECISIONS.map((d) => [d, { count: 0, cents: 0 }])) as Record<ReviewDecision, { count: number; cents: number }>;
  let fileTotalCents = 0;
  let appTotalCents = 0;
  let notImportedCount = 0;
  let purchases = 0;
  const ignoredCredits = { count: 0, cents: 0 };
  for (const r of rows) {
    const raw = readRaw(r.rawData);
    const amount = r.amountCents ?? 0;
    // Fatura: pagamentos e créditos não são compras (ficam fora da conferência).
    if (isCard && r.status === "SKIPPED" && amount > 0) {
      ignoredCredits.count++;
      ignoredCredits.cents += amount;
      continue;
    }
    if (raw.kind !== "EXPENSE" || amount >= 0 || !IN_APP_STATUSES.includes(r.status)) continue;
    const abs = -amount;
    fileTotalCents += abs;
    if (r.status === "NEW" && !r.selected) notImportedCount++;
    else appTotalCents += abs;
    const review = rowReview(r, raw);
    if (review) {
      purchases++;
      decisions[review.decision].count++;
      decisions[review.decision].cents += abs;
    }
  }
  const differenceCents = fileTotalCents - appTotalCents;
  return {
    scope: isCard ? ("CARD" as const) : ("ACCOUNT" as const),
    /** Compras novas para conferir. */
    purchases,
    fileTotalCents,
    appTotalCents,
    differenceCents,
    notImportedCount,
    decisions,
    /** Pagamentos e créditos da fatura que não entram (não são compras). */
    ignoredCredits,
    warning: differenceCents
      ? isCard
        ? `A fatura no app vai ficar ${formatBRL(differenceCents)} menor que a do banco. Se você vai pagar a fatura inteira, importe a compra e marque a natureza como Repasse: ela entra na fatura, mas não conta como gasto seu.`
        : `As saídas no app vão ficar ${formatBRL(differenceCents)} menores que as do extrato e o saldo não vai bater com o banco.`
      : null,
  };
}

function pseudoRule(p: { matchType: "STARTS_WITH" | "CONTAINS"; pattern: string; creditCardId: string | null; accountId: string | null }): FinancialRule {
  return {
    id: "suggestion",
    active: true,
    priority: 0,
    createdAt: new Date(0),
    transactionType: "EXPENSE",
    minAmountCents: null,
    maxAmountCents: null,
    matchAccountId: p.accountId,
    matchCreditCardId: p.creditCardId,
    matchField: "DESCRIPTION",
    matchType: p.matchType,
    pattern: p.pattern,
  } as unknown as FinancialRule;
}

export interface ReviewRuleSuggestion {
  key: string;
  matchType: "STARTS_WITH" | "CONTAINS";
  pattern: string;
  /** Como mostrar o padrão ("FACEBK *"). */
  patternLabel: string;
  /** Vezes que a pessoa marcou "não importar" em compras parecidas (este arquivo + importações anteriores do mesmo cartão/conta). */
  timesMarked: number;
  /** Outras compras deste arquivo que a regra também desmarcaria. */
  alsoApplies: number;
  label: string;
}

/**
 * Mesma descrição/estabelecimento marcada "não importar" 2 vezes (neste arquivo ou em faturas
 * anteriores do mesmo cartão/conta): oferece a regra "sempre não importar".
 */
async function ruleSuggestions(
  ctx: ServiceContext,
  batch: { id: string; creditCardId: string | null; accountId: string | null; mapping: Prisma.JsonValue },
  rows: ReviewRow[],
): Promise<ReviewRuleSuggestion[]> {
  type Mark = { key: string; description: string; current: boolean };
  const isMark = (raw: RowRawData, selected: boolean) => raw.review === "SKIP" && !raw.skipRuleId && !selected;
  const marks: Mark[] = [];
  for (const r of rows) {
    const raw = readRaw(r.rawData);
    const key = reviewable(r, raw) && isMark(raw, r.selected) ? natureSimilarityKey(r.description) : null;
    if (key) marks.push({ key, description: r.description ?? "", current: true });
  }
  if (!marks.length) return [];
  const previous = await prisma.importRow.findMany({
    where: {
      householdId: ctx.householdId,
      batchId: { not: batch.id },
      status: "NEW",
      selected: false,
      batch: { status: "IMPORTED", creditCardId: batch.creditCardId, accountId: batch.accountId },
      rawData: { path: ["review"], equals: "SKIP" },
    },
    orderBy: { batch: { createdAt: "desc" } },
    take: 1000,
    select: { description: true, rawData: true },
  });
  for (const p of previous) {
    const key = isMark(readRaw(p.rawData), false) ? natureSimilarityKey(p.description) : null;
    if (key) marks.push({ key, description: p.description ?? "", current: false });
  }

  const dismissed = new Set(readMeta(batch.mapping).reviewDismissed ?? []);
  const groups = new Map<string, Mark[]>();
  for (const m of marks) groups.set(m.key, [...(groups.get(m.key) ?? []), m]);
  const existing = await prisma.financialRule.findMany({ where: { householdId: ctx.householdId, active: true, skipOnImport: true } });
  const subject = (description: string, amountCents: number) => ({ description, merchant: null, amountCents, type: "EXPENSE", accountId: batch.accountId, creditCardId: batch.creditCardId });
  const where = batch.creditCardId ? "neste cartão" : "nesta conta";

  const out: ReviewRuleSuggestion[] = [];
  for (const [key, group] of groups) {
    const current = group.filter((m) => m.current);
    if (group.length < 2 || !current.length || dismissed.has(key)) continue;
    // Padrão: o que vem antes do "*" (começa com), o começo da descrição ou a primeira palavra (contém).
    const first = current[0]!;
    const star = first.description.indexOf("*");
    const plain = key.replace(/^\*/, "");
    const options: Array<{ matchType: "STARTS_WITH" | "CONTAINS"; pattern: string; label: string }> = [];
    if (key.startsWith("*") && star >= 3) options.push({ matchType: "STARTS_WITH", pattern: first.description.slice(0, star).trim(), label: `${first.description.slice(0, star).trim()} *` });
    options.push({ matchType: "CONTAINS", pattern: plain, label: plain.toUpperCase() });
    const firstWord = plain.split(" ")[0] ?? "";
    if (firstWord.length >= 4 && firstWord !== plain) options.push({ matchType: "CONTAINS", pattern: firstWord, label: firstWord.toUpperCase() });
    const option = options.find((o) => group.every((m) => findMatchingRule([pseudoRule({ ...o, creditCardId: batch.creditCardId, accountId: batch.accountId })], subject(m.description, 1))));
    if (!option) continue;
    // Já existe regra "não importar" que pega essas compras: não sugere de novo.
    if (current.every((m) => findMatchingRule(existing, subject(m.description, 1)))) continue;
    const rule = pseudoRule({ ...option, creditCardId: batch.creditCardId, accountId: batch.accountId });
    const alsoApplies = rows.filter((r) => {
      const raw = readRaw(r.rawData);
      return rowReview(r, raw)?.decision === "IMPORT" && findMatchingRule([rule], subject(r.description ?? "", Math.abs(r.amountCents!)));
    }).length;
    out.push({
      key,
      matchType: option.matchType,
      pattern: option.pattern,
      patternLabel: option.label,
      timesMarked: group.length,
      alsoApplies,
      label: `Sempre não importar ${batch.creditCardId ? "compras" : "saídas"} de "${option.label}" ${where}?`,
    });
  }
  return out.slice(0, 5);
}

export const importReviewSchema = z.object({
  rows: z
    .array(z.object({ rowId: idSchema, decision: z.enum(REVIEW_DECISIONS) }))
    .min(1)
    .max(IMPORT_MAX_ROWS),
});
export type ImportReviewInput = z.input<typeof importReviewSchema>;

/** Raw e seleção da linha depois da escolha (escolher de novo desfaz a regra que tinha desmarcado). */
function applyDecision(raw: RowRawData, decision: ReviewDecision): { raw: RowRawData; selected: boolean } {
  return decision === "SKIP" ? { raw: { ...raw, review: "SKIP", skipRuleId: null }, selected: false } : { raw: { ...raw, review: null, skipRuleId: null }, selected: true };
}

/** Confirmar fatura: grava "Importar" ou "Não importar" de cada compra nova. */
export async function reviewImportRows(ctx: ServiceContext, batchId: string, rawInput: ImportReviewInput) {
  assertCan(ctx, "data:import");
  const input = importReviewSchema.parse(rawInput);
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação já foi concluída e não pode mais ser alterada.");
  const rows = await prisma.importRow.findMany({ where: { batchId, id: { in: input.rows.map((u) => u.rowId) } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const u of input.rows) {
    const row = byId.get(u.rowId);
    if (!row) throw new NotFoundError("Linha da importação");
    if (!reviewable(row, readRaw(row.rawData))) throw new ValidationError("Só compras novas (ainda não registradas no app) recebem essa escolha.", { rowId: row.id });
  }
  await withTransaction(async (db) => {
    for (const u of input.rows) {
      const row = byId.get(u.rowId)!;
      const next = applyDecision(readRaw(row.rawData), u.decision);
      await db.importRow.update({ where: { id: row.id }, data: { rawData: toJson(next.raw), selected: next.selected } });
    }
    await refreshCounters(db, batchId);
  });
  await publishEvent(ctx.householdId, "import.changed", batchId);
  return getImportPreview(ctx, batchId);
}

export const reviewRuleSchema = z.object({
  key: z.string().min(1).max(300),
  /** false: não sugerir de novo nesta importação. */
  accept: z.boolean(),
});

/** Aceita (cria a regra "não importar" e desmarca as compras parecidas deste arquivo) ou dispensa a sugestão. */
export async function resolveReviewRule(ctx: ServiceContext, batchId: string, rawInput: z.input<typeof reviewRuleSchema>) {
  assertCan(ctx, "data:import");
  const input = reviewRuleSchema.parse(rawInput);
  const batch = await loadBatch(ctx, batchId);
  if (batch.status !== "PREVIEW") throw new ValidationError("Esta importação já foi concluída.");
  const preview = await getImportPreview(ctx, batchId);
  const suggestion = preview.review.suggestions.find((s) => s.key === input.key);
  if (!suggestion) throw new NotFoundError("Sugestão de regra");
  if (!input.accept) {
    const meta = readMeta(batch.mapping);
    meta.reviewDismissed = [...(meta.reviewDismissed ?? []), input.key].slice(-100);
    await prisma.importBatch.update({ where: { id: batchId }, data: { mapping: toJson(meta) } });
    return { ...(await getImportPreview(ctx, batchId)), rule: null, appliedRows: 0 };
  }
  const scopeName = preview.batch.creditCard?.name ?? preview.batch.account?.name ?? "";
  const rule = await createRule(ctx, {
    name: `Não importar: "${suggestion.patternLabel}"${scopeName ? ` — ${scopeName}` : ""}`.slice(0, 80),
    matchField: "DESCRIPTION",
    matchType: suggestion.matchType,
    pattern: suggestion.pattern,
    transactionType: "EXPENSE",
    matchCreditCardId: batch.creditCardId,
    matchAccountId: batch.accountId,
    skipOnImport: true,
  });
  // Compras parecidas deste arquivo ainda marcadas para importar também ficam de fora.
  const rows = await prisma.importRow.findMany({ where: { batchId, status: "NEW", selected: true } });
  let appliedRows = 0;
  await withTransaction(async (db) => {
    for (const r of rows) {
      const raw = readRaw(r.rawData);
      if (!reviewable(r, raw)) continue;
      const subject = { description: r.description ?? "", merchant: null, amountCents: Math.abs(r.amountCents ?? 0), type: "EXPENSE", accountId: batch.accountId, creditCardId: batch.creditCardId };
      if (!findMatchingRule([rule], subject)) continue;
      await db.importRow.update({ where: { id: r.id }, data: { rawData: toJson({ ...raw, review: "SKIP", skipRuleId: rule.id }), selected: false } });
      appliedRows++;
    }
    await refreshCounters(db, batchId);
  });
  await publishEvent(ctx.householdId, "import.changed", batchId);
  await publishEvent(ctx.householdId, "category.changed");
  return { ...(await getImportPreview(ctx, batchId)), rule: { id: rule.id, name: rule.name }, appliedRows };
}
