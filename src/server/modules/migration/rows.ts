import type { PaymentMethod } from "@prisma/client";
import { addMonths, daysInMonth, formatMonthBR, isISODate, makeISO, type MonthKey } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { normalizeText } from "@/lib/utils";
import { detectDateFormat, parseImportAmount } from "../imports/mapping";
import type { ParsedImportRow } from "../imports/types";
import {
  installmentFromDescription,
  isOpeningBalanceLabel,
  isTotalLabel,
  parseDayValue,
  parseFlowType,
  parseInstallment,
  parseMigrationDate,
  parsePaymentMethodValue,
  parseStatusValue,
  valueKey,
  type FlowType,
  type InstallmentInfo,
  type NatureValue,
  type StatusValue,
} from "./columns";
import type { RawSheet } from "./workbook";
import type { CorrespondenceField, PlannedBill, SheetConfig } from "./types";

/**
 * Leitura das linhas das abas escolhidas (com as colunas definidas) e montagem das linhas que vão
 * para a prévia de importação — uma prévia por conta/cartão de destino. Valores e datas vêm só da
 * planilha; o que não dá para ler vira erro na linha (nunca um valor estimado).
 */

export interface SheetRowValues {
  sheetIndex: number;
  sheetName: string;
  rowNumber: number;
  date: string | null;
  error: string | null;
  /** Centavos com sinal; sem sinal (aba "pelo tipo da categoria") vem positivo com `signFromCategory`. */
  amountCents: number | null;
  signFromCategory: boolean;
  flow: FlowType | null;
  description: string;
  /** Descrição sem a marcação da parcela ("Geladeira (3/10)" → "Geladeira"). */
  baseDescription: string;
  values: Record<CorrespondenceField, string>;
  paymentMethod: PaymentMethod | null;
  /** A forma de pagamento foi deduzida do valor da conta (a escolha da conta vale). */
  paymentFromAccount: boolean;
  installment: InstallmentInfo | null;
  status: StatusValue | null;
  notes: string | null;
  balanceCents: number | null;
  externalId: string | null;
  cells: Record<string, string>;
}

export interface SheetIgnored {
  totals: number;
  /** Linhas de exemplo da planilha modelo ("EXEMPLO — ..."). */
  examples: number;
  /** Linha "saldo inicial/anterior" da aba (valor e linha). */
  opening: { cents: number; rowNumber: number } | null;
}

function cellOf(row: string[], col: number | null): string {
  return col === null ? "" : (row[col] ?? "").trim();
}

/** Linhas de dados da aba (depois do cabeçalho). */
export function dataRowsOf(sheet: RawSheet, cfg: SheetConfig): Array<{ row: string[]; rowNumber: number }> {
  const start = cfg.headerRowIndex + 1;
  const out: Array<{ row: string[]; rowNumber: number }> = [];
  for (let i = Math.max(0, start); i < sheet.rows.length; i++) out.push({ row: sheet.rows[i]!, rowNumber: sheet.rowNumbers[i] ?? i + 1 });
  return out;
}

/** Lê as linhas de uma aba de lista ou mensal. */
export function readSheetRows(sheet: RawSheet, cfg: SheetConfig, contextYear: number): { rows: SheetRowValues[]; ignored: SheetIgnored } {
  const c = cfg.columns;
  const rows: SheetRowValues[] = [];
  const ignored: SheetIgnored = { totals: 0, examples: 0, opening: null };
  const data = dataRowsOf(sheet, cfg);
  const refYear = cfg.month ? Number(cfg.month.slice(0, 4)) : contextYear;
  const refMonth = cfg.month ? Number(cfg.month.slice(5, 7)) : null;
  const dateFormat = c.date !== null ? (detectDateFormat(data.map((d) => cellOf(d.row, c.date)).filter(Boolean).slice(0, 300)) === "mdy" ? "mdy" : "dmy") : "dmy";

  for (const { row, rowNumber } of data) {
    if (row.filter((v) => v.trim() !== "").length < 2) continue;
    const description = cellOf(row, c.description).replace(/\s+/g, " ").slice(0, 200);
    if (/^exemplo\b/.test(normalizeText(description))) {
      ignored.examples++;
      continue;
    }
    const dateRaw = c.date !== null ? cellOf(row, c.date) : cellOf(row, c.day);
    // Totais, subtotais e saldos (na descrição, na data ou na primeira célula com texto).
    const firstText = row.find((v) => v.trim() !== "" && parseImportAmount(v) === null) ?? "";
    const labelCell = description || firstText;
    if (isTotalLabel(labelCell) || isTotalLabel(dateRaw) || (!dateRaw && isTotalLabel(firstText))) {
      if (isOpeningBalanceLabel(labelCell) && !ignored.opening && !rows.length) {
        const v = parseImportAmount(cellOf(row, c.balance)) ?? parseImportAmount(cellOf(row, c.amount)) ?? parseImportAmount(cellOf(row, c.credit));
        if (v !== null) ignored.opening = { cents: v, rowNumber };
      }
      ignored.totals++;
      continue;
    }

    let error: string | null = null;
    let date: string | null = null;
    if (c.date !== null) {
      if (!dateRaw) error = "Data ausente.";
      else {
        date = parseMigrationDate(dateRaw, { year: refYear, month: refMonth }, dateFormat);
        if (!date) error = `Data inválida: "${dateRaw.slice(0, 30)}"`;
      }
    } else if (c.day !== null) {
      const day = parseDayValue(dateRaw);
      if (!cfg.month) error = "Informe o mês da aba.";
      else if (day === null) error = dateRaw ? `Dia inválido: "${dateRaw.slice(0, 20)}"` : "Dia ausente.";
      else {
        const y = Number(cfg.month.slice(0, 4));
        const m = Number(cfg.month.slice(5, 7));
        if (day > daysInMonth(y, m)) error = `O dia ${day} não existe em ${formatMonthBR(cfg.month as MonthKey)}.`;
        else date = makeISO(y, m, day);
      }
    }

    // Valor: coluna única, ou crédito − débito; o tipo (entrada/saída) define o sinal quando existe.
    let amount: number | null = null;
    let signFromCategory = false;
    if (c.amount !== null) {
      const v = cellOf(row, c.amount);
      amount = v ? parseImportAmount(v) : null;
      if (v && amount === null && !error) error = `Valor inválido: "${v.slice(0, 30)}"`;
    } else {
      const d = cellOf(row, c.debit);
      const cr = cellOf(row, c.credit);
      const dv = d ? parseImportAmount(d) : null;
      const cv = cr ? parseImportAmount(cr) : null;
      if (d && dv === null && !error) error = `Débito inválido: "${d.slice(0, 30)}"`;
      if (cr && cv === null && !error) error = `Crédito inválido: "${cr.slice(0, 30)}"`;
      if (dv !== null || cv !== null) amount = Math.abs(cv ?? 0) - Math.abs(dv ?? 0);
    }
    const flow = parseFlowType(cellOf(row, c.type));
    if (amount !== null) {
      if (flow === "IN") amount = Math.abs(amount);
      else if (flow === "OUT") amount = -Math.abs(amount);
      else if (cfg.unsigned && c.amount !== null && amount > 0 && flow !== "TRANSFER") {
        if (cfg.unsignedAs === "INCOME") amount = Math.abs(amount);
        else if (cfg.unsignedAs === "EXPENSE") amount = -Math.abs(amount);
        else signFromCategory = true;
      }
      if (cfg.invertSigns) amount = -amount;
    }
    if (!error && amount === null) error = "Valor ausente.";

    const installmentCell = cellOf(row, c.installment);
    let installment = parseInstallment(installmentCell);
    let baseDescription = description;
    const fromDesc = installmentFromDescription(description);
    // "Jantar 10/11" em 10/11: é a data da compra, não parcela.
    const isRowDate = Boolean(fromDesc?.bare && date && Number(date.slice(8, 10)) === fromDesc.info.number && Number(date.slice(5, 7)) === fromDesc.info.total);
    if (fromDesc && !isRowDate) {
      baseDescription = fromDesc.base;
      installment ??= fromDesc.info;
    }

    const cells: Record<string, string> = {};
    cfg.headers.forEach((h, i) => {
      const v = row[i];
      if (v !== undefined && v !== "") cells[h] = v.slice(0, 300);
    });

    rows.push({
      sheetIndex: cfg.index,
      sheetName: cfg.name,
      rowNumber,
      date,
      error,
      amountCents: amount,
      signFromCategory,
      flow,
      description,
      baseDescription,
      values: {
        category: cellOf(row, c.category).slice(0, 80),
        subcategory: cellOf(row, c.subcategory).slice(0, 80),
        account: cellOf(row, c.account).slice(0, 80),
        card: cellOf(row, c.card).slice(0, 80),
        person: cellOf(row, c.person).slice(0, 80),
        nature: cellOf(row, c.nature).slice(0, 80),
      },
      // Sem coluna própria, a forma de pagamento pode vir da conta ("Pix Inter", "Nubank crédito").
      paymentMethod: parsePaymentMethodValue(cellOf(row, c.paymentMethod)) ?? parsePaymentMethodValue(cellOf(row, c.account)),
      paymentFromAccount: !parsePaymentMethodValue(cellOf(row, c.paymentMethod)) && Boolean(parsePaymentMethodValue(cellOf(row, c.account))),
      installment,
      status: parseStatusValue(cellOf(row, c.status)),
      notes: cellOf(row, c.notes).slice(0, 500) || null,
      balanceCents: c.balance !== null ? parseImportAmount(cellOf(row, c.balance)) : null,
      externalId: cellOf(row, c.externalId).slice(0, 120) || null,
      cells,
    });
  }
  return { rows, ignored };
}

export interface MatrixRow {
  label: string;
  key: string;
  rowNumber: number;
  /** Seção da matriz ("Receitas"/"Despesas") acima da linha. */
  section: "EXPENSE" | "INCOME" | null;
  months: Array<{ month: string; cents: number }>;
}

const INCOME_SECTION = /^(receitas?|entradas?|rendas?|ganhos?|recebimentos?|creditos?)\b/;
const EXPENSE_SECTION = /^(despesas?|saidas?|gastos?|custos?|debitos?|pagamentos?|contas)\b/;

export function readMatrixRows(sheet: RawSheet, cfg: SheetConfig): { rows: MatrixRow[]; totals: number } {
  const layout = cfg.matrix;
  if (!layout) return { rows: [], totals: 0 };
  let section: "EXPENSE" | "INCOME" | null = null;
  const rows: MatrixRow[] = [];
  let totals = 0;
  for (let i = layout.headerRowIndex + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i]!;
    const label = (r[layout.labelColumn] ?? "").trim();
    if (!label) continue;
    const months = layout.months
      .map((m) => ({ month: m.month, cents: parseImportAmount((r[m.column] ?? "").trim()) }))
      .filter((m): m is { month: string; cents: number } => m.cents !== null && m.cents !== 0);
    const n = normalizeText(label);
    if (isTotalLabel(label) || /^(media|média|soma|percentual|%)\b/.test(n)) {
      totals++;
      continue;
    }
    if (!months.length) {
      if (INCOME_SECTION.test(n)) section = "INCOME";
      else if (EXPENSE_SECTION.test(n)) section = "EXPENSE";
      continue;
    }
    rows.push({ label: label.slice(0, 80), key: valueKey(label), rowNumber: sheet.rowNumbers[i] ?? i + 1, section, months });
  }
  return { rows, totals };
}

// -----------------------------------------------------------------------------
// Montagem das linhas da prévia
// -----------------------------------------------------------------------------

export interface CategoryTarget {
  categoryId: string;
  subcategoryId: string | null;
  kind: "EXPENSE" | "INCOME";
}

export interface DestinationTarget {
  accountId: string | null;
  creditCardId: string | null;
}

/** Decisões resolvidas (ids reais). `null` = ignorar; ausente = sem decisão (também ignora). */
export interface Resolution {
  category: Map<string, CategoryTarget | null>;
  subcategory: Map<string, CategoryTarget | null>;
  account: Map<string, DestinationTarget | null>;
  card: Map<string, DestinationTarget | null>;
  person: Map<string, string | null>;
  nature: Map<string, NatureValue | null>;
}

export function subcategoryKey(category: string, subcategory: string): string {
  return `${valueKey(category)}›${valueKey(subcategory)}`;
}

export type DestinationKey = string;

export function destinationKey(d: DestinationTarget | null): DestinationKey {
  if (d?.creditCardId) return `C:${d.creditCardId}`;
  if (d?.accountId) return `A:${d.accountId}`;
  return "NONE";
}

export interface BuiltRow {
  dest: DestinationKey;
  parsed: ParsedImportRow;
  balanceCents: number | null;
  sheetIndex: number;
  order: number;
}

export interface BuildOptions {
  fileName: string;
  today: string;
  defaultAccountId: string | null;
  defaultCardId: string | null;
}

export interface BuildResult {
  rows: BuiltRow[];
  matrixRows: BuiltRow[];
  bills: PlannedBill[];
  /** Orçamentos planejados (categoria × mês → limite somado). */
  budgets: Map<string, { categoryId: string; month: string; limitCents: number }>;
  warnings: string[];
}

function categoryFor(v: SheetRowValues, res: Resolution): CategoryTarget | null {
  if (v.values.subcategory) {
    const sub = res.subcategory.get(subcategoryKey(v.values.category, v.values.subcategory));
    if (sub) return sub;
  }
  if (v.values.category) return res.category.get(valueKey(v.values.category)) ?? null;
  return null;
}

function destinationFor(v: SheetRowValues, res: Resolution, opts: BuildOptions): DestinationTarget | null {
  if (v.values.card) {
    const d = res.card.get(valueKey(v.values.card));
    if (d) return d;
  }
  if (v.values.account) {
    const d = res.account.get(valueKey(v.values.account));
    if (d) {
      // Conta escolhida, mas a linha diz "crédito": vai para o cartão padrão (compra no cartão não mexe no saldo da conta).
      if (d.accountId && v.paymentMethod === "CREDIT_CARD" && !v.paymentFromAccount) return opts.defaultCardId ? { accountId: null, creditCardId: opts.defaultCardId } : null;
      return d;
    }
  }
  if (v.paymentMethod === "CREDIT_CARD") return opts.defaultCardId ? { accountId: null, creditCardId: opts.defaultCardId } : null;
  return opts.defaultAccountId ? { accountId: opts.defaultAccountId, creditCardId: null } : null;
}

function locationNote(fileName: string, v: { sheetName: string; rowNumber: number }) {
  return `Planilha "${fileName.slice(0, 80)}", aba "${v.sheetName.slice(0, 60)}", linha ${v.rowNumber}`;
}

export function buildMigrationRows(
  sheets: Array<{ sheet: RawSheet; cfg: SheetConfig }>,
  res: Resolution,
  opts: BuildOptions & { contextYear: number },
): BuildResult {
  const out: BuiltRow[] = [];
  const matrixRows: BuiltRow[] = [];
  const bills: PlannedBill[] = [];
  const budgets = new Map<string, { categoryId: string; month: string; limitCents: number }>();
  const warnings: string[] = [];
  let order = 0;
  let signGuessed = 0;
  let transferNoCounterpart = 0;

  for (const { sheet, cfg } of sheets) {
    if (!cfg.selected) continue;
    if (cfg.kind === "MATRIX") {
      const { rows } = readMatrixRows(sheet, cfg);
      for (const r of rows) {
        const target = res.category.get(r.key) ?? null;
        for (const m of r.months) {
          const kind = target?.kind ?? r.section ?? "EXPENSE";
          if (cfg.matrixMode === "BUDGET") {
            if (!target || target.kind !== "EXPENSE") continue;
            const k = `${target.categoryId}|${m.month}`;
            const cur = budgets.get(k);
            budgets.set(k, { categoryId: target.categoryId, month: m.month, limitCents: (cur?.limitCents ?? 0) + Math.abs(m.cents) });
            continue;
          }
          if (cfg.matrixMode !== "TRANSACTIONS") continue;
          // Valor negativo numa seção de despesas é entrada (estorno) e vice-versa.
          const outflow = (kind === "EXPENSE") === m.cents > 0;
          const amount = outflow ? -Math.abs(m.cents) : Math.abs(m.cents);
          const date = `${m.month}-01`;
          const cat = target && (target.kind === "EXPENSE") === outflow ? target : null;
          matrixRows.push({
            dest: "MATRIX",
            sheetIndex: cfg.index,
            order: order++,
            balanceCents: null,
            parsed: {
              rowIndex: 0,
              date,
              amountCents: amount,
              description: `${r.label} — total de ${formatMonthBR(m.month as MonthKey)}`.slice(0, 200),
              externalId: null,
              categoryName: r.label,
              raw: { Categoria: r.label, Mês: m.month, Valor: formatBRL(Math.abs(m.cents)) },
              error: null,
              skipReason: null,
              meta: {
                categoryId: cat?.categoryId ?? null,
                subcategoryId: cat?.subcategoryId ?? null,
                consolidated: true,
                notes: `Importado de planilha (total do mês). ${locationNote(opts.fileName, { sheetName: cfg.name, rowNumber: r.rowNumber })}.`,
                location: { sheet: cfg.name, row: r.rowNumber },
              },
            },
          });
        }
      }
      continue;
    }
    if (cfg.kind !== "LIST" && cfg.kind !== "MONTH") continue;

    const { rows } = readSheetRows(sheet, cfg, opts.contextYear);
    for (const v of rows) {
      const cat = categoryFor(v, res);
      let amount = v.amountCents;
      if (amount !== null && v.signFromCategory) {
        if (cat) amount = cat.kind === "INCOME" ? Math.abs(amount) : -Math.abs(amount);
        else {
          amount = -Math.abs(amount);
          signGuessed++;
        }
      }
      const outflow = (amount ?? 0) < 0;
      const category = cat && (cat.kind === "EXPENSE") === outflow ? cat : null;
      if (v.flow === "TRANSFER") transferNoCounterpart++;
      const dest = destinationFor(v, res, opts);
      const memberId = v.values.person ? res.person.get(valueKey(v.values.person)) ?? null : null;
      const nature = v.values.nature ? res.nature.get(valueKey(v.values.nature)) ?? null : null;
      const notes = [v.notes, locationNote(opts.fileName, v)].filter(Boolean).join(" — ").slice(0, 500);

      // "A pagar" (não é movimento de caixa): vira conta a pagar/receber. No cartão, a compra já está na fatura.
      if (v.status === "TO_PAY" && !v.error && amount !== null && v.date && !dest?.creditCardId) {
        bills.push({
          type: outflow ? "EXPENSE" : "INCOME",
          description: (v.description || v.values.category || "Conta importada").slice(0, 200),
          amountCents: Math.abs(amount),
          dueDate: v.date,
          categoryId: category?.categoryId ?? null,
          accountId: dest?.accountId ?? null,
          notes,
          origin: "TO_PAY",
        });
        continue;
      }

      out.push({
        dest: destinationKey(dest),
        sheetIndex: cfg.index,
        order: order++,
        balanceCents: v.balanceCents,
        parsed: {
          rowIndex: 0,
          date: v.date,
          amountCents: amount,
          description: v.description || v.values.category || "Lançamento importado",
          externalId: v.externalId,
          categoryName: v.values.subcategory ? `${v.values.category ? `${v.values.category} › ` : ""}${v.values.subcategory}` : v.values.category || null,
          raw: v.cells,
          error: v.error,
          skipReason: null,
          meta: {
            categoryId: category?.categoryId ?? null,
            subcategoryId: category?.subcategoryId ?? null,
            payerMemberId: memberId,
            nature,
            paymentMethod: dest?.creditCardId ? "CREDIT_CARD" : v.paymentMethod,
            notes,
            location: { sheet: v.sheetName, row: v.rowNumber },
            installmentInfo: v.installment,
            baseDescription: v.baseDescription,
          },
        },
      });
    }
  }

  planInstallments(out, bills, opts.today);
  if (signGuessed) warnings.push(`${signGuessed} linha(s) sem sinal e sem categoria entraram como despesa. Se alguma for receita, escolha a categoria de receita ou ajuste na prévia.`);
  if (transferNoCounterpart) warnings.push(`${transferNoCounterpart} linha(s) marcadas como transferência: se a conta do outro lado não for reconhecida, marque a transferência na prévia ("Ver linhas").`);
  return { rows: out, matrixRows, bills, budgets, warnings };
}

/**
 * Parcelas: no cartão, "3/10" vira UMA compra parcelada a partir da parcela 3 (8 parcelas restantes:
 * as futuras entram nas próximas faturas); as linhas 4/10, 5/10… da mesma compra ficam como
 * "incluídas". "10x" (compra em 10 vezes) usa o valor da linha como o total da compra.
 * Em conta, cada parcela da planilha é um pagamento; as futuras (depois da última da planilha e a
 * partir de hoje) viram contas a pagar.
 */
function planInstallments(rows: BuiltRow[], bills: PlannedBill[], today: string) {
  const groups = new Map<string, BuiltRow[]>();
  for (const r of rows) {
    const info = r.parsed.meta.installmentInfo;
    if (!info || r.parsed.error || r.parsed.amountCents === null || !r.parsed.date) continue;
    if (info.purchaseTotal) {
      if (r.dest.startsWith("C:")) {
        r.parsed.meta.installmentPlan = { count: info.total, amountCents: Math.abs(r.parsed.amountCents), firstNumber: 1, ofTotal: info.total };
      }
      continue;
    }
    const key = `${r.dest}|${normalizeText(r.parsed.meta.baseDescription ?? r.parsed.description)}|${info.total}|${Math.abs(r.parsed.amountCents)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.parsed.meta.installmentInfo!.number - b.parsed.meta.installmentInfo!.number || (a.parsed.date ?? "").localeCompare(b.parsed.date ?? ""));
    const first = list[0]!;
    const info = first.parsed.meta.installmentInfo!;
    const per = Math.abs(first.parsed.amountCents!);
    const base = first.parsed.meta.baseDescription || first.parsed.description;
    if (first.dest.startsWith("C:")) {
      const count = info.total - info.number + 1;
      first.parsed.meta.installmentPlan = { count, amountCents: per * count, firstNumber: info.number, ofTotal: info.total };
      first.parsed.meta.installmentRef = { number: info.number, total: info.total };
      if (info.number > 1) first.parsed.description = `${base} (parcelas ${info.number} a ${info.total} de ${info.total})`.slice(0, 200);
      const seen = new Set<number>([info.number]);
      for (const r of list.slice(1)) {
        const n = r.parsed.meta.installmentInfo!.number;
        if (seen.has(n)) continue; // mesma parcela repetida: outra compra igual, segue como lançamento normal
        seen.add(n);
        r.parsed.meta.coveredBy = first.order;
        r.parsed.skipReason = `Parcela ${n}/${info.total} já incluída na compra parcelada "${base.slice(0, 60)}" (${first.parsed.meta.location?.sheet ?? "planilha"}, linha ${first.parsed.meta.location?.row ?? "?"}).`;
      }
      continue;
    }
    // Conta (ou sem destino): parcelas futuras viram contas a pagar.
    const last = list[list.length - 1]!;
    const lastInfo = last.parsed.meta.installmentInfo!;
    for (let n = lastInfo.number + 1; n <= lastInfo.total; n++) {
      const due = addMonths(last.parsed.date!, n - lastInfo.number);
      if (!isISODate(due) || due < today) continue;
      bills.push({
        type: last.parsed.amountCents! < 0 ? "EXPENSE" : "INCOME",
        description: `${base} (parcela ${n}/${lastInfo.total})`.slice(0, 200),
        amountCents: per,
        dueDate: due,
        categoryId: last.parsed.meta.categoryId ?? null,
        accountId: last.dest.startsWith("A:") ? last.dest.slice(2) : null,
        notes: `Parcela futura prevista pela planilha (última na planilha: ${lastInfo.number}/${lastInfo.total}). ${last.parsed.meta.notes ?? ""}`.slice(0, 500),
        origin: "FUTURE_INSTALLMENT",
      });
    }
  }
}
