import PDFDocument from "pdfkit";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatDateTimeBR, formatMonthBR } from "@/lib/dates";
import type { MonthlyReportData, ReportData, ReportView, WeeklyReportData } from "./types";

/**
 * Relatório em PDF (pdfkit, A4): cabeçalho, indicadores, tabelas, barras horizontais desenhadas
 * com primitivas do pdfkit, rodapé com data de geração e paginação. Textos em português.
 */

type Doc = PDFKit.PDFDocument;
type Align = "left" | "right" | "center";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 46;
const CW = PAGE_W - 2 * M;
const BOTTOM = PAGE_H - M - 22;

const C = {
  primary: "#0f766e",
  primaryDark: "#134e4a",
  primarySoft: "#e6f4f1",
  text: "#0f172a",
  muted: "#64748b",
  border: "#e2e8f0",
  zebra: "#f8fafc",
  income: "#047857",
  expense: "#b91c1c",
  warn: "#b45309",
  barBg: "#edf2f7",
  projection: "#6d28d9",
  white: "#ffffff",
};

const pct = (v: number | null | undefined, signed = false) => {
  if (v === null || v === undefined) return "—";
  const s = `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  return signed && v > 0 ? `+${s}` : s;
};

class PdfWriter {
  constructor(readonly doc: Doc) {}

  font(bold: boolean, size: number, color = C.text) {
    this.doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    return this;
  }

  /** Corta o texto com reticências para caber na largura. */
  fit(text: string, width: number): string {
    const t = text.replace(/\s+/g, " ").trim();
    if (this.doc.widthOfString(t) <= width) return t;
    let lo = 0;
    let hi = t.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.doc.widthOfString(`${t.slice(0, mid)}…`) <= width) lo = mid;
      else hi = mid - 1;
    }
    return `${t.slice(0, lo)}…`;
  }

  cell(text: string, x: number, y: number, width: number, align: Align = "left") {
    this.doc.text(this.fit(text, width), x, y, { width, align, lineBreak: false });
  }

  ensure(height: number) {
    if (this.doc.y + height > BOTTOM) {
      this.doc.addPage();
      this.doc.y = M;
    }
  }

  section(title: string, tag?: { text: string; color: string }) {
    // Evita título órfão no fim da página (título + cabeçalho + primeiras linhas).
    this.ensure(96);
    this.doc.y += 12;
    const y = this.doc.y;
    this.font(true, 12.5, C.primaryDark);
    this.doc.text(title, M, y, { lineBreak: false });
    if (tag) {
      const w = this.doc.widthOfString(title);
      this.font(true, 7.5, tag.color);
      const tw = this.doc.widthOfString(tag.text) + 10;
      this.doc.roundedRect(M + w + 8, y + 1.5, tw, 12, 3).fillOpacity(0.1).fill(tag.color).fillOpacity(1);
      this.font(true, 7.5, tag.color);
      this.doc.text(tag.text, M + w + 13, y + 4, { lineBreak: false });
    }
    this.doc.moveTo(M, y + 18).lineTo(M + CW, y + 18).lineWidth(0.6).strokeColor(C.border).stroke();
    this.doc.y = y + 26;
  }

  paragraph(text: string, opts: { size?: number; color?: string; bold?: boolean; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 9;
    const indent = opts.indent ?? 0;
    this.font(Boolean(opts.bold), size, opts.color ?? C.text);
    const h = this.doc.heightOfString(text, { width: CW - indent });
    this.ensure(h + 2);
    this.font(Boolean(opts.bold), size, opts.color ?? C.text);
    this.doc.text(text, M + indent, this.doc.y, { width: CW - indent });
    this.doc.y += opts.gap ?? 2;
  }

  note(text: string) {
    this.paragraph(text, { size: 8.5, color: C.muted, gap: 4 });
  }

  kpis(items: Array<{ label: string; value: string; color?: string; sub?: string }>) {
    const gap = 10;
    const h = 60;
    this.ensure(h + 8);
    const w = (CW - gap * (items.length - 1)) / items.length;
    const y = this.doc.y;
    items.forEach((it, i) => {
      const x = M + i * (w + gap);
      this.doc.roundedRect(x, y, w, h, 6).lineWidth(0.8).fillAndStroke(C.white, C.border);
      this.doc.rect(x, y + 8, 3, h - 16).fill(it.color ?? C.primary);
      this.font(false, 7.5, C.muted);
      this.cell(it.label.toUpperCase(), x + 12, y + 10, w - 20);
      this.font(true, 15, it.color ?? C.text);
      this.cell(it.value, x + 12, y + 23, w - 20);
      if (it.sub) {
        this.font(false, 7.5, C.muted);
        this.cell(it.sub, x + 12, y + 43, w - 20);
      }
    });
    this.doc.y = y + h + 8;
  }

  table(columns: Array<{ header: string; width: number; align?: Align }>, rows: string[][], opts: { boldLast?: boolean; colors?: Array<Array<string | undefined>> } = {}) {
    const rowH = 16;
    const total = columns.reduce((s, c) => s + c.width, 0);
    const scale = CW / total;
    const cols = columns.map((c) => ({ ...c, width: c.width * scale }));
    const drawHeader = () => {
      const y = this.doc.y;
      this.doc.rect(M, y, CW, rowH + 2).fill(C.primarySoft);
      this.font(true, 8, C.primaryDark);
      let x = M;
      for (const c of cols) {
        this.cell(c.header, x + 5, y + 5, c.width - 10, c.align);
        x += c.width;
      }
      this.doc.y = y + rowH + 2;
    };
    this.ensure(rowH * 2 + 4);
    drawHeader();
    rows.forEach((row, ri) => {
      if (this.doc.y + rowH > BOTTOM) {
        this.doc.addPage();
        this.doc.y = M;
        drawHeader();
      }
      const y = this.doc.y;
      const last = opts.boldLast && ri === rows.length - 1;
      if (last) this.doc.rect(M, y, CW, rowH).fill(C.primarySoft);
      else if (ri % 2 === 1) this.doc.rect(M, y, CW, rowH).fill(C.zebra);
      let x = M;
      cols.forEach((c, ci) => {
        this.font(Boolean(last), 8.5, opts.colors?.[ri]?.[ci] ?? C.text);
        this.cell(row[ci] ?? "", x + 5, y + 4.5, c.width - 10, c.align);
        x += c.width;
      });
      this.doc.y = y + rowH;
    });
    this.doc.moveTo(M, this.doc.y).lineTo(M + CW, this.doc.y).lineWidth(0.5).strokeColor(C.border).stroke();
    this.doc.y += 6;
  }

  /** Barras horizontais proporcionais ao maior valor. */
  bars(items: Array<{ label: string; valueCents: number; color?: string; right?: string }>) {
    const rowH = 19;
    const labelW = 150;
    const rightW = 120;
    const barX = M + labelW + 8;
    const barW = CW - labelW - rightW - 16;
    const max = Math.max(1, ...items.map((i) => i.valueCents));
    for (const it of items) {
      this.ensure(rowH);
      const y = this.doc.y;
      this.font(false, 8.5, C.text);
      this.cell(it.label, M, y + 4, labelW);
      this.doc.roundedRect(barX, y + 4, barW, 9, 2).fill(C.barBg);
      const w = Math.max(2, (it.valueCents / max) * barW);
      this.doc.roundedRect(barX, y + 4, w, 9, 2).fill(it.color ?? C.primary);
      this.font(true, 8.5, C.text);
      this.cell(it.right ?? formatBRL(it.valueCents), barX + barW + 8, y + 4, rightW, "right");
      this.doc.y = y + rowH;
    }
    this.doc.y += 4;
  }

  /** Barras de orçamento: realizado sobre o previsto (marcador no limite). */
  budgetBars(items: Array<{ label: string; limitCents: number; spentCents: number; percent: number }>) {
    const rowH = 24;
    const labelW = 140;
    const rightW = 150;
    const barX = M + labelW + 8;
    const barW = CW - labelW - rightW - 16;
    for (const it of items) {
      this.ensure(rowH);
      const y = this.doc.y;
      const scaleMax = Math.max(it.limitCents, it.spentCents, 1);
      this.font(false, 8.5, C.text);
      this.cell(it.label, M, y + 6, labelW);
      this.doc.roundedRect(barX, y + 5, barW, 11, 3).fill(C.barBg);
      const color = it.percent > 100 ? C.expense : it.percent >= 80 ? C.warn : C.income;
      const w = Math.max(2, (it.spentCents / scaleMax) * barW);
      this.doc.roundedRect(barX, y + 5, w, 11, 3).fill(color);
      const limitX = barX + (it.limitCents / scaleMax) * barW;
      this.doc.moveTo(limitX, y + 2).lineTo(limitX, y + 19).lineWidth(1.2).strokeColor(C.text).stroke();
      this.font(true, 8, color);
      this.cell(`${formatBRL(it.spentCents)} de ${formatBRL(it.limitCents)} (${pct(it.percent)})`, barX + barW + 8, y + 6, rightW, "right");
      this.doc.y = y + rowH;
    }
    this.font(false, 7.5, C.muted);
    this.ensure(14);
    this.doc.text("Linha vertical = valor previsto. Verde: até 80% · Âmbar: 80% a 100% · Vermelho: acima do previsto.", M, this.doc.y, { width: CW });
    this.doc.y += 4;
  }

  /** Gráfico de colunas agrupadas (receitas × despesas por mês). */
  evolutionChart(items: Array<{ label: string; income: number; expense: number }>) {
    const h = 130;
    this.ensure(h + 34);
    const top = this.doc.y + 4;
    const baseY = top + h;
    const max = Math.max(1, ...items.flatMap((i) => [i.income, i.expense]));
    const groupW = CW / Math.max(1, items.length);
    const barW = Math.min(18, groupW / 3.2);
    for (let g = 0; g <= 4; g++) {
      const gy = baseY - (h * g) / 4;
      this.doc.moveTo(M, gy).lineTo(M + CW, gy).lineWidth(0.4).strokeColor(C.border).stroke();
    }
    items.forEach((it, i) => {
      const cx = M + groupW * i + groupW / 2;
      const ih = (it.income / max) * h;
      const eh = (it.expense / max) * h;
      if (ih > 0) this.doc.rect(cx - barW - 1, baseY - ih, barW, ih).fill(C.income);
      if (eh > 0) this.doc.rect(cx + 1, baseY - eh, barW, eh).fill(C.expense);
      this.font(false, 7.5, C.muted);
      this.cell(it.label, cx - groupW / 2, baseY + 4, groupW, "center");
    });
    const ly = baseY + 16;
    this.doc.rect(M, ly + 1, 8, 8).fill(C.income);
    this.font(false, 8, C.text);
    this.doc.text("Receitas", M + 12, ly, { lineBreak: false });
    this.doc.rect(M + 70, ly + 1, 8, 8).fill(C.expense);
    this.font(false, 8, C.text);
    this.doc.text("Despesas", M + 82, ly, { lineBreak: false });
    this.font(false, 7.5, C.muted);
    this.doc.text(`Escala até ${formatBRL(max)}`, M, ly, { width: CW, align: "right", lineBreak: false });
    this.doc.y = ly + 18;
  }

  /** Barras de progresso (metas). */
  progress(items: Array<{ label: string; percent: number; right: string; sub?: string }>) {
    const rowH = 30;
    for (const it of items) {
      this.ensure(rowH);
      const y = this.doc.y;
      this.font(true, 8.5, C.text);
      this.cell(it.label, M, y + 2, CW * 0.55);
      this.font(false, 8.5, C.muted);
      this.cell(it.right, M + CW * 0.55, y + 2, CW * 0.45, "right");
      this.doc.roundedRect(M, y + 14, CW, 7, 3).fill(C.barBg);
      this.doc.roundedRect(M, y + 14, Math.max(2, (Math.min(100, it.percent) / 100) * CW), 7, 3).fill(it.percent >= 100 ? C.income : C.primary);
      if (it.sub) {
        this.font(false, 7.5, C.muted);
        this.cell(it.sub, M, y + 22.5, CW);
      }
      this.doc.y = y + rowH + (it.sub ? 4 : 0);
    }
  }
}

// -----------------------------------------------------------------------------
// Seções
// -----------------------------------------------------------------------------

function header(w: PdfWriter, d: ReportData) {
  const doc = w.doc;
  doc.rect(0, 0, PAGE_W, 112).fill(C.primary);
  doc.rect(0, 112, PAGE_W, 3).fill(C.primaryDark);
  w.font(false, 9, "#ccfbf1");
  doc.text("FINANCE AI · RELATÓRIO FINANCEIRO FAMILIAR", M, 26, { lineBreak: false, characterSpacing: 0.6 });
  w.font(true, 21, C.white);
  doc.text(d.type === "WEEKLY" ? "Relatório semanal" : "Relatório mensal", M, 42, { lineBreak: false });
  w.font(false, 12, C.white);
  doc.text(d.periodLabel + (d.isPartial ? " (em andamento)" : ""), M, 70, { lineBreak: false });
  w.font(false, 8.5, "#ccfbf1");
  const right = [
    d.householdName,
    `Regime: ${d.regimeLabel}`,
    d.scope === "FAMILY" ? "Escopo: família (sem contas privadas)" : "Escopo: pessoal",
    `${formatDateBR(d.period.start)} a ${formatDateBR(d.period.end)}`,
  ];
  right.forEach((line, i) => {
    w.cell(line, M + CW * 0.5, 30 + i * 13, CW * 0.5, "right");
  });
  doc.y = 132;
}

function categoriesSection(w: PdfWriter, d: ReportData, limit: number) {
  w.section(d.type === "WEEKLY" ? "Principais categorias" : "Maiores categorias de despesa");
  const items = d.topCategories.slice(0, limit);
  if (!items.length) {
    w.note("Nenhuma despesa confirmada no período.");
    return;
  }
  w.bars(items.map((c) => ({ label: c.name, valueCents: c.amountCents, color: c.color, right: `${formatBRL(c.amountCents)} · ${pct(c.percent)}` })));
  if (d.topCategories.length > limit) w.note(`Outras ${d.topCategories.length - limit} categorias somam ${formatBRL(d.topCategories.slice(limit).reduce((s, c) => s + c.amountCents, 0))}.`);
}

function topExpensesSection(w: PdfWriter, d: ReportData) {
  w.section("Maiores despesas");
  if (!d.topExpenses.length) {
    w.note("Nenhuma despesa confirmada no período.");
    return;
  }
  w.table(
    [
      { header: "Data", width: 60 },
      { header: "Descrição", width: 210 },
      { header: "Categoria", width: 120 },
      { header: "Parcelas", width: 55, align: "center" },
      { header: "Valor", width: 85, align: "right" },
    ],
    d.topExpenses.map((t) => [formatDateBR(t.date), t.description, t.categoryName ?? "Sem categoria", t.installmentCount > 1 ? `${t.installmentCount}x` : "—", formatBRL(t.amountCents)]),
  );
  if (d.regime === "CASH") w.note("No regime de caixa, compras parceladas aparecem pelo valor das parcelas que vencem no período.");
}

function originSection(w: PdfWriter, d: ReportData) {
  w.section("Origem do cálculo");
  w.paragraph(d.origin.summary, { size: 8.5, color: C.text, gap: 6 });
  w.paragraph("Dados confirmados", { size: 8.5, bold: true, color: C.income });
  for (const line of d.origin.confirmed) w.paragraph(`•  ${line}`, { size: 8.2, color: C.muted, indent: 6 });
  w.doc.y += 4;
  w.paragraph("Projeções e estimativas", { size: 8.5, bold: true, color: C.projection });
  for (const line of d.origin.projections) w.paragraph(`•  ${line}`, { size: 8.2, color: C.muted, indent: 6 });
}

function weeklyBody(w: PdfWriter, d: WeeklyReportData) {
  const cmp = d.comparison;
  w.kpis([
    { label: "Total recebido", value: formatBRL(d.totals.incomeCents), color: C.income, sub: `Semana anterior: ${formatBRL(cmp.previousIncomeCents)}` },
    { label: "Total gasto", value: formatBRL(d.totals.expenseCents), color: C.expense, sub: `Variação: ${pct(cmp.expenseChangePct, true)}` },
    {
      label: "Resultado",
      value: formatBRL(d.totals.resultCents, { signed: true }),
      color: d.totals.resultCents >= 0 ? C.primary : C.expense,
      sub: `${d.recognizedTransactions} lançamento(s) no período`,
    },
  ]);
  categoriesSection(w, d, 5);

  w.section("Comparação com a semana anterior");
  w.table(
    [
      { header: "Indicador", width: 160 },
      { header: "Esta semana", width: 110, align: "right" },
      { header: `Semana anterior (${formatDateBR(cmp.previousPeriod.start)})`, width: 150, align: "right" },
      { header: "Variação", width: 90, align: "right" },
    ],
    [
      ["Recebido", formatBRL(d.totals.incomeCents), formatBRL(cmp.previousIncomeCents), pct(cmp.incomeChangePct, true)],
      ["Gasto", formatBRL(d.totals.expenseCents), formatBRL(cmp.previousExpenseCents), pct(cmp.expenseChangePct, true)],
      ["Resultado", formatBRL(d.totals.resultCents, { signed: true }), formatBRL(cmp.previousResultCents, { signed: true }), formatBRL(cmp.resultChangeCents, { signed: true })],
    ],
  );

  const bills = d.upcomingBills;
  w.section(`Contas a vencer (${formatDateBR(bills.from)} a ${formatDateBR(bills.to)})`, { text: "PROJEÇÃO", color: C.projection });
  if (!bills.items.length) {
    w.note("Nenhuma conta prevista ou fatura em aberto para os próximos 7 dias.");
  } else {
    const rows = bills.items.map((b) => [
      formatDateBR(b.date),
      b.description,
      b.kind === "CARD_STATEMENT" ? "Fatura de cartão" : "Conta prevista",
      b.overdue ? "Vencida" : b.certainty === "PROJECTION" ? "Previsão" : "Confirmada",
      formatBRL(b.amountCents),
    ]);
    rows.push(["", "Total", "", "", formatBRL(bills.totalCents)]);
    w.table(
      [
        { header: "Vencimento", width: 70 },
        { header: "Descrição", width: 200 },
        { header: "Tipo", width: 100 },
        { header: "Situação", width: 75 },
        { header: "Valor", width: 85, align: "right" },
      ],
      rows,
      { boldLast: true, colors: bills.items.map((b) => [undefined, undefined, undefined, b.overdue ? C.expense : undefined, undefined]) },
    );
    if (bills.overdueCount) w.note(`${bills.overdueCount} conta(s) vencida(s) ainda em aberto aparecem na lista.`);
  }
  topExpensesSection(w, d);
}

function monthlyBody(w: PdfWriter, d: MonthlyReportData) {
  const cmp = d.comparison;
  w.kpis([
    { label: "Receitas", value: formatBRL(d.totals.incomeCents), color: C.income, sub: `Mês anterior: ${formatBRL(cmp.previousIncomeCents)} (${pct(cmp.incomeChangePct, true)})` },
    { label: "Despesas", value: formatBRL(d.totals.expenseCents), color: C.expense, sub: `Mês anterior: ${formatBRL(cmp.previousExpenseCents)} (${pct(cmp.expenseChangePct, true)})` },
    { label: "Resultado do mês", value: formatBRL(d.totals.resultCents, { signed: true }), color: d.totals.resultCents >= 0 ? C.primary : C.expense, sub: `${d.recognizedTransactions} lançamento(s)` },
  ]);
  w.kpis([
    { label: `Saldo disponível em ${formatDateBR(d.balance.asOf)}`, value: formatBRL(d.balance.availableCents), color: C.primaryDark, sub: d.balance.investmentsCents ? `Investimentos: ${formatBRL(d.balance.investmentsCents)}` : "Contas incluídas nos totais" },
    {
      label: "Média mensal de gastos",
      value: d.previousMonths.months ? formatBRL(d.previousMonths.averageExpenseCents) : "—",
      color: C.muted,
      sub: d.previousMonths.months ? `Base: ${d.previousMonths.months} mês(es) anterior(es)` : "Sem histórico suficiente",
    },
    { label: "Parcelas futuras no cartão", value: formatBRL(d.futureInstallments.totalCents), color: C.projection, sub: "Projeção (faturas a vencer)" },
  ]);

  w.section("Evolução mensal (últimos 6 meses)");
  w.evolutionChart(d.evolution.map((e) => ({ label: formatMonthBR(e.month, { short: true }), income: e.incomeCents, expense: e.expenseCents })));
  w.table(
    [
      { header: "Mês", width: 120 },
      { header: "Receitas", width: 110, align: "right" },
      { header: "Despesas", width: 110, align: "right" },
      { header: "Resultado", width: 110, align: "right" },
    ],
    d.evolution.map((e) => [formatMonthBR(e.month, { capitalize: true }), formatBRL(e.incomeCents), formatBRL(e.expenseCents), formatBRL(e.resultCents, { signed: true })]),
    { colors: d.evolution.map((e) => [undefined, undefined, undefined, e.resultCents < 0 ? C.expense : C.income]) },
  );

  categoriesSection(w, d, 10);

  w.section(`Comparação por categoria com ${formatMonthBR(d.categoryComparison.previousPeriod.start.slice(0, 7))}`);
  const cc = d.categoryComparison.items.slice(0, 10);
  if (!cc.length) {
    w.note("Sem despesas nos dois períodos.");
  } else {
    w.table(
      [
        { header: "Categoria", width: 170 },
        { header: "Este mês", width: 95, align: "right" },
        { header: "Mês anterior", width: 95, align: "right" },
        { header: "Diferença", width: 95, align: "right" },
        { header: "Variação", width: 65, align: "right" },
      ],
      cc.map((i) => [i.name, formatBRL(i.currentCents), formatBRL(i.previousCents), formatBRL(i.differenceCents, { signed: true }), pct(i.changePct, true)]),
      { colors: cc.map((i) => [undefined, undefined, undefined, i.differenceCents > 0 ? C.expense : i.differenceCents < 0 ? C.income : undefined, undefined]) },
    );
  }

  w.section("Orçamento: previsto × realizado");
  if (!d.budget.items.length) {
    w.note("Nenhum orçamento definido para este mês.");
  } else {
    w.budgetBars(d.budget.items.map((b) => ({ label: b.name, limitCents: b.limitCents, spentCents: b.spentCents, percent: b.percentUsed })));
    w.note(
      `Total: ${formatBRL(d.budget.totalSpentCents)} realizados de ${formatBRL(d.budget.totalLimitCents)} previstos.` +
        (d.budget.items.some((b) => b.projectionIsEstimate) ? " Projeção de fim de mês pela média diária (estimativa)." : ""),
    );
  }

  w.section("Despesas recorrentes", { text: "PROJEÇÃO", color: C.projection });
  if (!d.recurringExpenses.items.length) {
    w.note("Nenhuma despesa recorrente ativa.");
  } else {
    const rows = d.recurringExpenses.items.slice(0, 20).map((r) => [r.description + (r.isEstimate ? " (estimativa)" : ""), r.categoryName ?? "—", r.frequencyLabel, formatBRL(r.amountCents), formatBRL(r.monthlyEquivalentCents)]);
    rows.push(["Total mensal equivalente", "", "", "", formatBRL(d.recurringExpenses.monthlyTotalCents)]);
    w.table(
      [
        { header: "Descrição", width: 180 },
        { header: "Categoria", width: 100 },
        { header: "Frequência", width: 75 },
        { header: "Valor", width: 80, align: "right" },
        { header: "Por mês", width: 85, align: "right" },
      ],
      rows,
      { boldLast: true },
    );
  }

  w.section("Parcelamentos futuros no cartão", { text: "PROJEÇÃO", color: C.projection });
  if (!d.futureInstallments.items.length) {
    w.note("Nenhuma parcela futura em aberto.");
  } else {
    w.bars(d.futureInstallments.items.map((f) => ({ label: formatMonthBR(f.month, { capitalize: true }), valueCents: f.amountCents, color: C.projection })));
    w.note(`Total: ${formatBRL(d.futureInstallments.totalCents)} — saldo em aberto das faturas a vencer, na posição de ${formatDateBR(d.futureInstallments.asOf)}.`);
  }

  w.section("Metas");
  if (!d.goals.length) {
    w.note("Nenhuma meta ativa.");
  } else {
    w.progress(
      d.goals.map((g) => ({
        label: g.name,
        percent: g.percent,
        right: `${formatBRL(g.savedCents)} de ${formatBRL(g.targetCents)} (${pct(g.percent)})`,
        sub: [
          g.contributedInPeriodCents ? `No mês: ${formatBRL(g.contributedInPeriodCents, { signed: true })}` : "Sem contribuições no mês",
          g.deadline ? `Prazo: ${formatDateBR(g.deadline)}` : null,
          g.monthlyNeededCents ? `Necessário: ${formatBRL(g.monthlyNeededCents)}/mês (projeção)` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    );
  }

  topExpensesSection(w, d);
}

function footer(w: PdfWriter, d: ReportData) {
  const doc = w.doc;
  const range = doc.bufferedPageRange();
  const generated = formatDateTimeBR(d.generatedAt, d.timezone);
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = PAGE_H - M + 8;
    doc.moveTo(M, y - 6).lineTo(M + CW, y - 6).lineWidth(0.5).strokeColor(C.border).stroke();
    w.font(false, 7.5, C.muted);
    doc.text(`Gerado em ${generated} · Finance AI · ${d.householdName}`, M, y, { width: CW * 0.75, lineBreak: false });
    doc.text(`Página ${i - range.start + 1} de ${range.count}`, M + CW * 0.75, y, { width: CW * 0.25, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
}

export async function renderReportPdf(report: ReportView): Promise<Buffer> {
  const d = report.data;
  const doc = new PDFDocument({
    size: "A4",
    margin: M,
    bufferPages: true,
    info: {
      Title: `${d.type === "WEEKLY" ? "Relatório semanal" : "Relatório mensal"} — ${d.periodLabel}`,
      Author: "Finance AI",
      Subject: `Relatório financeiro — ${d.householdName}`,
      Creator: "Finance AI",
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const w = new PdfWriter(doc);
  header(w, d);
  if (d.type === "WEEKLY") weeklyBody(w, d);
  else monthlyBody(w, d);
  originSection(w, d);
  footer(w, d);
  doc.end();
  return done;
}
