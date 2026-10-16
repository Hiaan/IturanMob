import PDFDocument from "pdfkit";

/**
 * PDFs sintéticos que reproduzem a estrutura típica dos extratos e faturas dos bancos brasileiros
 * (colunas, formatos de data e valor). Não são documentos reais: servem para testar o leitor de PDF.
 */

export type FixtureLine = string | Array<{ text: string; x: number }>;

export function makePdf(pages: FixtureLine[][], opts: { password?: string; fontSize?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36, ...(opts.password ? { userPassword: opts.password, ownerPassword: `${opts.password}-owner` } : {}) });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const size = opts.fontSize ?? 9;
    doc.font("Helvetica").fontSize(size);
    pages.forEach((lines, i) => {
      if (i > 0) doc.addPage();
      let y = 50;
      for (const line of lines) {
        if (typeof line === "string") {
          doc.text(line, 40, y, { lineBreak: false });
        } else {
          for (const cell of line) doc.text(cell.text, cell.x, y, { lineBreak: false });
        }
        y += size + 6;
      }
    });
    doc.end();
  });
}

/** PDF só com imagem (sem texto), como um extrato digitalizado. */
export function makeScannedPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (let i = 0; i < 20; i++) doc.rect(40, 60 + i * 30, 500, 12).fill(i % 2 ? "#333333" : "#777777");
    doc.end();
  });
}

const c = (text: string, x: number) => ({ text, x });

/** Itaú — extrato de conta corrente: data dd/mm/aaaa, colunas Valor e Saldo. */
export const ITAU_EXTRATO: FixtureLine[][] = [
  [
    "Itaú Unibanco S.A.   extrato conta corrente",
    "agência 1234  conta 56789-0   período de 01/10/2026 a 15/10/2026",
    [c("data", 40), c("lançamentos", 110), c("valor (R$)", 380), c("saldo (R$)", 480)],
    [c("01/10/2026", 40), c("SALDO ANTERIOR", 110), c("1.500,00", 480)],
    [c("02/10/2026", 40), c("PIX TRANSF MERCADO BOM", 110), c("-245,90", 380)],
    [c("03/10/2026", 40), c("PAGTO SALARIO", 110), c("6.500,00", 380), c("7.754,10", 480)],
    [c("05/10/2026", 40), c("TAR PACOTE ITAU", 110), c("-39,90", 380), c("7.714,20", 480)],
    [c("05/10/2026", 40), c("SALDO DO DIA", 110), c("7.714,20", 480)],
    [c("10/10/2026", 40), c("ITAU UNICLASS FATURA CARTAO", 110), c("-1.234,56", 380)],
  ],
];

/** Bradesco — colunas Crédito e Débito separadas; a data só aparece na primeira linha do dia. */
export const BRADESCO_EXTRATO: FixtureLine[][] = [
  [
    "Bradesco  Extrato de: Conta Corrente  Agência: 1234 | Conta: 0001234-5",
    [c("Data", 40), c("Histórico", 100), c("Docto.", 300), c("Crédito (R$)", 360), c("Débito (R$)", 430), c("Saldo (R$)", 500)],
    [c("06/10/2026", 40), c("TRANSFERENCIA PIX REM: JOAO SILVA", 100), c("1234567", 300), c("150,00", 360)],
    [c("CONTA DE LUZ NEOENERGIA", 100), c("7654321", 300), c("187,43", 430), c("962,57", 500)],
    [c("07/10/2026", 40), c("COMPRA DEB FARMACIA PAGUE MENOS", 100), c("998877", 300), c("63,20", 430), c("899,37", 500)],
  ],
];

/** Banco do Brasil — marcação D/C depois do valor. */
export const BB_EXTRATO: FixtureLine[][] = [
  [
    "Banco do Brasil   Extrato de conta corrente",
    [c("Dia", 40), c("Lote", 110), c("Documento", 150), c("Histórico", 210), c("Valor", 470)],
    [c("08/10/2026", 40), c("14397", 110), c("100245", 150), c("Pix - Enviado  Padaria Pão Quente", 210), c("18,50 D", 470)],
    [c("09/10/2026", 40), c("14397", 110), c("100246", 150), c("Pix - Recebido  Maria Souza", 210), c("320,00 C", 470)],
    [c("09/10/2026", 40), c("00000", 110), c("000000", 150), c("Saldo", 210), c("1.020,00 C", 470)],
  ],
];

/** Caixa — "Data Mov.", valor e saldo com D/C. */
export const CAIXA_EXTRATO: FixtureLine[][] = [
  [
    "CAIXA ECONOMICA FEDERAL - Extrato por período",
    [c("Data Mov.", 40), c("Nr. Doc.", 110), c("Histórico", 180), c("Valor", 400), c("Saldo", 490)],
    [c("11/10/2026", 40), c("000123", 110), c("PAG BOLETO COMPESA", 180), c("98,40 D", 400), c("2.001,60 C", 490)],
    [c("12/10/2026", 40), c("000124", 110), c("CRED PIX JOSE", 180), c("50,00 C", 400), c("2.051,60 C", 490)],
  ],
];

/** Santander — Crédito/Débito com sinal. */
export const SANTANDER_EXTRATO: FixtureLine[][] = [
  [
    "Santander  Extrato de Conta Corrente   Agência 0001",
    [c("Data", 40), c("Descrição", 100), c("Docto", 300), c("Situação", 340), c("Crédito (R$)", 400), c("Débito (R$)", 460), c("Saldo (R$)", 520)],
    [c("13/10/2026", 40), c("PIX RECEBIDO ANA", 100), c("000001", 300), c("", 340), c("200,00", 400)],
    [c("13/10/2026", 40), c("COMPRA CARTAO POSTO SHELL", 100), c("000002", 300), c("", 340), c("-210,00", 460), c("990,00", 520)],
  ],
];

/** Inter — cabeçalho de dia por extenso e valores "-R$" com saldo ao lado. */
export const INTER_EXTRATO: FixtureLine[][] = [
  [
    "Banco Inter   Extrato   Conta: 1234567-8",
    "Período: 01/10/2026 a 15/10/2026",
    "14 de Outubro de 2026   Saldo do dia: R$ 1.000,00",
    [c('Pix enviado: "Restaurante Sabor"', 40), c("-R$ 72,30", 380), c("R$ 927,70", 480)],
    [c('Pix recebido: "Carlos Lima"', 40), c("R$ 100,00", 380), c("R$ 1.027,70", 480)],
    "15 de Outubro de 2026   Saldo do dia: R$ 1.027,70",
    [c("Compra no débito: Drogasil", 40), c("-R$ 27,70", 380), c("R$ 1.000,00", 480)],
  ],
];

/** Nubank — extrato da conta: cabeçalho de dia "DD MMM AAAA", seções de entradas/saídas, valores sem sinal. */
export const NUBANK_CONTA: FixtureLine[][] = [
  [
    "Nu Pagamentos S.A.   Extrato da conta",
    "01 a 15 de outubro de 2026",
    "02 OUT 2026",
    [c("Total de entradas", 40), c("+ 3.200,00", 460)],
    [c("Transferência recebida pelo Pix", 40), c("3.200,00", 460)],
    "EMPRESA XYZ LTDA - 12.345.678/0001-90 - BCO DO BRASIL",
    [c("Total de saídas", 40), c("- 85,00", 460)],
    [c("Transferência enviada pelo Pix", 40), c("85,00", 460)],
    "LUCAS PEREIRA - •••.123.456-•• - NU PAGAMENTOS",
    "03 OUT 2026",
    [c("Total de saídas", 40), c("- 42,90", 460)],
    [c("Compra no débito", 40), c("42,90", 460)],
    "Mercadinho Sao Jose",
  ],
];

/** Nubank — fatura do cartão: datas "DD MMM", compras positivas, pagamento negativo, parcela e dólar. */
export const NUBANK_FATURA: FixtureLine[][] = [
  [
    "Nubank   Fatura do cartão de crédito",
    "Data de vencimento: 10 NOV 2026   Fechamento: 03 NOV 2026   Limite total: R$ 8.000,00",
    "TRANSAÇÕES DE 03 OUT A 03 NOV",
    [c("04 OUT", 40), c("Pagamento em 04 OUT", 100), c("-R$ 1.500,00", 470)],
    [c("05 OUT", 40), c("•••• 1234  Uber *Trip", 100), c("R$ 23,45", 470)],
    [c("12 OUT", 40), c("•••• 1234  Magazine Luiza - Parcela 2/10", 100), c("R$ 129,90", 470)],
    [c("20 OUT", 40), c("•••• 1234  Netflix.com", 100), c("US$ 10,00", 380), c("R$ 55,90", 470)],
    [c("21 OUT", 40), c("IOF de compra internacional", 100), c("R$ 2,40", 470)],
    "Total a pagar  R$ 1.711,65",
  ],
];

/** Itaú — fatura com virada de ano (dez/jan) e datas dd/mm. */
export const ITAU_FATURA_VIRADA: FixtureLine[][] = [
  [
    "Itaú  Fatura do cartão   Vencimento: 15/01/2027",
    [c("data", 40), c("estabelecimento", 100), c("valor em R$", 470)],
    [c("28/12", 40), c("RESTAURANTE MAR AZUL", 100), c("210,00", 470)],
    [c("02/01", 40), c("POSTO IPIRANGA", 100), c("180,00", 470)],
    [c("05/01", 40), c("ESTORNO RESTAURANTE MAR AZUL", 100), c("-210,00", 470)],
  ],
];

/** C6 — extrato com "Entradas" e "Saídas" em colunas. */
export const C6_EXTRATO: FixtureLine[][] = [
  [
    "C6 Bank  Extrato da conta corrente",
    [c("Data", 40), c("Descrição", 100), c("Entradas", 380), c("Saídas", 450), c("Saldo", 520)],
    [c("14/10/2026", 40), c("Pix recebido Fulano", 100), c("400,00", 380), c("1.400,00", 520)],
    [c("14/10/2026", 40), c("Pagamento de boleto Escola", 100), c("650,00", 450), c("750,00", 520)],
  ],
];

/** Comprovante de Pix (um único valor): não é extrato. */
export const PIX_COMPROVANTE: FixtureLine[][] = [
  ["Comprovante de transferência", "Pix enviado", "Valor: R$ 150,00", "Data: 14/10/2026 às 10:32", "Para: Maria Souza", "Autenticação: ABCD1234EFGH"],
];

/**
 * C6 — extrato real em estrutura (valores fictícios): resumo mensal com "Entradas: R$ … • Saídas: R$ …",
 * duas datas por linha (lançamento e contábil), tipo antes da descrição, saída com "-R$" e entrada sem
 * sinal. Descrições citam "NU PAGAMENTOS" (destino de Pix), mas o banco do extrato é o C6.
 */
const c6Row = (d: string, tipo: string, desc: string, valor: string) => [c(d, 40), c(d, 85), c(tipo, 130), c(desc, 215), c(valor, 480)];
export const C6_EXTRATO_REAL: FixtureLine[][] = [
  [
    "Extrato da conta corrente",
    "FULANO DE TAL   Agência: 1 • Conta: 12345678-9",
    "Período: 01/09/2026 a 15/10/2026",
    "Setembro 2026 ( 01/09/2026 - 30/09/2026 ) Entradas: R$ 1.033,00 • Saídas: R$ 1.083,00",
    [c("Data lançamento", 40), c("Data contábil", 85), c("Tipo", 130), c("Descrição", 215), c("Valor", 480)],
    c6Row("09/09", "Outros gastos", "MENSALIDADE C6TAG", "-R$ 8,00"),
    c6Row("09/09", "Entradas", "EST MENSALIDAD C6TAG", "R$ 8,00"),
    c6Row("10/09", "Saída PIX", "Pix enviado para NU PAGAMENTOS S/A", "-R$ 1.000,00"),
    c6Row("12/09", "Entrada PIX", "Pix recebido de NU PAGAMENTOS S/A", "R$ 1.000,00"),
    c6Row("26/09", "Entradas", "EST RECARGA DE CEL", "R$ 25,00"),
    c6Row("27/09", "Débito de Cartão", "MERCADO BOM", "-R$ 75,00"),
    "No app do C6 Bank você acompanha seus lançamentos",
    "Atendimento 24 horas 3003 6116",
  ],
  [
    "Extrato da conta corrente",
    "FULANO DE TAL   Agência: 1 • Conta: 12345678-9",
    "Outubro 2026 ( 01/10/2026 - 15/10/2026 ) Entradas: R$ 300,00 • Saídas: R$ 120,00",
    [c("Data lançamento", 40), c("Data contábil", 85), c("Tipo", 130), c("Descrição", 215), c("Valor", 480)],
    c6Row("02/10", "Entrada PIX", "Pix recebido de NU PAGAMENTOS S/A", "R$ 300,00"),
    c6Row("03/10", "Pagamento", "PAGTO BOLETO ESCOLA NU PAGAMENTOS", "-R$ 120,00"),
    "No app do C6 Bank você acompanha seus lançamentos",
    "Atendimento 24 horas 3003 6116",
  ],
];
