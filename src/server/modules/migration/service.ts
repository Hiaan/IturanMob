import { z } from "zod";
import { Prisma, type SpreadsheetMigration } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishEvent } from "../../events";
import { errorInfo, logger } from "../../logger";
import { sha256Hex } from "../../crypto";
import { readStoredFile, storedFileExists } from "../../storage";
import { dateToISO, isMonthKey, isoToDate, minISO, todayISO } from "@/lib/dates";
import { normalizeText, tokenSimilarity } from "@/lib/utils";
import { audit } from "../audit/service";
import { createAccount, updateAccount } from "../accounts/service";
import { createCard, updateCard, deleteCard } from "../cards/service";
import { quickCreateCategory, deleteCategory, deleteSubcategory } from "../categories/service";
import { createBill } from "../bills/service";
import { upsertBudget } from "../budgets/service";
import { deleteAccount } from "../accounts/service";
import { visibleAccountWhere, visibleCardWhere } from "../visibility/scope";
import {
  commitImport,
  createMigrationBatch,
  discardMigrationBatch,
  markMigrationRowsDuplicate,
  storeImportFile,
  undoImport,
} from "../imports/service";
import { aiAvailable, aiSuggestCategories, needsAi } from "./ai";
import { classifySheet, contextYear, detectMatrix, unsignedDefaultFor, type ClassifyContext } from "./classify";
import { detectColumns, MIGRATION_FIELDS } from "./columns";
import { applySuggestions, collectCorrespondences, mergeCorrespondences, NATURE_LABELS, suggestFor, type Catalog } from "./correspondences";
import { dispatchMigrationJob, registerMigrationRunner } from "./jobs";
import { buildMigrationRows, readMatrixRows, readSheetRows, type BuiltRow, type Resolution } from "./rows";
import { applyTemplateToCorrespondences, applyTemplateToSheets, buildTemplateConfig, sheetSignature, templateMatchScore, workbookSignature, type TemplateConfig } from "./template";
import { detectSheetFormat, MIGRATION_MAX_ROWS, readWorkbook, SpreadsheetReadError, type RawSheet, type RawWorkbook } from "./workbook";
import type {
  ColumnMap,
  Correspondence,
  CorrespondenceDecision,
  CorrespondenceField,
  InitialBalanceChoice,
  MigrationDestinationDTO,
  MigrationDTO,
  MigrationListItemDTO,
  MigrationOptionsDTO,
  MigrationResultDTO,
  MigrationStatus,
  MigrationSummaryDTO,
  MigrationTemplateDTO,
  PlannedBill,
  PlannedBudget,
  SheetConfig,
  SheetFormat,
} from "./types";

/**
 * Migração de planilha ("Migrar de planilha"): lê todas as abas, identifica o tipo de cada uma e
 * as colunas, monta as correspondências De → Para, gera uma prévia por conta/cartão (reaproveitando
 * a importação: duplicados, já registrados, transferências, regras e natureza), importa tudo e
 * desfaz tudo de uma vez. Nada entra no banco sem a confirmação da pessoa.
 */

export const MIGRATION_MAX_MB = 15;
const MIGRATION_MAX_BYTES = MIGRATION_MAX_MB * 1024 * 1024;
const ACCEPTED_EXT = /\.(xlsx|xlsm|xls|ods|csv|txt)$/i;

const MIME: Record<SheetFormat, string> = {
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  XLS: "application/vnd.ms-excel",
  ODS: "application/vnd.oasis.opendocument.spreadsheet",
  CSV: "text/csv",
};

// -----------------------------------------------------------------------------
// Estado interno (JSON)
// -----------------------------------------------------------------------------

interface BalanceSuggestion {
  cents: number;
  date: string;
  from: "BALANCE_COLUMN" | "OPENING_ROW";
}

interface AppliedChanges {
  batches: string[];
  bills: string[];
  budgets: Array<{ id: string; categoryId: string; month: string; previous: number | null }>;
  accounts: Array<{ id: string; before: { cents: number; date: string }; after: { cents: number; date: string } }>;
  templateId: string | null;
}

interface InternalOptions extends MigrationOptionsDTO {
  contextYear: number;
  yearFromContext: boolean;
  created: { categories: string[]; subcategories: string[]; accounts: string[]; cards: string[] };
  /** Lotes da prévia (um por destino). */
  batches: Array<{ batchId: string; dest: string }>;
  plan: { bills: PlannedBill[]; skippedBills: number; budgets: PlannedBudget[]; balances: Record<string, BalanceSuggestion> } | null;
  applied: AppliedChanges | null;
  result: MigrationResultDTO | null;
  aiReason?: string | null;
}

function defaultOptions(year: ClassifyContext): InternalOptions {
  return {
    defaultAccountId: null,
    defaultCardId: null,
    keepCurrentBalance: true,
    initialBalances: [],
    saveTemplate: true,
    templateName: null,
    contextYear: year.year,
    yearFromContext: year.yearFromContext,
    created: { categories: [], subcategories: [], accounts: [], cards: [] },
    batches: [],
    plan: null,
    applied: null,
    result: null,
  };
}

function json<T>(value: Prisma.JsonValue | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return value as unknown as T;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function readOptions(m: Pick<SpreadsheetMigration, "options">): InternalOptions {
  const o = json<Partial<InternalOptions>>(m.options, {});
  return { ...defaultOptions({ year: new Date().getUTCFullYear(), yearFromContext: false }), ...o, created: { categories: [], subcategories: [], accounts: [], cards: [], ...(o.created ?? {}) } };
}

const readSheets = (m: Pick<SpreadsheetMigration, "sheets">) => json<SheetConfig[]>(m.sheets, []);
const readCorr = (m: Pick<SpreadsheetMigration, "correspondences">) => json<Correspondence[]>(m.correspondences, []);

function messageOf(err: unknown): string {
  if (err instanceof AppError || err instanceof SpreadsheetReadError) return err.message;
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? "Dados inválidos.";
  return "Não foi possível concluir esta etapa. Tente de novo.";
}

// -----------------------------------------------------------------------------
// Planilha em memória (evita reler o arquivo a cada ajuste)
// -----------------------------------------------------------------------------

const cache = new Map<string, { wb: RawWorkbook; at: number }>();
const CACHE_TTL = 15 * 60_000;

async function loadWorkbook(m: Pick<SpreadsheetMigration, "id" | "storageKey" | "fileName">): Promise<RawWorkbook> {
  const hit = cache.get(m.id);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.wb;
  if (!m.storageKey || !(await storedFileExists(m.storageKey))) throw new ValidationError("O arquivo original não está mais disponível. Envie a planilha de novo.");
  const wb = await readWorkbook(await readStoredFile(m.storageKey), m.fileName, { maxRows: MIGRATION_MAX_ROWS });
  cache.set(m.id, { wb, at: Date.now() });
  for (const [k, v] of cache) if (cache.size > 4 || Date.now() - v.at > CACHE_TTL) cache.delete(k);
  return wb;
}

function pairs(wb: RawWorkbook, sheets: SheetConfig[]): Array<{ sheet: RawSheet; cfg: SheetConfig }> {
  return sheets.filter((s) => wb.sheets[s.index]).map((cfg) => ({ sheet: wb.sheets[cfg.index]!, cfg }));
}

// -----------------------------------------------------------------------------
// Catálogo da família (destinos possíveis)
// -----------------------------------------------------------------------------

async function catalogFor(ctx: ServiceContext): Promise<Catalog> {
  const [categories, accounts, cards, members] = await Promise.all([
    prisma.category.findMany({
      where: { householdId: ctx.householdId, archivedAt: null },
      orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, kind: true, subcategories: { where: { archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, keywords: true } } },
    }),
    prisma.account.findMany({ where: { ...visibleAccountWhere(ctx), archivedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, institution: true, type: true } }),
    prisma.creditCard.findMany({ where: { ...visibleCardWhere(ctx), archivedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, issuer: true, last4: true } }),
    prisma.householdMember.findMany({ where: { householdId: ctx.householdId, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, displayName: true } }),
  ]);
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, subcategories: c.subcategories })),
    accounts,
    cards,
    members: members.map((m) => ({ id: m.id, name: m.displayName })),
    currentMemberId: ctx.memberId ?? "",
  };
}

function targetExists(d: CorrespondenceDecision, catalog: Catalog): boolean {
  if (d.action !== "MAP") return true;
  switch (d.targetType) {
    case "CATEGORY":
      return catalog.categories.some((c) => c.id === d.targetId);
    case "SUBCATEGORY":
      return catalog.categories.some((c) => c.subcategories.some((s) => s.id === d.targetId));
    case "ACCOUNT":
      return catalog.accounts.some((a) => a.id === d.targetId);
    case "CARD":
      return catalog.cards.some((c) => c.id === d.targetId);
    case "MEMBER":
      return catalog.members.some((m) => m.id === d.targetId);
    case "NATURE":
      return d.targetId in NATURE_LABELS;
  }
}

const ALLOWED_TARGETS: Record<CorrespondenceField, string[]> = {
  category: ["CATEGORY", "SUBCATEGORY"],
  subcategory: ["CATEGORY", "SUBCATEGORY"],
  account: ["ACCOUNT", "CARD"],
  card: ["CARD"],
  person: ["MEMBER"],
  nature: ["NATURE"],
};

// -----------------------------------------------------------------------------
// Abas
// -----------------------------------------------------------------------------

function headersAt(sheet: RawSheet, headerRowIndex: number): string[] {
  const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
  const h = headerRowIndex >= 0 ? sheet.rows[headerRowIndex] ?? [] : [];
  return Array.from({ length: width }, (_, i) => (h[i] ?? "").trim() || `Coluna ${i + 1}`);
}

function initialSheetConfig(sheet: RawSheet, index: number, year: ClassifyContext): SheetConfig {
  const a = classifySheet(sheet, year);
  const importable = a.kind === "LIST" || a.kind === "MONTH" || a.kind === "MATRIX";
  return {
    index,
    name: sheet.name,
    hidden: sheet.hidden,
    truncated: sheet.truncated,
    rowCount: sheet.rows.length,
    detectedKind: a.kind,
    kind: a.kind,
    reason: sheet.hidden && importable ? `${a.reason} Aba oculta: marque se quiser usá-la.` : a.reason,
    selected: importable && !sheet.hidden,
    headerRowIndex: a.matrix ? a.matrix.headerRowIndex : a.headerRowIndex,
    headers: a.headers,
    columns: a.columns,
    month: a.month,
    yearGuessed: a.yearGuessed,
    unsigned: a.unsigned,
    unsignedAs: a.unsigned ? a.unsignedDefault : null,
    invertSigns: false,
    matrix: a.matrix,
    matrixMode: null,
    dataRows: a.dataRows,
    ignoredRows: 0,
    sample: [],
    warnings: [],
    fromTemplate: false,
    signature: "",
  };
}

function refreshSheet(sheet: RawSheet, cfg: SheetConfig, year: number): SheetConfig {
  const out: SheetConfig = { ...cfg, warnings: [] };
  out.signature = sheetSignature(out);
  const start = Math.max(0, out.headerRowIndex + 1);
  out.sample = sheet.rows.slice(start, start + 8).map((r) => out.headers.map((_, i) => (r[i] ?? "").slice(0, 60)));
  if (sheet.truncated) out.warnings.push(`A planilha passou do limite de ${MIGRATION_MAX_ROWS.toLocaleString("pt-BR")} linhas: só as primeiras foram lidas. Divida o arquivo para migrar o resto.`);
  if (out.kind === "LIST" || out.kind === "MONTH") {
    const c = out.columns;
    // Valores sem sinal: nenhum negativo e sem coluna de tipo (o sinal vem da escolha da aba).
    const data = sheet.rows.slice(start);
    const negatives = c.amount !== null && data.some((r) => /^\s*[-−(]|\bD\s*$/i.test(r[c.amount!] ?? ""));
    out.unsigned = c.amount !== null && c.type === null && !negatives;
    if (out.unsigned && !out.unsignedAs) out.unsignedAs = unsignedDefaultFor(out.name);
    if (!out.unsigned) out.unsignedAs = null;
    const { rows, ignored } = readSheetRows(sheet, out, year);
    out.dataRows = rows.length;
    out.ignoredRows = ignored.totals + ignored.examples;
    const errors = rows.filter((r) => r.error).length;
    if (errors) out.warnings.push(`${errors} linha(s) com data ou valor que não deu para ler: aparecem como erro na prévia.`);
    if (ignored.examples) out.warnings.push(`${ignored.examples} linha(s) de exemplo da planilha modelo ignoradas.`);
    const toPay = rows.filter((r) => r.status === "TO_PAY").length;
    if (toPay) out.warnings.push(`${toPay} linha(s) "a pagar": viram contas a pagar (não mexem no saldo).`);
    if (c.date === null && c.day === null) out.warnings.push("Indique a coluna de data (ou de dia, em abas mensais).");
    if (c.amount === null && c.debit === null && c.credit === null) out.warnings.push("Indique a coluna de valor (ou de débito/crédito).");
    if (out.kind === "MONTH" && !out.month) out.warnings.push("Informe o mês desta aba.");
  } else if (out.kind === "MATRIX") {
    const { rows, totals } = readMatrixRows(sheet, out);
    out.dataRows = rows.length;
    out.ignoredRows = totals;
    if (!out.matrixMode) out.warnings.push("Escolha: lançamentos consolidados por mês ou orçamento.");
  }
  return out;
}

/** Abas com os mesmos lançamentos (ex.: lista anual e abas mensais): entrariam em dobro. */
function overlapWarnings(list: Array<{ sheet: RawSheet; cfg: SheetConfig }>, year: number): Map<number, string> {
  const out = new Map<number, string>();
  const keys = list
    .filter(({ cfg }) => cfg.selected && (cfg.kind === "LIST" || cfg.kind === "MONTH"))
    .map(({ sheet, cfg }) => ({ cfg, keys: new Set(readSheetRows(sheet, cfg, year).rows.filter((r) => r.date && r.amountCents !== null).map((r) => `${r.date}|${Math.abs(r.amountCents!)}|${normalizeText(r.description)}`)) }));
  for (let j = 1; j < keys.length; j++) {
    for (let i = 0; i < j; i++) {
      const a = keys[i]!;
      const b = keys[j]!;
      if (b.keys.size < 5) continue;
      let common = 0;
      for (const k of b.keys) if (a.keys.has(k)) common++;
      if (common >= 5 && common / Math.min(a.keys.size, b.keys.size) >= 0.5) {
        out.set(b.cfg.index, `Muitos lançamentos desta aba também estão na aba "${a.cfg.name}". Se for a mesma informação, desmarque uma delas — senão entram em dobro.`);
        break;
      }
    }
  }
  return out;
}

function refreshAll(wb: RawWorkbook, sheets: SheetConfig[], year: number): SheetConfig[] {
  const refreshed = sheets.map((s) => (wb.sheets[s.index] ? refreshSheet(wb.sheets[s.index]!, s, year) : s));
  const overlap = overlapWarnings(pairs(wb, refreshed), year);
  return refreshed.map((s) => (overlap.has(s.index) ? { ...s, warnings: [...s.warnings, overlap.get(s.index)!] } : s));
}

function recomputeCorrespondences(wb: RawWorkbook, sheets: SheetConfig[], previous: Correspondence[], catalog: Catalog, year: number): Correspondence[] {
  const fresh = collectCorrespondences(pairs(wb, sheets), year);
  const merged = mergeCorrespondences(fresh, previous);
  return merged.map((c) => (c.suggestion ? c : { ...c, suggestion: suggestFor(c, catalog) }));
}

// -----------------------------------------------------------------------------
// DTO
// -----------------------------------------------------------------------------

function pendingCounts(items: Correspondence[]): Record<CorrespondenceField, number> {
  const out: Record<CorrespondenceField, number> = { category: 0, subcategory: 0, account: 0, card: 0, person: 0, nature: 0 };
  for (const c of items) if (!c.decision) out[c.field]++;
  return out;
}

function readiness(status: MigrationStatus, sheets: SheetConfig[], items: Correspondence[]): { canPreview: boolean; problems: string[] } {
  const problems: string[] = [];
  const used = sheets.filter((s) => s.selected && (s.kind === "LIST" || s.kind === "MONTH" || s.kind === "MATRIX"));
  if (!used.length) problems.push("Marque ao menos uma aba com lançamentos.");
  for (const s of used) {
    const c = s.columns;
    if ((s.kind === "LIST" || s.kind === "MONTH") && c.date === null && c.day === null) problems.push(`Aba "${s.name}": indique a coluna de data.`);
    if ((s.kind === "LIST" || s.kind === "MONTH") && c.amount === null && c.debit === null && c.credit === null) problems.push(`Aba "${s.name}": indique a coluna de valor.`);
    if (s.kind === "MONTH" && !s.month) problems.push(`Aba "${s.name}": informe o mês.`);
    if (s.kind === "LIST" && c.date === null && c.day !== null && !s.month) problems.push(`Aba "${s.name}": só tem o dia — informe o mês.`);
    if (s.kind === "MATRIX" && !s.matrixMode) problems.push(`Aba "${s.name}": escolha usar como lançamentos consolidados ou como orçamento.`);
  }
  const dest = items.filter((c) => (c.field === "account" || c.field === "card") && !c.decision);
  if (dest.length) problems.push(`Decida ${dest.length === 1 ? "a conta/cartão" : `as ${dest.length} contas/cartões`} da planilha (${dest.slice(0, 4).map((c) => `"${c.label}"`).join(", ")}${dest.length > 4 ? "…" : ""}): escolha, crie ou ignore.`);
  if (status !== "READY") problems.unshift(status === "READING" ? "A planilha ainda está sendo lida." : "A prévia já foi gerada: volte para ajustar.");
  return { canPreview: status === "READY" && problems.length === 0, problems };
}

function publicOptions(o: InternalOptions): MigrationOptionsDTO {
  return {
    defaultAccountId: o.defaultAccountId,
    defaultCardId: o.defaultCardId,
    keepCurrentBalance: o.keepCurrentBalance,
    initialBalances: o.initialBalances,
    saveTemplate: o.saveTemplate,
    templateName: o.templateName,
  };
}

interface RowFacts {
  batchId: string;
  status: string;
  selected: boolean;
  amountCents: number | null;
  date: Date | null;
  kind: string | null;
  transferAccountId: string | null;
  plan: boolean;
}

async function rowFacts(batchIds: string[]): Promise<RowFacts[]> {
  if (!batchIds.length) return [];
  return prisma.$queryRaw<RowFacts[]>`
    SELECT "batchId", status::text AS status, selected, "amountCents", date,
           "rawData"->>'kind' AS kind,
           "rawData"->>'transferAccountId' AS "transferAccountId",
           COALESCE(jsonb_typeof("rawData"->'installmentPlan') = 'object', false) AS plan
    FROM "ImportRow" WHERE "batchId" = ANY(${batchIds})`;
}

async function destinations(ctx: ServiceContext, o: InternalOptions): Promise<MigrationDestinationDTO[]> {
  const ids = o.batches.map((b) => b.batchId);
  if (!ids.length) return [];
  const [batches, facts] = await Promise.all([
    prisma.importBatch.findMany({ where: { id: { in: ids }, householdId: ctx.householdId }, include: { account: { select: { id: true, name: true, initialBalanceCents: true, initialBalanceDate: true } }, creditCard: { select: { id: true, name: true } } } }),
    rowFacts(ids),
  ]);
  const accountIds = batches.map((b) => b.accountId).filter(Boolean) as string[];
  const ledger = accountIds.length ? await prisma.ledgerEntry.groupBy({ by: ["accountId"], where: { accountId: { in: accountIds } }, _sum: { amountCents: true } }) : [];
  const ledgerSum = new Map(ledger.map((l) => [l.accountId, l._sum.amountCents ?? 0]));
  const byBatch = new Map<string, RowFacts[]>();
  for (const f of facts) byBatch.set(f.batchId, [...(byBatch.get(f.batchId) ?? []), f]);
  const out: MigrationDestinationDTO[] = [];
  for (const ref of o.batches) {
    const b = batches.find((x) => x.id === ref.batchId);
    if (!b) continue;
    const rows = byBatch.get(b.id) ?? [];
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const willCreate = rows.filter((r) => r.selected && r.status === "NEW");
    const created = rows.filter((r) => r.status === "IMPORTED");
    const active = b.status === "IMPORTED" ? created : willCreate;
    const dates = active.map((r) => (r.date ? dateToISO(r.date) : null)).filter(Boolean).sort() as string[];
    const sumIn = active.filter((r) => (r.amountCents ?? 0) > 0).reduce((s, r) => s + r.amountCents!, 0);
    const sumOut = active.filter((r) => (r.amountCents ?? 0) < 0).reduce((s, r) => s - r.amountCents!, 0);
    const kind: MigrationDestinationDTO["kind"] = ref.dest === "MATRIX" ? "MATRIX" : b.creditCardId ? "CARD" : b.accountId ? "ACCOUNT" : "NONE";
    let balance: MigrationDestinationDTO["balance"] = null;
    if (b.account && b.status !== "UNDONE") {
      const isNew = o.created.accounts.includes(b.account.id);
      const current = b.account.initialBalanceCents + (ledgerSum.get(b.account.id) ?? 0);
      const initialDate = dateToISO(b.account.initialBalanceDate);
      const suggestion = o.plan?.balances[b.account.id] ?? null;
      const choice = o.initialBalances.find((c) => c.accountId === b.account!.id) ?? null;
      // Transferências de outras contas da migração para esta.
      const incoming = facts.filter((f) => f.batchId !== b.id && f.kind === "TRANSFER" && f.transferAccountId === b.account!.id && f.selected && f.status === "NEW").reduce((s, f) => s - (f.amountCents ?? 0), 0);
      const before = isNew ? [] : willCreate.filter((r) => r.date && dateToISO(r.date) < initialDate);
      const moved = willCreate.reduce((s, r) => s + (r.amountCents ?? 0), 0) + incoming;
      const compensated = !isNew && o.keepCurrentBalance && !choice ? before.reduce((s, r) => s + (r.amountCents ?? 0), 0) : 0;
      let projected: number;
      if (b.status === "IMPORTED") projected = current;
      else if (choice?.mode === "CURRENT") projected = choice.cents;
      else if (isNew) projected = (choice?.cents ?? suggestion?.cents ?? 0) + moved;
      else if (choice?.mode === "INITIAL") projected = choice.cents + moved + (current - b.account.initialBalanceCents);
      else projected = current + moved - compensated;
      balance = {
        isNew,
        currentBalanceCents: current,
        initialBalanceCents: b.account.initialBalanceCents,
        initialBalanceDate: initialDate,
        suggestedInitialCents: suggestion?.cents ?? null,
        suggestedInitialDate: suggestion?.date ?? null,
        suggestedFrom: suggestion?.from ?? null,
        choice,
        rowsBeforeInitial: before.length,
        projectedBalanceCents: projected,
        needsInitialBalance: isNew && !choice && !suggestion && b.status === "PREVIEW",
      };
    }
    out.push({
      batchId: b.id,
      kind,
      id: b.accountId ?? b.creditCardId ?? null,
      name: b.account?.name ?? b.creditCard?.name ?? (kind === "MATRIX" ? "Totais mensais (categorias × meses)" : "Sem conta ou cartão"),
      newRows: count("NEW"),
      selectedRows: willCreate.length,
      matchedRows: count("MATCHED"),
      duplicateRows: count("DUPLICATE"),
      divergentRows: count("DIVERGENT"),
      skippedRows: count("SKIPPED"),
      errorRows: count("ERROR"),
      transfers: active.filter((r) => r.kind === "TRANSFER").length,
      installmentPurchases: active.filter((r) => r.plan).length,
      inCents: sumIn,
      outCents: sumOut,
      start: dates[0] ?? null,
      end: dates[dates.length - 1] ?? null,
      balance,
    });
  }
  return out;
}

/** Etapa em segundo plano sem progresso há 10 minutos (servidor reiniciado): volta para poder repetir. */
const STALE_MS = 10 * 60_000;

async function recoverStale(m: SpreadsheetMigration): Promise<boolean> {
  if (!["READING", "PREVIEWING", "COMMITTING"].includes(m.status) || Date.now() - m.updatedAt.getTime() < STALE_MS) return false;
  const o = readOptions(m);
  const next: Record<string, { status: MigrationStatus; error: string }> = {
    READING: { status: "FAILED", error: "A leitura da planilha foi interrompida. Envie o arquivo de novo." },
    PREVIEWING: { status: "READY", error: "A geração da prévia foi interrompida. Gere a prévia de novo." },
    // Importação ou desfazer interrompidos: repetir continua de onde parou (nada é duplicado).
    COMMITTING: o.result
      ? { status: "IMPORTED", error: "O desfazer foi interrompido. Tente desfazer de novo." }
      : { status: "PREVIEW", error: "A importação foi interrompida. Confirme de novo para continuar (nada é duplicado) ou desfaça a migração." },
  };
  const target = next[m.status]!;
  const res = await prisma.spreadsheetMigration.updateMany({ where: { id: m.id, status: m.status, updatedAt: m.updatedAt }, data: { status: target.status, error: target.error, progress: 0, progressLabel: null } });
  if (res.count) logger.warn({ migrationId: m.id, from: m.status, to: target.status }, "migração: etapa interrompida recuperada");
  return res.count > 0;
}

export async function getMigration(ctx: ServiceContext, id: string): Promise<MigrationDTO> {
  let m = await prisma.spreadsheetMigration.findFirst({ where: { id, householdId: ctx.householdId }, include: { template: { select: { id: true, name: true } } } });
  if (!m) throw new NotFoundError("Migração");
  if (await recoverStale(m)) m = (await prisma.spreadsheetMigration.findFirst({ where: { id }, include: { template: { select: { id: true, name: true } } } }))!;
  const sheets = readSheets(m);
  const items = readCorr(m);
  const o = readOptions(m);
  const catalog = await catalogFor(ctx);
  const staticSummary = json<Omit<MigrationSummaryDTO, "destinations" | "totals" | "period"> | null>(m.summary, null);
  let summary: MigrationSummaryDTO | null = null;
  if (staticSummary) {
    const dest = await destinations(ctx, o);
    const all = dest.filter((d) => d.start).map((d) => [d.start!, d.end!]).flat().sort();
    summary = {
      ...staticSummary,
      destinations: dest,
      period: all.length ? { start: all[0]!, end: all[all.length - 1]! } : null,
      totals: {
        rows: dest.reduce((s, d) => s + d.newRows + d.matchedRows + d.duplicateRows + d.divergentRows + d.skippedRows + d.errorRows, 0),
        selected: dest.reduce((s, d) => s + d.selectedRows, 0),
        inCents: dest.reduce((s, d) => s + d.inCents, 0),
        outCents: dest.reduce((s, d) => s + d.outCents, 0),
      },
    };
  }
  const origin = json<{ channel?: string } | null>(m.origin, null);
  return {
    id: m.id,
    fileName: m.fileName,
    format: m.format as SheetFormat,
    status: m.status,
    progress: m.progress,
    progressLabel: m.progressLabel,
    error: m.error,
    createdAt: m.createdAt.toISOString(),
    importedAt: m.importedAt?.toISOString() ?? null,
    undoneAt: m.undoneAt?.toISOString() ?? null,
    origin: origin?.channel === "WHATSAPP" ? "WHATSAPP" : null,
    template: m.template,
    sheets,
    correspondences: items,
    pending: pendingCounts(items),
    options: publicOptions(o),
    targets: {
      categories: catalog.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, subcategories: c.subcategories.map((s) => ({ id: s.id, name: s.name })) })),
      accounts: catalog.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, institution: a.institution })),
      cards: catalog.cards.map((c) => ({ id: c.id, name: c.name })),
      members: catalog.members,
    },
    aiAvailable: m.status === "READY" ? await aiAvailable(ctx.householdId) : false,
    ready: readiness(m.status, sheets, items),
    summary,
    result: o.result,
  };
}

export async function listMigrations(ctx: ServiceContext, limit = 20): Promise<MigrationListItemDTO[]> {
  const items = await prisma.spreadsheetMigration.findMany({ where: { householdId: ctx.householdId }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 50) });
  return items.map((m) => {
    const o = readOptions(m);
    return {
      id: m.id,
      fileName: m.fileName,
      format: m.format as SheetFormat,
      status: m.status,
      progress: m.progress,
      createdAt: m.createdAt.toISOString(),
      importedAt: m.importedAt?.toISOString() ?? null,
      undoneAt: m.undoneAt?.toISOString() ?? null,
      rows: readSheets(m).filter((s) => s.selected).reduce((n, s) => n + s.dataRows, 0) || null,
      created: o.result?.created ?? null,
    };
  });
}

// -----------------------------------------------------------------------------
// Etapa 1: arquivo
// -----------------------------------------------------------------------------

async function setProgress(id: string, progress: number, label: string) {
  await prisma.spreadsheetMigration.update({ where: { id }, data: { progress: Math.max(0, Math.min(100, Math.round(progress))), progressLabel: label } }).catch(() => undefined);
}

export async function startMigration(
  ctx: ServiceContext,
  input: { fileName: string; content: Buffer; origin?: { channel: "WHATSAPP"; chatId: string; messageId: string } | null },
): Promise<MigrationDTO> {
  assertCan(ctx, "data:import");
  const fileName = input.fileName.trim().slice(0, 200) || "planilha.xlsx";
  if (!ACCEPTED_EXT.test(fileName)) throw new ValidationError("Envie uma planilha .xlsx, .xls, .ods ou .csv.");
  if (!input.content.length) throw new ValidationError("O arquivo está vazio.");
  if (input.content.length > MIGRATION_MAX_BYTES) throw new ValidationError(`O arquivo excede o limite de ${MIGRATION_MAX_MB} MB.`);
  const format = detectSheetFormat(fileName, input.content);
  const sha = sha256Hex(input.content);
  const storageKey = await storeImportFile(ctx, input.content, fileName, sha, MIME[format]);
  const year = contextYear(fileName, [], todayISO(ctx.timezone));
  const m = await prisma.spreadsheetMigration.create({
    data: {
      householdId: ctx.householdId,
      fileName,
      fileSha256: sha,
      format,
      storageKey,
      status: "READING",
      progress: 0,
      progressLabel: "Na fila para leitura…",
      options: toJson(defaultOptions(year)),
      origin: input.origin ? toJson(input.origin) : undefined,
      createdById: ctx.memberId,
    },
  });
  logger.info({ householdId: ctx.householdId, migrationId: m.id, format, bytes: input.content.length }, "migração: arquivo recebido");
  await dispatchMigrationJob(ctx, m.id, "read");
  return getMigration(ctx, m.id);
}

async function runRead(ctx: ServiceContext, id: string) {
  const m = await prisma.spreadsheetMigration.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!m || m.status !== "READING") return;
  try {
    await setProgress(id, 5, "Lendo a planilha…");
    cache.delete(id);
    const wb = await loadWorkbook(m);
    await setProgress(id, 35, "Identificando abas e colunas…");
    const year = contextYear(m.fileName, wb.sheets, todayISO(ctx.timezone));
    let sheets = wb.sheets.map((s, i) => initialSheetConfig(s, i, year));
    sheets = sheets.map((s) => ({ ...s, signature: sheetSignature(s) }));

    // Formato já usado pela família: aplica abas, colunas e correspondências.
    const templates = await prisma.spreadsheetTemplate.findMany({ where: { householdId: ctx.householdId } });
    let best: { id: string; config: TemplateConfig; score: number } | null = null;
    for (const t of templates) {
      const config = t.config as unknown as TemplateConfig;
      const score = templateMatchScore(config, sheets);
      if (score > 0 && (!best || score > best.score)) best = { id: t.id, config, score };
    }
    if (best) sheets = applyTemplateToSheets(best.config, sheets);
    sheets = refreshAll(wb, sheets, year.year);

    await setProgress(id, 60, "Montando as correspondências…");
    const catalog = await catalogFor(ctx);
    let items = applySuggestions(collectCorrespondences(pairs(wb, sheets), year.year), catalog);
    if (best) items = applyTemplateToCorrespondences(best.config, items, (d) => targetExists(d, catalog));
    const o = defaultOptions(year);
    if (best) {
      if (best.config.defaultAccountId && catalog.accounts.some((a) => a.id === best!.config.defaultAccountId)) o.defaultAccountId = best.config.defaultAccountId;
      if (best.config.defaultCardId && catalog.cards.some((c) => c.id === best!.config.defaultCardId)) o.defaultCardId = best.config.defaultCardId;
    }
    o.templateName = m.fileName.replace(/\.[^.]+$/, "").slice(0, 60);

    // IA (se configurada e autorizada): só os nomes das categorias sem sugestão confiável.
    if (items.some(needsAi) && (await aiAvailable(ctx.householdId))) {
      await setProgress(id, 80, "Sugerindo categorias com IA (só os nomes)…");
      const ai = await aiSuggestCategories(ctx.householdId, items, catalog);
      items = items.map((c) => (ai.suggestions.has(`${c.field}|${c.key}`) && needsAi(c) ? { ...c, suggestion: ai.suggestions.get(`${c.field}|${c.key}`)! } : c));
      o.aiReason = ai.reason;
    }
    await prisma.spreadsheetMigration.update({
      where: { id },
      data: { status: "READY", progress: 100, progressLabel: null, error: null, sheets: toJson(sheets), correspondences: toJson(items), options: toJson(o), templateId: best?.id ?? null },
    });
    logger.info({ householdId: ctx.householdId, migrationId: id, sheets: sheets.length, items: items.length, template: Boolean(best) }, "migração: planilha lida");
  } catch (err) {
    if (!(err instanceof AppError || err instanceof SpreadsheetReadError)) logger.error({ migrationId: id, err: errorInfo(err) }, "migração: falha na leitura");
    await prisma.spreadsheetMigration.update({ where: { id }, data: { status: "FAILED", progress: 100, progressLabel: null, error: messageOf(err) } });
  }
}

// -----------------------------------------------------------------------------
// Etapas 2–4: abas, colunas, correspondências e opções
// -----------------------------------------------------------------------------

async function loadEditable(ctx: ServiceContext, id: string, allowed: MigrationStatus[] = ["READY"]) {
  assertCan(ctx, "data:import");
  const m = await prisma.spreadsheetMigration.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!m) throw new NotFoundError("Migração");
  if (!allowed.includes(m.status)) {
    throw new ValidationError(
      m.status === "PREVIEW" ? "A prévia já foi gerada. Use \"Voltar e ajustar\" para mudar abas e correspondências." : m.status === "READING" ? "A planilha ainda está sendo lida." : "Esta migração não pode mais ser alterada.",
    );
  }
  return m;
}

async function save(id: string, expectedStatus: MigrationStatus, data: Prisma.SpreadsheetMigrationUpdateManyMutationInput) {
  const res = await prisma.spreadsheetMigration.updateMany({ where: { id, status: expectedStatus }, data });
  if (!res.count) throw new ConflictError("A migração mudou enquanto você editava. Recarregue a página.");
}

const columnsPatchSchema = z.object(Object.fromEntries(MIGRATION_FIELDS.map((f) => [f, z.number().int().min(0).max(200).nullable().optional()])) as Record<keyof ColumnMap, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>);

export const sheetsPatchSchema = z.object({
  sheets: z
    .array(
      z.object({
        index: z.number().int().min(0).max(500),
        selected: z.boolean().optional(),
        kind: z.enum(["LIST", "MONTH", "MATRIX", "SUMMARY"]).optional(),
        headerRowIndex: z.number().int().min(-1).max(100).optional(),
        columns: columnsPatchSchema.optional(),
        month: z.string().refine((v) => isMonthKey(v), "Mês inválido (use AAAA-MM)").nullable().optional(),
        unsignedAs: z.enum(["EXPENSE", "INCOME", "BY_CATEGORY"]).optional(),
        invertSigns: z.boolean().optional(),
        matrixMode: z.enum(["TRANSACTIONS", "BUDGET"]).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export async function updateMigrationSheets(ctx: ServiceContext, id: string, raw: z.input<typeof sheetsPatchSchema>): Promise<MigrationDTO> {
  const input = sheetsPatchSchema.parse(raw);
  const m = await loadEditable(ctx, id);
  const wb = await loadWorkbook(m);
  const o = readOptions(m);
  const year: ClassifyContext = { year: o.contextYear, yearFromContext: o.yearFromContext };
  const sheets = readSheets(m);
  for (const p of input.sheets) {
    const cfg = sheets.find((s) => s.index === p.index);
    const sheet = wb.sheets[p.index];
    if (!cfg || !sheet) throw new ValidationError("Aba inválida.");
    if (p.headerRowIndex !== undefined && p.headerRowIndex !== cfg.headerRowIndex) {
      if (p.headerRowIndex >= sheet.rows.length) throw new ValidationError("Linha de cabeçalho inválida.");
      cfg.headerRowIndex = p.headerRowIndex;
      cfg.headers = headersAt(sheet, p.headerRowIndex);
      cfg.columns = detectColumns(cfg.headers, sheet.rows.slice(p.headerRowIndex + 1));
    }
    if (p.kind && p.kind !== cfg.kind) {
      if (p.kind === "MATRIX") {
        const matrix = cfg.matrix ?? detectMatrix(sheet.rows);
        if (!matrix) throw new ValidationError(`Não encontrei os meses no cabeçalho da aba "${cfg.name}" para usá-la como categorias × meses.`);
        cfg.matrix = matrix;
        cfg.headerRowIndex = matrix.headerRowIndex;
        cfg.headers = headersAt(sheet, matrix.headerRowIndex);
      } else if ((p.kind === "LIST" || p.kind === "MONTH") && !cfg.headers.length) {
        cfg.headers = headersAt(sheet, cfg.headerRowIndex);
        cfg.columns = detectColumns(cfg.headers, sheet.rows.slice(Math.max(0, cfg.headerRowIndex + 1)));
      }
      cfg.kind = p.kind;
      if (p.kind === "SUMMARY") cfg.selected = false;
    }
    if (p.columns) {
      const next = { ...cfg.columns };
      for (const [field, col] of Object.entries(p.columns) as Array<[keyof ColumnMap, number | null | undefined]>) {
        if (col === undefined) continue;
        if (col !== null && col >= cfg.headers.length) throw new ValidationError(`A coluna escolhida para ${field} não existe na aba "${cfg.name}".`);
        next[field] = col;
      }
      const used = Object.values(next).filter((v): v is number => v !== null);
      if (new Set(used).size !== used.length) throw new ValidationError(`Na aba "${cfg.name}", cada coluna só pode ter um uso.`);
      cfg.columns = next;
    }
    if (p.month !== undefined) {
      cfg.month = p.month;
      cfg.yearGuessed = false;
    }
    if (p.unsignedAs) cfg.unsignedAs = p.unsignedAs;
    if (p.invertSigns !== undefined) cfg.invertSigns = p.invertSigns;
    if (p.matrixMode !== undefined) cfg.matrixMode = p.matrixMode;
    if (p.selected !== undefined) {
      if (p.selected && (cfg.kind === "SUMMARY" || cfg.kind === "EMPTY")) throw new ValidationError(`Escolha o tipo da aba "${cfg.name}" (lista, mês ou categorias × meses) antes de usá-la.`);
      cfg.selected = p.selected;
    }
  }
  const refreshed = refreshAll(wb, sheets, year.year);
  const catalog = await catalogFor(ctx);
  const items = recomputeCorrespondences(wb, refreshed, readCorr(m), catalog, year.year);
  await save(id, "READY", { sheets: toJson(refreshed), correspondences: toJson(items) });
  return getMigration(ctx, id);
}

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("MAP"), targetType: z.enum(["CATEGORY", "SUBCATEGORY", "ACCOUNT", "CARD", "MEMBER", "NATURE"]), targetId: z.string().min(1).max(64), label: z.string().max(200).optional() }),
  z.object({ action: z.literal("CREATE"), name: z.string().trim().min(1, "Informe o nome").max(50), parentId: z.string().max(64).nullish(), kind: z.enum(["EXPENSE", "INCOME"]).default("EXPENSE") }),
  z.object({ action: z.literal("IGNORE") }),
]);

export const correspondencesPatchSchema = z.object({
  items: z
    .array(z.object({ field: z.enum(["category", "subcategory", "account", "card", "person", "nature"]), key: z.string().max(200), decision: decisionSchema.nullable() }))
    .min(1)
    .max(2000),
});

function targetLabel(type: string, id: string, catalog: Catalog): string {
  if (type === "CATEGORY") return catalog.categories.find((c) => c.id === id)?.name ?? "";
  if (type === "SUBCATEGORY") {
    for (const c of catalog.categories) {
      const s = c.subcategories.find((x) => x.id === id);
      if (s) return `${c.name} › ${s.name}`;
    }
    return "";
  }
  if (type === "ACCOUNT") return catalog.accounts.find((a) => a.id === id)?.name ?? "";
  if (type === "CARD") return catalog.cards.find((c) => c.id === id)?.name ?? "";
  if (type === "MEMBER") return catalog.members.find((m) => m.id === id)?.name ?? "";
  if (type === "NATURE") return NATURE_LABELS[id as keyof typeof NATURE_LABELS] ?? "";
  return "";
}

export async function updateMigrationCorrespondences(ctx: ServiceContext, id: string, raw: z.input<typeof correspondencesPatchSchema>): Promise<MigrationDTO> {
  const input = correspondencesPatchSchema.parse(raw);
  const m = await loadEditable(ctx, id);
  const catalog = await catalogFor(ctx);
  const items = readCorr(m);
  for (const p of input.items) {
    const item = items.find((c) => c.field === p.field && c.key === p.key);
    if (!item) throw new ValidationError("Item de correspondência não encontrado. Recarregue a página.");
    const d = p.decision;
    if (!d) {
      item.decision = null;
      continue;
    }
    if (d.action === "MAP") {
      if (!ALLOWED_TARGETS[p.field].includes(d.targetType)) throw new ValidationError("Destino incompatível com este item.");
      const label = targetLabel(d.targetType, d.targetId, catalog);
      if (!label) throw new ValidationError("O destino escolhido não existe mais. Recarregue a página.");
      item.decision = { action: "MAP", targetType: d.targetType, targetId: d.targetId, label };
    } else if (d.action === "CREATE") {
      if (p.field !== "category" && p.field !== "subcategory") throw new ValidationError("Contas e cartões são criados pelo botão \"Criar\" (nome e tipo).");
      const parent = d.parentId ? catalog.categories.find((c) => c.id === d.parentId) : null;
      if (d.parentId && !parent) throw new ValidationError("Categoria \"dentro de\" inválida.");
      item.decision = { action: "CREATE", name: d.name, parentId: parent?.id ?? null, kind: parent?.kind ?? d.kind };
    } else {
      item.decision = { action: "IGNORE" };
    }
  }
  await save(id, "READY", { correspondences: toJson(items) });
  return getMigration(ctx, id);
}

export const applySuggestionsSchema = z.object({
  fields: z.array(z.enum(["category", "subcategory", "account", "card", "person", "nature"])).optional(),
});

/** "Aplicar sugestões": aceita as sugestões dos itens ainda sem decisão. */
export async function applyMigrationSuggestions(ctx: ServiceContext, id: string, raw: z.input<typeof applySuggestionsSchema> = {}): Promise<MigrationDTO> {
  const input = applySuggestionsSchema.parse(raw ?? {});
  const m = await loadEditable(ctx, id);
  const catalog = await catalogFor(ctx);
  const items = readCorr(m).map((c) => {
    if (c.decision || !c.suggestion || (input.fields && !input.fields.includes(c.field))) return c;
    const d: CorrespondenceDecision = { action: "MAP", targetType: c.suggestion.targetType, targetId: c.suggestion.targetId, label: c.suggestion.label };
    return targetExists(d, catalog) ? { ...c, decision: d } : c;
  });
  await save(id, "READY", { correspondences: toJson(items) });
  return getMigration(ctx, id);
}

/** Pede à IA sugestões para as categorias ainda sem sugestão confiável (só os nomes saem). */
export async function aiSuggestMigration(ctx: ServiceContext, id: string): Promise<MigrationDTO> {
  const m = await loadEditable(ctx, id);
  const catalog = await catalogFor(ctx);
  let items = readCorr(m);
  if (!(await aiAvailable(ctx.householdId))) throw new ValidationError("Nenhum provedor de IA configurado e autorizado (Configurações → IA e Privacidade).");
  const ai = await aiSuggestCategories(ctx.householdId, items, catalog);
  if (ai.reason && !ai.suggestions.size) throw new ValidationError(ai.reason);
  items = items.map((c) => (ai.suggestions.has(`${c.field}|${c.key}`) && needsAi(c) ? { ...c, suggestion: ai.suggestions.get(`${c.field}|${c.key}`)! } : c));
  await save(id, "READY", { correspondences: toJson(items) });
  return getMigration(ctx, id);
}

export const destinationCreateSchema = z
  .object({
    field: z.enum(["account", "card"]),
    key: z.string().max(200),
    kind: z.enum(["ACCOUNT", "CARD"]),
    name: z.string().trim().min(1, "Informe o nome").max(60),
    accountType: z.enum(["CHECKING", "SAVINGS", "WALLET", "INVESTMENT", "DIGITAL", "OTHER"]).optional(),
    institution: z.string().trim().max(60).nullish(),
    closingDay: z.number().int().min(1).max(31).optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
  })
  .refine((d) => d.kind !== "CARD" || (d.closingDay && d.dueDay), { message: "Informe o dia de fechamento e o de vencimento do cartão.", path: ["closingDay"] })
  .refine((d) => d.field !== "card" || d.kind === "CARD", { message: "Valores da coluna Cartão só podem virar cartão.", path: ["kind"] });

/** Cria a conta ou o cartão "na hora" e liga o item da planilha a ele. */
export async function createMigrationDestination(ctx: ServiceContext, id: string, raw: z.input<typeof destinationCreateSchema>): Promise<MigrationDTO> {
  const input = destinationCreateSchema.parse(raw);
  const m = await loadEditable(ctx, id);
  const items = readCorr(m);
  const item = items.find((c) => c.field === input.field && c.key === input.key);
  if (!item) throw new ValidationError("Item de correspondência não encontrado. Recarregue a página.");
  const o = readOptions(m);
  if (input.kind === "ACCOUNT") {
    const acc = await createAccount(ctx, { name: input.name, institution: input.institution ?? null, type: input.accountType ?? "CHECKING", initialBalanceCents: 0, initialBalanceDate: todayISO(ctx.timezone) });
    o.created.accounts.push(acc.id);
    item.decision = { action: "MAP", targetType: "ACCOUNT", targetId: acc.id, label: acc.name };
  } else {
    const card = await createCard(ctx, { name: input.name, issuer: input.institution ?? null, closingDay: input.closingDay!, dueDay: input.dueDay! });
    o.created.cards.push(card.id);
    item.decision = { action: "MAP", targetType: "CARD", targetId: card.id, label: card.name };
  }
  await save(id, "READY", { correspondences: toJson(items), options: toJson(o) });
  return getMigration(ctx, id);
}

export const optionsPatchSchema = z.object({
  defaultAccountId: z.string().max(64).nullable().optional(),
  defaultCardId: z.string().max(64).nullable().optional(),
  keepCurrentBalance: z.boolean().optional(),
  initialBalances: z
    .array(z.object({ accountId: z.string().max(64), mode: z.enum(["INITIAL", "CURRENT"]), cents: z.number().int().min(-1_000_000_000).max(10_000_000_000) }))
    .max(100)
    .optional(),
  saveTemplate: z.boolean().optional(),
  templateName: z.string().trim().max(60).nullable().optional(),
});

export async function updateMigrationOptions(ctx: ServiceContext, id: string, raw: z.input<typeof optionsPatchSchema>): Promise<MigrationDTO> {
  const input = optionsPatchSchema.parse(raw);
  const m = await loadEditable(ctx, id, ["READY", "PREVIEW"]);
  const o = readOptions(m);
  const catalog = await catalogFor(ctx);
  const changesPreview = input.defaultAccountId !== undefined || input.defaultCardId !== undefined;
  if (changesPreview && m.status !== "READY") throw new ValidationError("Para trocar o destino padrão, volte e gere a prévia de novo.");
  if (input.defaultAccountId && !catalog.accounts.some((a) => a.id === input.defaultAccountId)) throw new ValidationError("Conta padrão inválida.");
  if (input.defaultCardId && !catalog.cards.some((c) => c.id === input.defaultCardId)) throw new ValidationError("Cartão padrão inválido.");
  if (input.initialBalances?.some((b) => !catalog.accounts.some((a) => a.id === b.accountId))) throw new ValidationError("Conta inválida no saldo inicial.");
  if (input.defaultAccountId !== undefined) o.defaultAccountId = input.defaultAccountId;
  if (input.defaultCardId !== undefined) o.defaultCardId = input.defaultCardId;
  if (input.keepCurrentBalance !== undefined) o.keepCurrentBalance = input.keepCurrentBalance;
  if (input.initialBalances !== undefined) o.initialBalances = input.initialBalances as InitialBalanceChoice[];
  if (input.saveTemplate !== undefined) o.saveTemplate = input.saveTemplate;
  if (input.templateName !== undefined) o.templateName = input.templateName;
  await save(id, m.status, { options: toJson(o) });
  return getMigration(ctx, id);
}

// -----------------------------------------------------------------------------
// Etapa 5: prévia
// -----------------------------------------------------------------------------

export async function requestMigrationPreview(ctx: ServiceContext, id: string): Promise<MigrationDTO> {
  const m = await loadEditable(ctx, id);
  const r = readiness(m.status, readSheets(m), readCorr(m));
  if (!r.canPreview) throw new ValidationError(r.problems[0] ?? "Ajuste a migração antes de gerar a prévia.", { problems: r.problems });
  await save(id, "READY", { status: "PREVIEWING", progress: 0, progressLabel: "Preparando a prévia…", error: null });
  await dispatchMigrationJob(ctx, id, "preview");
  return getMigration(ctx, id);
}

function buildResolution(items: Correspondence[], catalog: Catalog): Resolution {
  const res: Resolution = { category: new Map(), subcategory: new Map(), account: new Map(), card: new Map(), person: new Map(), nature: new Map() };
  const catOf = (d: CorrespondenceDecision | null) => {
    if (!d || d.action !== "MAP") return null;
    if (d.targetType === "CATEGORY") {
      const c = catalog.categories.find((x) => x.id === d.targetId);
      return c ? { categoryId: c.id, subcategoryId: null, kind: c.kind } : null;
    }
    if (d.targetType === "SUBCATEGORY") {
      for (const c of catalog.categories) if (c.subcategories.some((s) => s.id === d.targetId)) return { categoryId: c.id, subcategoryId: d.targetId, kind: c.kind };
    }
    return null;
  };
  for (const c of items) {
    const d = c.decision;
    switch (c.field) {
      case "category":
        res.category.set(c.key, catOf(d));
        break;
      case "subcategory":
        res.subcategory.set(c.key, catOf(d));
        break;
      case "account":
      case "card":
        res[c.field].set(
          c.key,
          d?.action === "MAP" && d.targetType === "ACCOUNT" ? { accountId: d.targetId, creditCardId: null } : d?.action === "MAP" && d.targetType === "CARD" ? { accountId: null, creditCardId: d.targetId } : null,
        );
        break;
      case "person":
        res.person.set(c.key, d?.action === "MAP" && d.targetType === "MEMBER" ? d.targetId : null);
        break;
      case "nature":
        res.nature.set(c.key, d?.action === "MAP" && d.targetType === "NATURE" ? (d.targetId as "PERSONAL" | "BUSINESS" | "PASSTHROUGH") : null);
        break;
    }
  }
  return res;
}

/** Saldo antes do primeiro lançamento, pela coluna de saldo (quando ela fecha) ou pela linha "saldo inicial". */
function balanceSuggestions(built: BuiltRow[], wb: RawWorkbook, sheets: SheetConfig[], year: number): Record<string, BalanceSuggestion> {
  const out: Record<string, BalanceSuggestion> = {};
  const byDest = new Map<string, BuiltRow[]>();
  for (const r of built) if (r.dest.startsWith("A:") && !r.parsed.error && r.parsed.amountCents !== null && r.parsed.date) byDest.set(r.dest, [...(byDest.get(r.dest) ?? []), r]);
  for (const [dest, rows] of byDest) {
    const accountId = dest.slice(2);
    const withBalance = rows.filter((r) => r.balanceCents !== null);
    if (withBalance.length >= 2) {
      // Confere: saldo de cada linha = saldo da anterior + valor (em qualquer ordem da planilha).
      const ordered = [...withBalance].sort((a, b) => a.order - b.order);
      let fwd = 0;
      let back = 0;
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i]!.balanceCents === ordered[i - 1]!.balanceCents! + ordered[i]!.parsed.amountCents!) fwd++;
        if (ordered[i - 1]!.balanceCents === ordered[i]!.balanceCents! + ordered[i - 1]!.parsed.amountCents!) back++;
      }
      if (Math.max(fwd, back) / (ordered.length - 1) >= 0.8) {
        const first = fwd >= back ? ordered[0]! : ordered[ordered.length - 1]!;
        out[accountId] = { cents: first.balanceCents! - first.parsed.amountCents!, date: first.parsed.date!, from: "BALANCE_COLUMN" };
        continue;
      }
    }
    // Linha "Saldo inicial/anterior" da aba onde a conta começa.
    const firstRow = [...rows].sort((a, b) => (a.parsed.date ?? "").localeCompare(b.parsed.date ?? "") || a.order - b.order)[0]!;
    const cfg = sheets.find((s) => s.index === firstRow.sheetIndex);
    const sheet = wb.sheets[firstRow.sheetIndex];
    if (cfg && sheet && rows.every((r) => r.sheetIndex === firstRow.sheetIndex)) {
      const { ignored } = readSheetRows(sheet, cfg, year);
      if (ignored.opening) out[accountId] = { cents: ignored.opening.cents, date: firstRow.parsed.date!, from: "OPENING_ROW" };
    }
  }
  return out;
}

async function runPreview(ctx: ServiceContext, id: string) {
  const m = await prisma.spreadsheetMigration.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!m || m.status !== "PREVIEWING") return;
  const o = readOptions(m);
  const createdBatches: string[] = [];
  try {
    const wb = await loadWorkbook(m);
    const sheets = readSheets(m);
    let items = readCorr(m);

    // 1) Categorias "criar nova" (ficam registradas para sair ao descartar/desfazer, se sem uso).
    await setProgress(id, 5, "Criando as categorias novas…");
    for (const c of items) {
      if (c.decision?.action !== "CREATE") continue;
      const r = await quickCreateCategory(ctx, { name: c.decision.name, kind: c.decision.kind, parentId: c.decision.parentId });
      if (r.created) (r.subcategoryId ? o.created.subcategories : o.created.categories).push(r.subcategoryId ?? r.categoryId);
      c.decision = { action: "MAP", targetType: r.subcategoryId ? "SUBCATEGORY" : "CATEGORY", targetId: r.subcategoryId ?? r.categoryId, label: r.label };
    }
    const catalog = await catalogFor(ctx);
    items = items.map((c) => (c.decision && !targetExists(c.decision, catalog) ? { ...c, decision: null } : c));
    const res = buildResolution(items, catalog);

    // 2) Linhas por destino.
    await setProgress(id, 15, "Lendo as linhas das abas…");
    const today = todayISO(ctx.timezone);
    const built = buildMigrationRows(pairs(wb, sheets), res, { fileName: m.fileName, today, defaultAccountId: o.defaultAccountId, defaultCardId: o.defaultCardId, contextYear: o.contextYear });
    const groups = new Map<string, BuiltRow[]>();
    for (const r of built.rows) groups.set(r.dest, [...(groups.get(r.dest) ?? []), r]);
    if (built.matrixRows.length) groups.set("MATRIX", built.matrixRows);
    const order = (k: string) => (k.startsWith("A:") ? 0 : k.startsWith("C:") ? 1 : k === "NONE" ? 2 : 3);
    const keys = [...groups.keys()].sort((a, b) => order(a) - order(b));
    const total = keys.reduce((n, k) => n + groups.get(k)!.length, 0);
    let done = 0;
    o.batches = [];
    for (const k of keys) {
      const rows = groups.get(k)!.sort((a, b) => (a.parsed.date ?? "9999").localeCompare(b.parsed.date ?? "9999") || a.order - b.order);
      await setProgress(id, 20 + (done / Math.max(1, total)) * 65, `Conferindo duplicados e transferências (${done.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")} linhas)…`);
      const batchId = await createMigrationBatch(ctx, {
        migrationId: id,
        fileName: m.fileName,
        format: m.format as SheetFormat,
        sha256: m.fileSha256,
        storageKey: m.storageKey,
        accountId: k.startsWith("A:") ? k.slice(2) : null,
        creditCardId: k.startsWith("C:") ? k.slice(2) : null,
        rows: rows.map((r) => r.parsed),
        consolidated: k === "MATRIX",
        maxRows: MIGRATION_MAX_ROWS + 100,
      });
      done += rows.length;
      if (batchId) {
        createdBatches.push(batchId);
        o.batches.push({ batchId, dest: k });
      }
    }

    // 3) Mesma transferência vista pelas duas contas: fica só uma.
    await setProgress(id, 88, "Conferindo transferências entre as contas…");
    await dedupeCrossTransfers(o.batches);

    // 4) Contas a pagar, orçamentos e saldos iniciais planejados.
    const bills: PlannedBill[] = [];
    let skippedBills = 0;
    for (const b of built.bills) {
      const existing = await prisma.scheduledPayment.findMany({ where: { householdId: ctx.householdId, dueDate: isoToDate(b.dueDate), amountCents: b.amountCents, type: b.type }, select: { description: true } });
      if (existing.some((e) => tokenSimilarity(e.description, b.description) >= 0.5) || bills.some((x) => x.dueDate === b.dueDate && x.amountCents === b.amountCents && normalizeText(x.description) === normalizeText(b.description))) {
        skippedBills++;
        continue;
      }
      bills.push(b);
    }
    const budgets: PlannedBudget[] = [];
    for (const b of built.budgets.values()) {
      const prev = await prisma.budget.findUnique({ where: { householdId_categoryId_month: { householdId: ctx.householdId, categoryId: b.categoryId, month: b.month } } });
      budgets.push({ ...b, categoryLabel: catalog.categories.find((c) => c.id === b.categoryId)?.name ?? "", previousCents: prev?.limitCents ?? null });
    }
    budgets.sort((a, b) => a.month.localeCompare(b.month) || a.categoryLabel.localeCompare(b.categoryLabel, "pt-BR"));
    const balances = balanceSuggestions(built.rows, wb, sheets, o.contextYear);
    o.plan = { bills, skippedBills, budgets, balances };

    // 5) Avisos.
    const warnings = [...built.warnings];
    const noDest = groups.get("NONE")?.length ?? 0;
    if (noDest) warnings.push(`${noDest} lançamento(s) sem conta ou cartão: não alteram saldos (escolha um destino padrão para mudar isso).`);
    const undecidedCats = items.filter((c) => (c.field === "category" || c.field === "subcategory") && !c.decision).length;
    if (undecidedCats) warnings.push(`${undecidedCats} categoria(s) da planilha sem correspondência: os lançamentos delas ficam sem categoria.`);
    if (skippedBills) warnings.push(`${skippedBills} conta(s) a pagar já existiam no app e não serão criadas de novo.`);
    const cardWarnings = await cardStatementWarnings(ctx, built.rows, today);
    const createdNames = async () => {
      const [cats, subs, accs, cards] = await Promise.all([
        prisma.category.findMany({ where: { id: { in: o.created.categories } }, select: { name: true } }),
        prisma.subcategory.findMany({ where: { id: { in: o.created.subcategories } }, select: { name: true, category: { select: { name: true } } } }),
        prisma.account.findMany({ where: { id: { in: o.created.accounts } }, select: { name: true } }),
        prisma.creditCard.findMany({ where: { id: { in: o.created.cards } }, select: { name: true } }),
      ]);
      return { cats: [...cats.map((c) => c.name), ...subs.map((s) => `${s.category.name} › ${s.name}`)], accs: accs.map((a) => a.name), cards: cards.map((c) => c.name) };
    };
    const names = await createdNames();
    const staticSummary: Omit<MigrationSummaryDTO, "destinations" | "totals" | "period"> = {
      bills,
      skippedBills,
      budgets,
      matrixTransactions: built.matrixRows.length,
      createdCategories: names.cats,
      createdAccounts: names.accs,
      createdCards: names.cards,
      cardStatementsWithoutPayment: cardWarnings,
      warnings,
    };
    await prisma.spreadsheetMigration.update({
      where: { id },
      data: { status: "PREVIEW", progress: 100, progressLabel: null, error: null, correspondences: toJson(items), options: toJson(o), summary: toJson(staticSummary) },
    });
    logger.info({ householdId: ctx.householdId, migrationId: id, batches: o.batches.length, rows: total, bills: bills.length, budgets: budgets.length }, "migração: prévia pronta");
  } catch (err) {
    for (const b of createdBatches) await discardMigrationBatch(ctx, b).catch(() => undefined);
    o.batches = [];
    if (!(err instanceof AppError || err instanceof SpreadsheetReadError)) logger.error({ migrationId: id, err: errorInfo(err) }, "migração: falha na prévia");
    await prisma.spreadsheetMigration.update({ where: { id }, data: { status: "READY", progress: 0, progressLabel: null, error: messageOf(err), options: toJson(o), summary: Prisma.DbNull } });
  }
}

async function dedupeCrossTransfers(batches: InternalOptions["batches"]) {
  const accountBatches = batches.filter((b) => b.dest.startsWith("A:"));
  if (accountBatches.length < 2) return;
  const ids = accountBatches.map((b) => b.batchId);
  // Na ordem dos lotes: a transferência fica no lote da primeira conta e sai do da outra.
  const rows = (
    await prisma.importRow.findMany({
      where: { batchId: { in: ids }, status: "NEW" },
      select: { id: true, batchId: true, rowIndex: true, date: true, amountCents: true, rawData: true },
    })
  ).sort((a, b) => ids.indexOf(a.batchId) - ids.indexOf(b.batchId) || a.rowIndex - b.rowIndex);
  const batchOfAccount = new Map(accountBatches.map((b) => [b.dest.slice(2), b.batchId]));
  const marked = new Set<string>();
  const marks = new Map<string, Array<{ rowId: string; message: string }>>();
  for (const r of rows) {
    if (marked.has(r.id)) continue;
    const raw = r.rawData as { kind?: string; transferAccountId?: string | null; location?: { sheet: string; row: number } | null };
    if (raw.kind !== "TRANSFER" || !raw.transferAccountId || !r.date || !r.amountCents) continue;
    const otherBatch = batchOfAccount.get(raw.transferAccountId);
    if (!otherBatch || otherBatch === r.batchId) continue;
    const day = r.date.getTime();
    const match = rows.find(
      (x) => x.batchId === otherBatch && !marked.has(x.id) && x.id !== r.id && x.amountCents === -r.amountCents! && x.date && Math.abs(x.date.getTime() - day) <= 86_400_000,
    );
    if (!match) continue;
    marked.add(r.id);
    marked.add(match.id);
    const where = raw.location ? ` (aba "${raw.location.sheet}", linha ${raw.location.row})` : "";
    marks.set(otherBatch, [...(marks.get(otherBatch) ?? []), { rowId: match.id, message: `Mesma transferência já vem da outra conta${where}: entra uma vez só.` }]);
  }
  for (const [batchId, list] of marks) await markMigrationRowsDuplicate(batchId, list);
}

async function cardStatementWarnings(ctx: ServiceContext, rows: BuiltRow[], today: string): Promise<Array<{ cardName: string; count: number }>> {
  const currentMonth = today.slice(0, 7);
  const months = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.dest.startsWith("C:") || !r.parsed.date || r.parsed.error || r.parsed.skipReason) continue;
    const month = r.parsed.date.slice(0, 7);
    if (month >= currentMonth) continue;
    const id = r.dest.slice(2);
    months.set(id, (months.get(id) ?? new Set()).add(month));
  }
  if (!months.size) return [];
  const cards = await prisma.creditCard.findMany({ where: { id: { in: [...months.keys()] }, householdId: ctx.householdId }, select: { id: true, name: true } });
  // Pagamentos de fatura na própria planilha (contas) cobrem esses meses.
  const paid = new Map<string, number>();
  for (const r of rows) {
    if (!r.dest.startsWith("A:") || !r.parsed.date || (r.parsed.amountCents ?? 0) >= 0) continue;
    if (/\b(fatura|pagamento cartao|pgto cartao|pag fatura)\b/.test(normalizeText(r.parsed.description))) for (const id of months.keys()) paid.set(id, (paid.get(id) ?? 0) + 1);
  }
  return cards
    .map((c) => ({ cardName: c.name, count: Math.max(0, (months.get(c.id)?.size ?? 0) - (paid.get(c.id) ?? 0)) }))
    .filter((c) => c.count > 0);
}

/** Volta da prévia para ajustar (descarta os lotes da prévia; decisões ficam). */
export async function backToReady(ctx: ServiceContext, id: string): Promise<MigrationDTO> {
  const m = await loadEditable(ctx, id, ["PREVIEW"]);
  const o = readOptions(m);
  for (const b of o.batches) await discardMigrationBatch(ctx, b.batchId);
  o.batches = [];
  o.plan = null;
  await save(id, "PREVIEW", { status: "READY", options: toJson(o), summary: Prisma.DbNull, error: null });
  return getMigration(ctx, id);
}

// -----------------------------------------------------------------------------
// Etapa 6: importar
// -----------------------------------------------------------------------------

export async function requestMigrationCommit(ctx: ServiceContext, id: string): Promise<MigrationDTO> {
  assertCan(ctx, "transactions:write");
  const m = await loadEditable(ctx, id, ["PREVIEW"]);
  const o = readOptions(m);
  if (!o.batches.length && !o.plan?.bills.length && !o.plan?.budgets.length) throw new ValidationError("Não há nada para importar nesta prévia.");
  await save(id, "PREVIEW", { status: "COMMITTING", progress: 0, progressLabel: "Importando…", error: null });
  await dispatchMigrationJob(ctx, id, "commit");
  return getMigration(ctx, id);
}

async function accountBalance(accountId: string): Promise<number> {
  const [a, sum] = await Promise.all([
    prisma.account.findUnique({ where: { id: accountId }, select: { initialBalanceCents: true } }),
    prisma.ledgerEntry.aggregate({ where: { accountId }, _sum: { amountCents: true } }),
  ]);
  return (a?.initialBalanceCents ?? 0) + (sum._sum.amountCents ?? 0);
}

async function runCommit(ctx: ServiceContext, id: string) {
  const m = await prisma.spreadsheetMigration.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!m || m.status !== "COMMITTING") return;
  const o = readOptions(m);
  const applied: AppliedChanges = o.applied ?? { batches: [], bills: [], budgets: [], accounts: [], templateId: null };
  const persist = async () => {
    o.applied = applied;
    await prisma.spreadsheetMigration.update({ where: { id }, data: { options: toJson(o) } });
  };
  try {
    // Contas tocadas (destinos e o outro lado das transferências) e saldo antes.
    const batchRows = await prisma.importBatch.findMany({ where: { id: { in: o.batches.map((b) => b.batchId) } }, select: { id: true, accountId: true, totalRows: true } });
    const transferTargets = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT "rawData"->>'transferAccountId' AS id FROM "ImportRow"
      WHERE "batchId" = ANY(${o.batches.map((b) => b.batchId)}) AND "rawData"->>'kind' = 'TRANSFER' AND "rawData"->>'transferAccountId' IS NOT NULL`;
    const touched = [...new Set([...(batchRows.map((b) => b.accountId).filter(Boolean) as string[]), ...transferTargets.map((t) => t.id).filter(Boolean)])];
    const accountsBefore = await prisma.account.findMany({ where: { id: { in: touched }, householdId: ctx.householdId }, select: { id: true, name: true, initialBalanceCents: true, initialBalanceDate: true } });
    const before = new Map<string, number>();
    for (const a of accountsBefore) before.set(a.id, await accountBalance(a.id));

    // 1) Lotes (cada um com a deduplicação da confirmação).
    const total = batchRows.reduce((n, b) => n + b.totalRows, 0);
    let done = 0;
    let created = 0;
    let matched = 0;
    let duplicates = 0;
    let errors = 0;
    for (const ref of o.batches) {
      const size = batchRows.find((b) => b.id === ref.batchId)?.totalRows ?? 0;
      const res = await commitImport(ctx, ref.batchId, {
        onProgress: (n) => setProgress(id, 5 + ((done + n) / Math.max(1, total)) * 75, `Importando lançamentos (${(done + n).toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")})…`),
      });
      done += size;
      created += res.result.created;
      matched += res.result.matched;
      duplicates += res.result.duplicatesAtCommit + res.counts.DUPLICATE;
      errors += res.result.errors;
      if (!applied.batches.includes(ref.batchId)) applied.batches.push(ref.batchId);
      await persist();
    }

    // 2) Contas a pagar.
    await setProgress(id, 82, "Criando as contas a pagar…");
    const bills = o.plan?.bills ?? [];
    for (let i = applied.bills.length; i < bills.length; i++) {
      const b = bills[i]!;
      const bill = await createBill(ctx, { type: b.type, description: b.description, amountCents: b.amountCents, dueDate: b.dueDate, categoryId: b.categoryId, accountId: b.accountId, notes: b.notes });
      applied.bills.push(bill.id);
      await persist();
    }

    // 3) Orçamentos (matriz como orçamento).
    await setProgress(id, 88, "Aplicando os orçamentos…");
    for (const b of o.plan?.budgets ?? []) {
      if (applied.budgets.some((x) => x.categoryId === b.categoryId && x.month === b.month)) continue;
      const prev = await prisma.budget.findUnique({ where: { householdId_categoryId_month: { householdId: ctx.householdId, categoryId: b.categoryId, month: b.month } } });
      const saved = await upsertBudget(ctx, { categoryId: b.categoryId, month: b.month, limitCents: b.limitCents });
      applied.budgets.push({ id: (saved as { id: string }).id, categoryId: b.categoryId, month: b.month, previous: prev?.limitCents ?? null });
      await persist();
    }

    // 4) Saldos iniciais.
    await setProgress(id, 93, "Ajustando os saldos iniciais…");
    const batchIds = o.batches.map((b) => b.batchId);
    for (const a of accountsBefore) {
      if (applied.accounts.some((x) => x.id === a.id)) continue;
      const migrated = await prisma.ledgerEntry.findMany({
        where: { accountId: a.id, transaction: { importBatchId: { in: batchIds }, deletedAt: null } },
        select: { date: true, amountCents: true },
      });
      if (!migrated.length) continue;
      const earliest = migrated.map((e) => dateToISO(e.date)).sort()[0]!;
      const oldDate = dateToISO(a.initialBalanceDate);
      const isNew = o.created.accounts.includes(a.id);
      const choice = o.initialBalances.find((c) => c.accountId === a.id);
      const suggestion = o.plan?.balances[a.id];
      let cents = a.initialBalanceCents;
      let date = minISO(oldDate, earliest);
      if (choice?.mode === "CURRENT") {
        const ledger = await prisma.ledgerEntry.aggregate({ where: { accountId: a.id }, _sum: { amountCents: true } });
        cents = choice.cents - (ledger._sum.amountCents ?? 0);
      } else if (choice?.mode === "INITIAL") {
        cents = choice.cents;
        date = earliest;
      } else if (isNew) {
        cents = suggestion?.cents ?? a.initialBalanceCents;
        date = suggestion?.date && suggestion.date < earliest ? suggestion.date : earliest;
      } else if (o.keepCurrentBalance) {
        // Conta já existente: o histórico anterior ao saldo inicial já estava dentro dele.
        const beforeInitial = migrated.filter((e) => dateToISO(e.date) < oldDate).reduce((s, e) => s + e.amountCents, 0);
        cents = a.initialBalanceCents - beforeInitial;
      }
      if (cents === a.initialBalanceCents && date === oldDate) continue;
      await updateAccount(ctx, a.id, { initialBalanceCents: cents, initialBalanceDate: date });
      applied.accounts.push({ id: a.id, before: { cents: a.initialBalanceCents, date: oldDate }, after: { cents, date } });
      await persist();
    }

    // 5) Formato lembrado.
    let templateSaved = false;
    if (o.saveTemplate) {
      const sheets = readSheets(m);
      const signature = workbookSignature(sheets);
      if (signature) {
        const config = buildTemplateConfig(sheets, readCorr(m), { defaultAccountId: o.defaultAccountId, defaultCardId: o.defaultCardId });
        const name = (o.templateName || m.fileName.replace(/\.[^.]+$/, "")).slice(0, 60) || "Planilha";
        const t = await prisma.spreadsheetTemplate.upsert({
          where: { householdId_signature: { householdId: ctx.householdId, signature } },
          create: { householdId: ctx.householdId, name, signature, config: toJson(config), timesUsed: 1, lastUsedAt: new Date() },
          update: { name, config: toJson(config), timesUsed: { increment: 1 }, lastUsedAt: new Date() },
        });
        applied.templateId = t.id;
        templateSaved = true;
      }
    }
    if (m.templateId && m.templateId !== applied.templateId) {
      await prisma.spreadsheetTemplate.updateMany({ where: { id: m.templateId, householdId: ctx.householdId }, data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() } });
    }

    const balances = [];
    for (const a of accountsBefore) balances.push({ accountId: a.id, name: a.name, beforeCents: before.get(a.id) ?? 0, afterCents: await accountBalance(a.id) });
    o.result = { created, matched, duplicates, errors, bills: applied.bills.length, budgets: applied.budgets.length, balances, templateSaved };
    o.applied = applied;
    await prisma.spreadsheetMigration.update({ where: { id }, data: { status: "IMPORTED", progress: 100, progressLabel: null, importedAt: new Date(), options: toJson(o) } });
    await audit(ctx, { action: "IMPORT", entityType: "SpreadsheetMigration", entityId: id, after: { fileName: m.fileName, created, matched, duplicates, errors, bills: applied.bills.length, budgets: applied.budgets.length } });
    await publishEvent(ctx.householdId, "import.changed", id);
    await publishEvent(ctx.householdId, "bill.changed");
    await publishEvent(ctx.householdId, "account.changed");
    logger.info({ householdId: ctx.householdId, migrationId: id, created, matched, duplicates, errors }, "migração: importada");
  } catch (err) {
    if (!(err instanceof AppError)) logger.error({ migrationId: id, err: errorInfo(err) }, "migração: falha na importação");
    o.applied = applied;
    await prisma.spreadsheetMigration.update({
      where: { id },
      data: {
        status: "PREVIEW",
        progress: 0,
        progressLabel: null,
        options: toJson(o),
        error: `${messageOf(err)} O que já entrou continua registrado: confirme de novo para continuar (nada é duplicado) ou desfaça a migração.`,
      },
    });
  }
}

// -----------------------------------------------------------------------------
// Desfazer e descartar
// -----------------------------------------------------------------------------

/** Remove o que a migração criou e ninguém mais usa (categorias, contas, cartões). */
async function removeCreatedEntities(ctx: ServiceContext, o: InternalOptions): Promise<{ removed: number; archived: number }> {
  let removed = 0;
  let archived = 0;
  for (const id of o.created.subcategories) {
    const used = await prisma.transaction.count({ where: { subcategoryId: id, deletedAt: null } });
    if (used) continue;
    await prisma.transaction.updateMany({ where: { subcategoryId: id, deletedAt: { not: null } }, data: { subcategoryId: null } });
    await deleteSubcategory(ctx, id).then(() => removed++).catch(() => undefined);
  }
  for (const id of o.created.categories) {
    const used = await prisma.transaction.count({ where: { categoryId: id, deletedAt: null } });
    if (used) continue;
    const deleted = await prisma.transaction.count({ where: { categoryId: id } });
    if (deleted) {
      await prisma.category.update({ where: { id }, data: { archivedAt: new Date() } }).then(() => archived++).catch(() => undefined);
      continue;
    }
    await deleteCategory(ctx, id).then(() => removed++).catch(() => undefined);
  }
  for (const id of o.created.accounts) {
    const used = await prisma.transaction.count({ where: { OR: [{ accountId: id }, { destinationAccountId: id }] } });
    if (!used) await deleteAccount(ctx, id).then(() => removed++).catch(() => undefined);
    else if (!(await prisma.transaction.count({ where: { OR: [{ accountId: id }, { destinationAccountId: id }], deletedAt: null } }))) {
      await updateAccount(ctx, id, { archived: true }).then(() => archived++).catch(() => undefined);
    }
  }
  for (const id of o.created.cards) {
    const used = await prisma.transaction.count({ where: { creditCardId: id } });
    if (!used) await deleteCard(ctx, id).then(() => removed++).catch(() => undefined);
    else if (!(await prisma.transaction.count({ where: { creditCardId: id, deletedAt: null } }))) {
      await updateCard(ctx, id, { archived: true }).then(() => archived++).catch(() => undefined);
    }
  }
  return { removed, archived };
}

export async function undoMigration(ctx: ServiceContext, id: string): Promise<MigrationDTO> {
  assertCan(ctx, "data:import");
  const m = await prisma.spreadsheetMigration.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!m) throw new NotFoundError("Migração");
  if (m.status === "UNDONE") return getMigration(ctx, id);
  const o = readOptions(m);
  const applied = o.applied;
  const partial = m.status === "PREVIEW" && Boolean(applied?.batches.length);
  if (m.status !== "IMPORTED" && !partial) throw new ValidationError("Só migrações importadas podem ser desfeitas (para uma prévia, use Descartar).");
  const claim = await prisma.spreadsheetMigration.updateMany({ where: { id, status: m.status }, data: { status: "COMMITTING", progress: 0, progressLabel: "Desfazendo a migração…" } });
  if (!claim.count) throw new ConflictError("A migração mudou. Recarregue a página.");
  try {
    let removed = 0;
    for (const b of o.batches) {
      const batch = await prisma.importBatch.findUnique({ where: { id: b.batchId }, select: { status: true } });
      if (batch?.status === "IMPORTED") removed += (await undoImport(ctx, b.batchId)).result.removed;
      else if (batch?.status === "PREVIEW") await discardMigrationBatch(ctx, b.batchId);
    }
    let billsKept = 0;
    for (const billId of applied?.bills ?? []) {
      const sp = await prisma.scheduledPayment.findFirst({ where: { id: billId, householdId: ctx.householdId } });
      if (!sp) continue;
      if (sp.status !== "PENDING" || sp.transactionId) {
        billsKept++;
        continue;
      }
      await prisma.scheduledPayment.delete({ where: { id: billId } });
      await audit(ctx, { action: "DELETE", entityType: "ScheduledPayment", entityId: billId, before: sp, metadata: { reason: "Migração de planilha desfeita" } });
    }
    for (const b of applied?.budgets ?? []) {
      if (b.previous === null) await prisma.budget.deleteMany({ where: { id: b.id, householdId: ctx.householdId } });
      else await prisma.budget.updateMany({ where: { id: b.id, householdId: ctx.householdId }, data: { limitCents: b.previous } });
    }
    for (const a of applied?.accounts ?? []) {
      const cur = await prisma.account.findFirst({ where: { id: a.id, householdId: ctx.householdId }, select: { initialBalanceCents: true, initialBalanceDate: true } });
      if (!cur || cur.initialBalanceCents !== a.after.cents || dateToISO(cur.initialBalanceDate) !== a.after.date) continue;
      await updateAccount(ctx, a.id, { initialBalanceCents: a.before.cents, initialBalanceDate: a.before.date });
    }
    const entities = await removeCreatedEntities(ctx, o);
    o.result = o.result ? { ...o.result } : null;
    await prisma.spreadsheetMigration.update({ where: { id }, data: { status: "UNDONE", progress: 100, progressLabel: null, undoneAt: new Date(), options: toJson(o), error: null } });
    await audit(ctx, { action: "UNDO_IMPORT", entityType: "SpreadsheetMigration", entityId: id, after: { transactionsRemoved: removed, billsKept, entitiesRemoved: entities.removed, entitiesArchived: entities.archived }, metadata: { fileName: m.fileName } });
    await publishEvent(ctx.householdId, "import.changed", id);
    await publishEvent(ctx.householdId, "bill.changed");
    await publishEvent(ctx.householdId, "category.changed");
    await publishEvent(ctx.householdId, "account.changed");
    logger.info({ householdId: ctx.householdId, migrationId: id, removed, billsKept }, "migração: desfeita");
  } catch (err) {
    await prisma.spreadsheetMigration.update({ where: { id }, data: { status: m.status, progress: 0, progressLabel: null, error: `Não foi possível desfazer tudo: ${messageOf(err)} Tente de novo.` } });
    throw err;
  }
  return getMigration(ctx, id);
}

export async function discardMigration(ctx: ServiceContext, id: string): Promise<MigrationDTO> {
  const m = await loadEditable(ctx, id, ["READY", "PREVIEW", "FAILED"]);
  const o = readOptions(m);
  if (o.applied?.batches.length) throw new ValidationError("Parte desta migração já foi importada: use Desfazer.");
  for (const b of o.batches) await discardMigrationBatch(ctx, b.batchId);
  o.batches = [];
  await removeCreatedEntities(ctx, o);
  await save(id, m.status, { status: "DISCARDED", options: toJson(o), progressLabel: null });
  cache.delete(id);
  return getMigration(ctx, id);
}

// -----------------------------------------------------------------------------
// Formatos salvos
// -----------------------------------------------------------------------------

export async function listMigrationTemplates(ctx: ServiceContext): Promise<MigrationTemplateDTO[]> {
  const items = await prisma.spreadsheetTemplate.findMany({ where: { householdId: ctx.householdId }, orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }] });
  return items.map((t) => {
    const c = t.config as unknown as TemplateConfig;
    return { id: t.id, name: t.name, sheets: c.sheets?.length ?? 0, correspondences: c.correspondences?.length ?? 0, timesUsed: t.timesUsed, lastUsedAt: t.lastUsedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString() };
  });
}

export async function deleteMigrationTemplate(ctx: ServiceContext, templateId: string): Promise<void> {
  assertCan(ctx, "data:import");
  const t = await prisma.spreadsheetTemplate.findFirst({ where: { id: templateId, householdId: ctx.householdId } });
  if (!t) throw new NotFoundError("Formato salvo");
  await prisma.spreadsheetTemplate.delete({ where: { id: templateId } });
  await audit(ctx, { action: "DELETE", entityType: "SpreadsheetTemplate", entityId: templateId, before: { name: t.name } });
}

/** Migração já criada para uma mensagem do WhatsApp (reprocessamento não cria outra). */
export async function findMigrationByOriginMessage(ctx: ServiceContext, messageId: string) {
  return prisma.spreadsheetMigration.findFirst({ where: { householdId: ctx.householdId, origin: { path: ["messageId"], equals: messageId } }, select: { id: true, status: true, fileName: true } });
}

registerMigrationRunner("read", runRead);
registerMigrationRunner("preview", runPreview);
registerMigrationRunner("commit", runCommit);
