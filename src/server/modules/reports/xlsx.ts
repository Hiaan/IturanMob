import ExcelJS from "exceljs";
import { formatDateBR, formatDateTimeBR, formatMonthBR, isoToDate } from "@/lib/dates";
import type { ExportTransactionRow } from "./csv";
import type { ReportView } from "./types";

/**
 * Exportação em XLSX (exceljs): abas Resumo, Categorias, Orçamento e Transações do período,
 * com formato de moeda R$, larguras ajustadas e cabeçalhos em negrito.
 */

export const BRL_FORMAT = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const PCT_FORMAT = '0.0"%"';
const DATE_FORMAT = "dd/mm/yyyy";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F4F1" } };
const TITLE_COLOR = "FF0F766E";

const reais = (cents: number) => cents / 100;

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FF0F172A" } };
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: "thin", color: { argb: "FF94A3B8" } } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  row.height = 20;
}

function sectionTitle(ws: ExcelJS.Worksheet, text: string) {
  ws.addRow([]);
  const row = ws.addRow([text]);
  row.font = { bold: true, size: 12, color: { argb: TITLE_COLOR } };
}

function moneyCells(row: ExcelJS.Row, columns: number[]): ExcelJS.Row {
  for (const c of columns) row.getCell(c).numFmt = BRL_FORMAT;
  return row;
}

function setWidths(ws: ExcelJS.Worksheet, widths: number[]) {
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

/** Planilha de transações (reutilizada na exportação avulsa). */
export function addTransactionsSheet(wb: ExcelJS.Workbook, rows: ExportTransactionRow[], name = "Transações do período") {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  const header = ws.addRow(["Data", "Descrição", "Categoria", "Subcategoria", "Tipo", "Valor", "Forma de pagamento", "Conta/Cartão", "Responsável", "Situação", "Relatórios"]);
  styleHeader(header);
  for (const r of rows) {
    const row = ws.addRow([isoToDate(r.date), r.description, r.category, r.subcategory, r.typeLabel, reais(r.signedAmountCents), r.paymentMethod, r.accountOrCard, r.responsible, r.status, r.reports]);
    row.getCell(1).numFmt = DATE_FORMAT;
    row.getCell(6).numFmt = BRL_FORMAT;
    if (r.deleted) row.font = { color: { argb: "FF94A3B8" }, strike: true };
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: 11 } };
  setWidths(ws, [12, 42, 20, 20, 20, 15, 22, 28, 26, 22, 34]);
  return ws;
}

export async function renderTransactionsXlsx(rows: ExportTransactionRow[], opts: { title?: string } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Finance AI";
  wb.created = new Date();
  wb.title = opts.title ?? "Transações";
  addTransactionsSheet(wb, rows, "Transações");
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function renderReportXlsx(report: ReportView, transactions: ExportTransactionRow[]): Promise<Buffer> {
  const d = report.data;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Finance AI";
  wb.created = new Date(d.generatedAt);
  wb.title = `${d.type === "WEEKLY" ? "Relatório semanal" : "Relatório mensal"} — ${d.periodLabel}`;

  // ---------------------------------------------------------------- Resumo
  const ws = wb.addWorksheet("Resumo");
  setWidths(ws, [34, 18, 18, 18, 18, 16]);
  const title = ws.addRow([wb.title]);
  title.font = { bold: true, size: 15, color: { argb: TITLE_COLOR } };
  ws.mergeCells(1, 1, 1, 5);
  ws.addRow([`Família: ${d.householdName}`]);
  ws.addRow([`Período: ${formatDateBR(d.period.start)} a ${formatDateBR(d.period.end)}${d.isPartial ? " (em andamento — valores parciais)" : ""}`]);
  ws.addRow([`Regime: ${d.regimeLabel} · Escopo: ${d.scope === "FAMILY" ? "família (sem contas privadas)" : "pessoal"}`]);
  ws.addRow([`Gerado em: ${formatDateTimeBR(d.generatedAt, d.timezone)}`]);

  sectionTitle(ws, "Totais do período (dados confirmados)");
  styleHeader(ws.addRow(["Indicador", "Valor", "Período anterior", "Variação"]));
  const cmp = d.comparison;
  const totalRows: Array<[string, number, number, number | null]> = [
    ["Receitas", d.totals.incomeCents, cmp.previousIncomeCents, cmp.incomeChangePct],
    ["Despesas", d.totals.expenseCents, cmp.previousExpenseCents, cmp.expenseChangePct],
    ["Resultado", d.totals.resultCents, cmp.previousResultCents, null],
  ];
  for (const [label, value, prev, change] of totalRows) {
    const row = ws.addRow([label, reais(value), reais(prev), change === null ? "—" : change]);
    moneyCells(row, [2, 3]);
    if (change !== null) row.getCell(4).numFmt = PCT_FORMAT;
  }

  if (d.type === "MONTHLY") {
    const row = ws.addRow(["Saldo disponível ao fim do período", reais(d.balance.availableCents)]);
    moneyCells(row, [2]);
    if (d.balance.investmentsCents) moneyCells(ws.addRow(["Investimentos", reais(d.balance.investmentsCents)]), [2]);
    if (d.previousMonths.months) {
      moneyCells(ws.addRow([`Média de despesas (${d.previousMonths.months} mês(es) anteriores)`, reais(d.previousMonths.averageExpenseCents)]), [2]);
      moneyCells(ws.addRow([`Média de receitas (${d.previousMonths.months} mês(es) anteriores)`, reais(d.previousMonths.averageIncomeCents)]), [2]);
    }

    sectionTitle(ws, "Evolução mensal");
    styleHeader(ws.addRow(["Mês", "Receitas", "Despesas", "Resultado"]));
    for (const e of d.evolution) moneyCells(ws.addRow([formatMonthBR(e.month, { capitalize: true }), reais(e.incomeCents), reais(e.expenseCents), reais(e.resultCents)]), [2, 3, 4]);

    if (d.recurringExpenses.items.length) {
      sectionTitle(ws, "Despesas recorrentes (projeção)");
      styleHeader(ws.addRow(["Descrição", "Valor", "Frequência", "Equivalente mensal", "Categoria", "Estimativa"]));
      for (const r of d.recurringExpenses.items) {
        moneyCells(ws.addRow([r.description, reais(r.amountCents), r.frequencyLabel, reais(r.monthlyEquivalentCents), r.categoryName ?? "", r.isEstimate ? "Sim" : "Não"]), [2, 4]);
      }
      moneyCells(ws.addRow(["Total mensal equivalente", null, null, reais(d.recurringExpenses.monthlyTotalCents)]), [4]);
    }

    if (d.futureInstallments.items.length) {
      sectionTitle(ws, `Parcelamentos futuros no cartão (posição em ${formatDateBR(d.futureInstallments.asOf)})`);
      styleHeader(ws.addRow(["Mês da fatura", "Valor em aberto"]));
      for (const f of d.futureInstallments.items) moneyCells(ws.addRow([formatMonthBR(f.month, { capitalize: true }), reais(f.amountCents)]), [2]);
      moneyCells(ws.addRow(["Total", reais(d.futureInstallments.totalCents)]), [2]);
    }

    if (d.goals.length) {
      sectionTitle(ws, "Metas");
      styleHeader(ws.addRow(["Meta", "Objetivo", "Acumulado", "No período", "% atingido", "Necessário/mês"]));
      for (const g of d.goals) {
        const row = ws.addRow([g.name, reais(g.targetCents), reais(g.savedCents), reais(g.contributedInPeriodCents), g.percent, g.monthlyNeededCents === null ? "—" : reais(g.monthlyNeededCents)]);
        moneyCells(row, [2, 3, 4]);
        row.getCell(5).numFmt = PCT_FORMAT;
        if (g.monthlyNeededCents !== null) row.getCell(6).numFmt = BRL_FORMAT;
      }
    }
  } else {
    sectionTitle(ws, `Contas a vencer (${formatDateBR(d.upcomingBills.from)} a ${formatDateBR(d.upcomingBills.to)})`);
    styleHeader(ws.addRow(["Descrição", "Valor", "Vencimento", "Tipo", "Situação"]));
    for (const b of d.upcomingBills.items) {
      const row = ws.addRow([
        b.description,
        reais(b.amountCents),
        isoToDate(b.date),
        b.kind === "CARD_STATEMENT" ? "Fatura de cartão" : "Conta prevista",
        b.overdue ? "Vencida" : b.certainty === "PROJECTION" ? "Previsão" : "Confirmada",
      ]);
      moneyCells(row, [2]);
      row.getCell(3).numFmt = DATE_FORMAT;
    }
    if (!d.upcomingBills.items.length) ws.addRow(["Nenhuma conta prevista no período."]);
  }

  if (d.topExpenses.length) {
    sectionTitle(ws, "Maiores despesas");
    styleHeader(ws.addRow(["Descrição", "Valor", "Data", "Categoria", "Parcelas"]));
    for (const t of d.topExpenses) {
      const row = ws.addRow([t.description, reais(t.amountCents), isoToDate(t.date), t.categoryName ?? "Sem categoria", t.installmentCount]);
      moneyCells(row, [2]);
      row.getCell(3).numFmt = DATE_FORMAT;
    }
  }

  sectionTitle(ws, "Origem do cálculo");
  ws.addRow([d.origin.summary]).alignment = { wrapText: true, vertical: "top" };
  ws.addRow(["Dados confirmados:"]).font = { bold: true };
  for (const line of d.origin.confirmed) ws.addRow([`• ${line}`]);
  ws.addRow(["Projeções e estimativas:"]).font = { bold: true };
  for (const line of d.origin.projections) ws.addRow([`• ${line}`]);

  // ------------------------------------------------------------ Categorias
  const cats = wb.addWorksheet("Categorias", { views: [{ state: "frozen", ySplit: 1 }] });
  setWidths(cats, [30, 18, 12, 18, 18, 14]);
  if (d.type === "MONTHLY") {
    styleHeader(cats.addRow(["Categoria", "Despesa no mês", "% do total", "Mês anterior", "Diferença", "Variação"]));
    const prevById = new Map(d.categoryComparison.items.map((i) => [i.categoryId ?? "none", i]));
    for (const c of d.topCategories) {
      const prev = prevById.get(c.categoryId ?? "none");
      const row = cats.addRow([c.name, reais(c.amountCents), c.percent, reais(prev?.previousCents ?? 0), reais(c.amountCents - (prev?.previousCents ?? 0)), prev?.changePct ?? "—"]);
      moneyCells(row, [2, 4, 5]);
      row.getCell(3).numFmt = PCT_FORMAT;
      if (typeof prev?.changePct === "number") row.getCell(6).numFmt = PCT_FORMAT;
    }
    moneyCells(cats.addRow(["Total", reais(d.totals.expenseCents)]), [2]).font = { bold: true };
    if (d.incomeCategories.length) {
      cats.addRow([]);
      styleHeader(cats.addRow(["Receitas por categoria", "Valor", "% do total"]));
      for (const c of d.incomeCategories) {
        const row = cats.addRow([c.name, reais(c.amountCents), c.percent]);
        moneyCells(row, [2]);
        row.getCell(3).numFmt = PCT_FORMAT;
      }
    }
  } else {
    styleHeader(cats.addRow(["Categoria", "Despesa na semana", "% do total"]));
    for (const c of d.topCategories) {
      const row = cats.addRow([c.name, reais(c.amountCents), c.percent]);
      moneyCells(row, [2]);
      row.getCell(3).numFmt = PCT_FORMAT;
    }
    moneyCells(cats.addRow(["Total de despesas", reais(d.totals.expenseCents)]), [2]);
  }

  // ------------------------------------------------------------- Orçamento
  const bud = wb.addWorksheet("Orçamento", { views: [{ state: "frozen", ySplit: 1 }] });
  setWidths(bud, [30, 16, 16, 16, 12, 20]);
  if (d.type === "MONTHLY" && d.budget.items.length) {
    styleHeader(bud.addRow(["Categoria", "Previsto", "Realizado", "Disponível", "% usado", "Projeção fim do mês"]));
    for (const b of d.budget.items) {
      const row = bud.addRow([b.name, reais(b.limitCents), reais(b.spentCents), reais(b.remainingCents), b.percentUsed, reais(b.projectedCents)]);
      moneyCells(row, [2, 3, 4, 6]);
      row.getCell(5).numFmt = PCT_FORMAT;
      if (b.percentUsed > 100) row.getCell(5).font = { color: { argb: "FFB91C1C" }, bold: true };
    }
    moneyCells(bud.addRow(["Total", reais(d.budget.totalLimitCents), reais(d.budget.totalSpentCents), reais(d.budget.totalAvailableCents)]), [2, 3, 4]).font = {
      bold: true,
    };
  } else {
    styleHeader(bud.addRow(["Orçamento"]));
    bud.addRow([d.type === "WEEKLY" ? "O orçamento é mensal — consulte o relatório mensal." : "Nenhum orçamento definido para este mês."]);
  }

  // ---------------------------------------------- Transações do período
  addTransactionsSheet(wb, transactions);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
