import ExcelJS from "exceljs";
import { addDays, isoToDate, todayISO } from "@/lib/dates";

/**
 * Planilha modelo (.xlsx) com as colunas recomendadas e um exemplo por linha. As linhas de
 * exemplo começam com "EXEMPLO" e são ignoradas na migração (não viram lançamentos).
 */

const COLUMNS: Array<{ header: string; width: number; help: string }> = [
  { header: "Data", width: 12, help: "Data do lançamento (dd/mm/aaaa). Em abas por mês, pode ser só o dia — o mês vem do nome da aba (\"Janeiro 2025\")." },
  { header: "Descrição", width: 34, help: "O que foi: \"Supermercado\", \"Conta de luz\", \"Salário\". Parcela na descrição também vale: \"Geladeira (3/10)\"." },
  { header: "Valor", width: 12, help: "Valor em reais (1.234,56). Use negativo para saídas OU preencha a coluna Tipo." },
  { header: "Tipo", width: 10, help: "Entrada ou Saída (também: receita/despesa, crédito/débito)." },
  { header: "Categoria", width: 16, help: "Do jeito que você usa — na migração você liga cada nome a uma categoria do app (ou cria)." },
  { header: "Subcategoria", width: 16, help: "Opcional." },
  { header: "Conta", width: 16, help: "Banco/conta de onde saiu ou entrou o dinheiro (ex.: Nubank, Itaú, Carteira)." },
  { header: "Cartão", width: 16, help: "Cartão de crédito da compra (deixe a Conta em branco nas compras no crédito)." },
  { header: "Forma de pagamento", width: 18, help: "Pix, débito, crédito, dinheiro, boleto, transferência, vale." },
  { header: "Pessoa", width: 12, help: "Quem pagou/recebeu (nome de um membro da família). Opcional." },
  { header: "Natureza", width: 11, help: "Pessoal (PF), Empresa (PJ) ou Repasse de cliente. Opcional." },
  { header: "Parcela", width: 9, help: "\"3/10\" (parcela 3 de 10: o app cria a compra parcelada e as parcelas futuras) ou \"10x\" (compra em 10 vezes, valor total)." },
  { header: "Status", width: 10, help: "Pago ou A pagar. \"A pagar\" vira conta a pagar (não mexe no saldo)." },
  { header: "Observação", width: 30, help: "Opcional." },
];

export async function buildMigrationModel(timezone: string): Promise<Buffer> {
  const today = todayISO(timezone);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Finance AI";
  const ws = wb.addWorksheet("Lançamentos", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2F0EC" } };
  const d = (offset: number) => isoToDate(addDays(today, offset));
  const examples: Array<Array<string | number | Date | null>> = [
    [d(-12), "EXEMPLO — Supermercado do mês", 350.75, "Saída", "Alimentação", "Supermercado", "Conta corrente", null, "Débito", null, "Pessoal", null, "Pago", "Apague as linhas de exemplo"],
    [d(-10), "EXEMPLO — Geladeira", 300, "Saída", "Compras", "Casa", null, "Cartão Visa", "Crédito", null, "Pessoal", "1/10", "Pago", "Parcela 1 de 10: o app cria as parcelas futuras"],
    [d(-8), "EXEMPLO — Salário", 5000, "Entrada", "Trabalho", "Salário", "Conta corrente", null, "Transferência", null, "Pessoal", null, "Pago", null],
    [d(-5), "EXEMPLO — Serviço para cliente", 1200, "Entrada", "Trabalho", "Serviços", "Conta PJ", null, "Pix", null, "Empresa", null, "Pago", "Natureza Empresa (PJ)"],
    [d(10), "EXEMPLO — Conta de luz", 180.4, "Saída", "Moradia", "Energia", "Conta corrente", null, "Boleto", null, "Pessoal", null, "A pagar", "\"A pagar\" com data futura vira conta a pagar"],
  ];
  for (const row of examples) ws.addRow(row);
  ws.getColumn(1).numFmt = "dd/mm/yyyy";
  ws.getColumn(3).numFmt = "#,##0.00";

  const help = wb.addWorksheet("Como preencher");
  help.columns = [
    { header: "Coluna", key: "c", width: 22 },
    { header: "Como preencher", key: "h", width: 110 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of COLUMNS) help.addRow({ c: c.header, h: c.help });
  help.addRow({});
  help.addRow({ c: "Dicas", h: "Linhas de total, subtotal e saldo são ignoradas. Abas de resumo e gráficos também. Você pode ter uma aba por mês (Janeiro, Fevereiro…) ou uma lista única." });
  help.addRow({ c: "", h: "Planilha de categorias × meses (orçamento) também é aceita: na migração você escolhe usar como orçamento ou como totais mensais." });
  help.addRow({ c: "", h: "Linhas que começam com \"EXEMPLO\" são ignoradas." });
  help.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
