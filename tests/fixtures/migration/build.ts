import ExcelJS from "exceljs";

/**
 * Planilhas de teste da migração (dados de teste, não de pessoas reais). Usadas pelos testes em
 * memória e gravadas em tests/fixtures/migration por scripts/build-migration-fixtures.ts
 * (as versões .xls/.ods/.csv são convertidas pelo LibreOffice).
 */

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 1) Lista simples: data, descrição, valor com sinal e categoria. */
export async function simpleList(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Extrato");
  ws.addRow(["Data", "Descrição", "Valor", "Categoria"]);
  const rows: Array<[string, string, number, string]> = [
    ["2025-01-05", "Supermercado Pão de Açúcar", -320.45, "Supermercado"],
    ["2025-01-06", "Salário", 5200, "Salário"],
    ["2025-01-08", "Posto Shell", -180, "Combustível"],
    ["2025-01-10", "Drogaria São Paulo", -64.9, "Farmácia"],
    ["2025-01-12", "Restaurante Outback", -210.3, "Restaurante"],
    ["2025-01-15", "Uber", -23.5, "Transporte"],
    ["2025-01-20", "Conta de luz", -189.77, "Luz"],
    ["2025-02-02", "Supermercado Extra", -280, "Supermercado"],
    ["2025-02-05", "Salário", 5200, "Salário"],
    ["2025-02-09", "Netflix", -55.9, "Assinaturas"],
  ];
  for (const [date, desc, value, cat] of rows) ws.addRow([d(date), desc, value, cat]);
  ws.getColumn(1).numFmt = "dd/mm/yyyy";
  ws.getColumn(3).numFmt = "#,##0.00";
  return toBuffer(wb);
}

/** 2) Abas mensais só com o dia (o mês vem do nome da aba), valores sem sinal, total e resumo. */
export async function monthlySheets(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const months: Array<[string, Array<[number, string, number, string]>]> = [
    ["Janeiro 2025", [[3, "Padaria", 18.5, "Padaria"], [7, "Mercado", 412.3, "Mercado"], [15, "Gasolina", 200, "Combustível"], [22, "Cinema", 60, "Lazer"]]],
    ["Fevereiro 2025", [[5, "Salário", 5000, "Salário"], [8, "Mercado", 389.9, "Mercado"], [14, "Farmácia", 45.2, "Farmácia"]]],
    ["Março", [[2, "Padaria", 21, "Padaria"], [10, "Mercado", 401.15, "Mercado"], [28, "Pet shop", 75, "Pets"]]],
  ];
  for (const [name, rows] of months) {
    const ws = wb.addWorksheet(name);
    ws.addRow(["Dia", "Gasto", "Valor", "Categoria"]);
    for (const r of rows) ws.addRow(r);
    ws.addRow(["Total", "", rows.reduce((s, r) => s + r[2], 0), ""]);
    ws.getColumn(3).numFmt = "#,##0.00";
  }
  const resumo = wb.addWorksheet("Resumo");
  resumo.addRow(["Mês", "Total"]);
  resumo.addRow(["Janeiro", { formula: "'Janeiro 2025'!C6", result: 690.8 }]);
  resumo.addRow(["Fevereiro", { formula: "'Fevereiro 2025'!C5", result: 5435.1 }]);
  return toBuffer(wb);
}

/** 3) Matriz categorias × meses (orçamento), com seções e linha de total. */
export async function categoryMatrix(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Orçamento 2025");
  ws.addRow(["Categoria", "Jan/25", "Fev/25", "Mar/25", "Total"]);
  ws.addRow(["Despesas"]);
  ws.addRow(["Mercado", 800, 850, 900, 2550]);
  ws.addRow(["Luz", 150, 160, 155, 465]);
  ws.addRow(["Lazer", 200, null, 300, 500]);
  ws.addRow(["Total despesas", 1150, 1010, 1355, 3515]);
  ws.addRow(["Receitas"]);
  ws.addRow(["Salário", 5000, 5000, 5000, 15000]);
  return toBuffer(wb);
}

/**
 * 4) Planilha "bagunçada": capa, título antes do cabeçalho, várias contas e um cartão, natureza
 * PF/PJ, parcelas (3/10 e 10x), "a pagar", linhas de total/subtotal/saldo, coluna de saldo,
 * nomes de categoria diferentes dos do app, aba de gráfico e aba oculta de listas.
 */
export async function messySheet(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const capa = wb.addWorksheet("Capa");
  capa.addRow(["Controle Financeiro — Família de teste"]);
  capa.addRow(["Atualizado em", "jan/2025"]);
  capa.addRow(["Obs.: valores em reais"]);

  const ws = wb.addWorksheet("Lançamentos 2025");
  ws.addRow(["CONTROLE DE GASTOS 2025"]);
  ws.addRow([]);
  ws.addRow(["Data", "Histórico", "Conta / Cartão", "Categoria", "Subcategoria", "Valor (R$)", "Tipo", "PF/PJ", "Parcela", "Status", "Saldo", "Quem", "Obs"]);
  type R = [string | null, string, string, string, string, number | null, string, string, string, string, number | null, string, string];
  const rows: R[] = [
    ["2025-01-03", "Salário empresa", "itau", "Salario", "", 6000, "Entrada", "PF", "", "Pago", 8000, "João", ""],
    ["2025-01-05", "Supermercado Extra", "itau", "Supermercado", "", 150, "Saída", "PF", "", "Pago", 7850, "Maria", ""],
    ["2025-01-08", "Posto Ipiranga", "Nubank Crédito", "Combustivel", "", 220, "Saída", "Pessoal", "", "Pago", null, "João", ""],
    ["2025-01-10", "Aplicação poupança", "itau", "Investimento", "", 500, "Saída", "PF", "", "Pago", 7350, "", ""],
    ["2025-01-10", "Aplicação recebida", "Poupança", "Investimento", "", 500, "Entrada", "PF", "", "Pago", null, "", ""],
    ["2025-01-15", "Conta de luz", "itau", "Luz", "", 189.77, "Saída", "PF", "", "Pago", 7160.23, "", ""],
    ["2025-01-20", "Restaurante Japonês", "Nubank Crédito", "Restaurante", "", 132.5, "Saída", "PF", "", "Pago", null, "Maria", ""],
    ["2025-01-25", "Serviço cliente Acme", "Inter PJ", "Cliente", "", 3500, "Entrada", "PJ", "", "Pago", null, "João", "NF 123"],
    [null, "Total Janeiro", "", "", "", 10692.27, "", "", "", "", null, "", ""],
    ["2025-02-05", "Pagamento fatura Nubank", "itau", "Cartão", "", 352.5, "Saída", "PF", "", "Pago", 6807.73, "", ""],
    ["2025-02-05", "Ração do Rex", "Dinheiro", "Pets", "", 89.9, "Saída", "Pessoal", "", "Pago", null, "Maria", ""],
    ["2025-02-10", "Notebook Dell", "Nubank Crédito", "Eletrônicos", "", 5000, "Saída", "PF", "10x", "Pago", null, "João", ""],
    ["2025-02-18", "Presente aniversário", "Dinheiro", "Diversos", "", 120, "Saída", "PF", "", "Pago", null, "", ""],
    ["2025-03-05", "Geladeira Brastemp (3/10)", "Nubank Crédito", "Casa", "", 250, "Saída", "PF", "3/10", "Pago", null, "", ""],
    ["2025-03-12", "Petshop banho", "Dinheiro", "Pets", "", 60, "Saída", "PF", "", "Pago", null, "", ""],
    ["2025-03-20", "Conta de água", "itau", "Água", "", 95.4, "Saída", "PF", "", "A pagar", null, "", ""],
    ["2025-04-05", "Geladeira Brastemp (4/10)", "Nubank Crédito", "Casa", "", 250, "Saída", "PF", "4/10", "Pago", null, "", ""],
    ["2025-05-05", "Geladeira Brastemp (5/10)", "Nubank Crédito", "Casa", "", 250, "Saída", "PF", "5/10", "Pago", null, "", ""],
    [null, "Subtotal", "", "", "", 6467.8, "", "", "", "", null, "", ""],
    ["2025-06-15", "Mercado do mês", "itau", "Supermercado", "", 400, "Saída", "PF", "", "Pago", 6407.73, "", ""],
    ["2099-02-10", "IPTU parcela única", "itau", "Impostos", "", 1200, "Saída", "PF", "", "A pagar", null, "", ""],
    [null, "Saldo final", "", "", "", null, "", "", "", "", 6407.73, "", ""],
  ];
  for (const r of rows) ws.addRow([r[0] ? d(r[0]) : null, ...r.slice(1)]);
  ws.getColumn(1).numFmt = "dd/mm/yyyy";
  ws.getColumn(6).numFmt = "#,##0.00";
  ws.getColumn(11).numFmt = "#,##0.00";

  const chart = wb.addWorksheet("Gráfico");
  chart.addRow(["Categoria", "%"]);
  chart.addRow(["Mercado", "35%"]);
  chart.addRow(["Casa", "20%"]);

  const lists = wb.addWorksheet("Listas", { state: "hidden" });
  lists.addRow(["Categorias", "Contas"]);
  lists.addRow(["Mercado", "itau"]);
  lists.addRow(["Luz", "Nubank Crédito"]);
  return toBuffer(wb);
}

/**
 * 5) Planilha "de cliente" (formato relatado na validação): resumo, abas mensais com cabeçalhos
 * livres ("O que foi", "Onde paguei", "PJ ou PF", "Situação"), parcela só na descrição, aba de
 * receitas com "Origem"/"Conta" e matriz por categoria com meses sem ano.
 */
export async function clientWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const resumo = wb.addWorksheet("Resumo");
  resumo.addRow(["Resumo 2025"]);
  resumo.addRow(["Mês", "Gastos", "Receitas"]);
  resumo.addRow(["Janeiro", 731.7, 7500]);
  resumo.addRow(["Fevereiro", 720.3, 6000]);
  const header = ["Dia", "O que foi", "Valor (R$)", "Onde paguei", "Tipo de gasto", "PJ ou PF", "Situação"];
  const months: Array<[string, Array<[number, string, number, string, string, string, string]>, string]> = [
    [
      "Janeiro",
      [
        [3, "Mercado Extra", 250.4, "Itaú", "Mercado", "PF", "Pago"],
        [5, "Geladeira 3/10", 300, "Nubank crédito", "Casa", "PF", "Pago"],
        [8, "Uber reunião", 32.5, "Pix Inter", "Transporte", "PJ", "Pago"],
        [12, "Farmácia", 48.9, "Itaú", "Saúde", "", "Pago"],
        [20, "Internet", 99.9, "Itaú", "Contas da casa", "PF", "Pago"],
      ],
      "TOTAL",
    ],
    [
      "Fevereiro",
      [
        [4, "Mercado Extra", 230.5, "Itaú", "Mercado", "PF", "Pago"],
        [5, "Geladeira 4/10", 300, "Nubank crédito", "Casa", "PF", "Pago"],
        [2, "Almoço cliente 02/02", 89.9, "Pix Inter", "Alimentação", "PJ", "Pago"],
        [20, "Internet", 99.9, "Itaú", "Contas da casa", "PF", "A pagar"],
      ],
      "Total do mês",
    ],
  ];
  for (const [name, rows, total] of months) {
    const ws = wb.addWorksheet(name);
    ws.addRow(header);
    for (const r of rows) ws.addRow(r);
    ws.addRow([total, "", rows.reduce((s2, r) => s2 + r[2], 0), "", "", "", ""]);
  }
  const receitas = wb.addWorksheet("Receitas");
  receitas.addRow(["Data", "Origem", "Valor", "Conta"]);
  receitas.addRow([d("2025-01-05"), "Salário", 6000, "Itaú"]);
  receitas.addRow([d("2025-01-20"), "Freela site", 1500, "Inter"]);
  receitas.addRow([d("2025-02-05"), "Salário", 6000, "Itaú"]);
  receitas.getColumn(1).numFmt = "dd/mm/yyyy";
  const matriz = wb.addWorksheet("Gastos por categoria");
  matriz.addRow(["Categoria", "Jan", "Fev", "Mar"]);
  matriz.addRow(["Mercado", 800, 850, 900]);
  matriz.addRow(["Transporte", 200, 180, 220]);
  matriz.addRow(["Total", 1000, 1030, 1120]);
  return toBuffer(wb);
}

export const FIXTURES = {
  "lista-simples": simpleList,
  "abas-mensais": monthlySheets,
  "matriz-categorias": categoryMatrix,
  "planilha-baguncada": messySheet,
  "controle-financeiro-2025": clientWorkbook,
} as const;
