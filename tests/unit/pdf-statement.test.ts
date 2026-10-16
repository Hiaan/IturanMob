import { describe, expect, it } from "vitest";
import { bankMatches, classifyPdf, dateAtStart, findAmounts, isScanned, normalizePdfText, parsePdfStatement, PdfPasswordError } from "@/server/modules/imports/pdf";
import * as F from "../helpers/pdf-fixtures";

const c = (text: string, x: number) => ({ text, x });

const TODAY = "2026-10-16";

async function rowsOf(fixture: F.FixtureLine[][]) {
  const st = await parsePdfStatement(await F.makePdf(fixture), { today: TODAY });
  return { st, rows: st.rows.map((r) => [r.date, r.amountCents, r.description] as const) };
}

describe("PDF: valores e datas", () => {
  it("lê valores brasileiros com sinal, D/C, parênteses e ignora dólar e percentual", () => {
    const cents = (t: string) => findAmounts(t).map((a) => a.cents * (a.sign || 1));
    expect(cents("PIX  -245,90  7.754,10")).toEqual([-24590, 775410]);
    expect(cents("Pagamento  −R$ 1.500,00")).toEqual([-150000]);
    expect(cents("TARIFA  39,90-")).toEqual([-3990]);
    expect(cents("ESTORNO  (12,00)")).toEqual([-1200]);
    expect(cents("Pix enviado  18,50 D")).toEqual([-1850]);
    expect(cents("Pix recebido  320,00 C")).toEqual([32000]);
    expect(cents("Netflix  US$ 10,00  R$ 55,90")).toEqual([5590]);
    expect(cents("Juros 2,99% ao mês")).toEqual([]);
    expect(cents("Seguros 12,00")).toEqual([1200]);
  });

  it("reconhece datas no início da linha", () => {
    expect(dateAtStart("15/10/2026 pix")).toMatchObject({ day: 15, month: 10, year: 2026 });
    expect(dateAtStart("15/10 posto")).toMatchObject({ day: 15, month: 10, year: null });
    expect(dateAtStart("05 out •••• 1234 uber")).toMatchObject({ day: 5, month: 10, year: null });
    expect(dateAtStart("02 out 2026")).toMatchObject({ day: 2, month: 10, year: 2026 });
    expect(dateAtStart("14 de outubro de 2026 saldo")).toMatchObject({ day: 14, month: 10, year: 2026 });
    expect(dateAtStart("parcela 02/10")).toBeNull();
  });
});

describe("PDF: extratos e faturas dos bancos brasileiros (layouts sintéticos)", () => {
  it("Itaú (extrato): colunas Valor e Saldo; saldo nunca vira lançamento", async () => {
    const { st, rows } = await rowsOf(F.ITAU_EXTRATO);
    expect(st).toMatchObject({ kind: "BANK", bank: "Itaú", startDate: "2026-10-01", endDate: "2026-10-15" });
    expect(rows).toEqual([
      ["2026-10-02", -24590, "PIX TRANSF MERCADO BOM"],
      ["2026-10-03", 650000, "PAGTO SALARIO"],
      ["2026-10-05", -3990, "TAR PACOTE ITAU"],
      ["2026-10-10", -123456, "ITAU UNICLASS FATURA CARTAO"],
    ]);
    // Saídas com "-": o valor sem sinal (salário) é entrada, sem precisar deduzir pela descrição.
    expect(st.warnings.join(" ")).not.toContain("deduzida");
  });

  it("Bradesco: Crédito/Débito em colunas e data só na primeira linha do dia", async () => {
    const { st, rows } = await rowsOf(F.BRADESCO_EXTRATO);
    expect(st.bank).toBe("Bradesco");
    expect(rows).toEqual([
      ["2026-10-06", 15000, "TRANSFERENCIA PIX REM: JOAO SILVA"],
      ["2026-10-06", -18743, "CONTA DE LUZ NEOENERGIA"],
      ["2026-10-07", -6320, "COMPRA DEB FARMACIA PAGUE MENOS"],
    ]);
  });

  it("Banco do Brasil e Caixa: marcação D/C", async () => {
    expect((await rowsOf(F.BB_EXTRATO)).rows).toEqual([
      ["2026-10-08", -1850, "Pix - Enviado Padaria Pão Quente"],
      ["2026-10-09", 32000, "Pix - Recebido Maria Souza"],
    ]);
    expect((await rowsOf(F.CAIXA_EXTRATO)).rows).toEqual([
      ["2026-10-11", -9840, "PAG BOLETO COMPESA"],
      ["2026-10-12", 5000, "CRED PIX JOSE"],
    ]);
  });

  it("Santander e C6: crédito/débito e entradas/saídas", async () => {
    expect((await rowsOf(F.SANTANDER_EXTRATO)).rows).toEqual([
      ["2026-10-13", 20000, "PIX RECEBIDO ANA"],
      ["2026-10-13", -21000, "COMPRA CARTAO POSTO SHELL"],
    ]);
    expect((await rowsOf(F.C6_EXTRATO)).rows).toEqual([
      ["2026-10-14", 40000, "Pix recebido Fulano"],
      ["2026-10-14", -65000, "Pagamento de boleto Escola"],
    ]);
  });

  it("Inter: cabeçalho de dia por extenso e saldo ao lado do valor", async () => {
    const { st, rows } = await rowsOf(F.INTER_EXTRATO);
    expect(st.bank).toBe("Inter");
    expect(rows).toEqual([
      ["2026-10-14", -7230, 'Pix enviado: "Restaurante Sabor"'],
      ["2026-10-14", 10000, 'Pix recebido: "Carlos Lima"'],
      ["2026-10-15", -2770, "Compra no débito: Drogasil"],
    ]);
  });

  it("Nubank (conta): cabeçalho de dia, seções de entradas/saídas e descrição em duas linhas", async () => {
    const { st, rows } = await rowsOf(F.NUBANK_CONTA);
    expect(st).toMatchObject({ kind: "BANK", bank: "Nubank" });
    expect(rows).toEqual([
      ["2026-10-02", 320000, "Transferência recebida pelo Pix EMPRESA XYZ LTDA - 12.345.678/0001-90 - BCO DO BRASIL"],
      ["2026-10-02", -8500, "Transferência enviada pelo Pix LUCAS PEREIRA - •••.123.456-•• - NU PAGAMENTOS"],
      ["2026-10-03", -4290, "Compra no débito Mercadinho Sao Jose"],
    ]);
    expect(st.warnings).toEqual([]);
  });

  it("Nubank (fatura): compras positivas, pagamento negativo, parcela, dólar e IOF; totais ignorados", async () => {
    const { st, rows } = await rowsOf(F.NUBANK_FATURA);
    expect(st).toMatchObject({ kind: "CREDIT_CARD", bank: "Nubank" });
    expect(rows).toEqual([
      ["2026-10-04", -150000, "Pagamento em 04 OUT"],
      ["2026-10-05", 2345, "Uber *Trip"],
      ["2026-10-12", 12990, "Magazine Luiza - Parcela 2/10"],
      ["2026-10-20", 5590, "Netflix.com"],
      ["2026-10-21", 240, "IOF de compra internacional"],
    ]);
  });

  it("C6 (estrutura real): banco pelo cabeçalho/rodapé, resumo mensal ignorado, entrada sem sinal e totais por mês", async () => {
    const { st, rows } = await rowsOf(F.C6_EXTRATO_REAL);
    expect(st).toMatchObject({ kind: "BANK", bank: "C6 Bank", bankConfident: true });
    expect(rows).toEqual([
      ["2026-09-09", -800, "Outros gastos MENSALIDADE C6TAG"],
      ["2026-09-09", 800, "Entradas EST MENSALIDAD C6TAG"],
      ["2026-09-10", -100000, "Saída PIX Pix enviado para NU PAGAMENTOS S/A"],
      ["2026-09-12", 100000, "Entrada PIX Pix recebido de NU PAGAMENTOS S/A"],
      ["2026-09-26", 2500, "Entradas EST RECARGA DE CEL"],
      ["2026-09-27", -7500, "Débito de Cartão MERCADO BOM"],
      ["2026-10-02", 30000, "Entrada PIX Pix recebido de NU PAGAMENTOS S/A"],
      ["2026-10-03", -12000, "Pagamento PAGTO BOLETO ESCOLA NU PAGAMENTOS"],
    ]);
    // Fecha com o resumo de cada mês do próprio PDF.
    const sum = (month: string, sign: 1 | -1) => st.rows.filter((r) => r.date.startsWith(month) && Math.sign(r.amountCents) === sign).reduce((t, r) => t + Math.abs(r.amountCents), 0);
    expect([sum("2026-09", 1), sum("2026-09", -1), sum("2026-10", 1), sum("2026-10", -1)]).toEqual([103300, 108300, 30000, 12000]);
    // No C6 a ausência de "-" já é o sinal: nada foi "deduzido".
    expect(st.warnings.join(" ")).not.toContain("deduzida");
  });

  it("banco citado só nas descrições não é confiável para escolher a conta", async () => {
    const st = await parsePdfStatement(await F.makePdf([["Extrato", [c("01/10/2026", 40), c("Pix para NU PAGAMENTOS", 110), c("-50,00", 380)], [c("02/10/2026", 40), c("Pix de NU PAGAMENTOS", 110), c("-20,00", 380)], ...Array.from({ length: 14 }, (_, i) => [c(`${String(i + 3).padStart(2, "0")}/10/2026`, 40), c("COMPRA LOJA", 110), c("-1,00", 380)])]]), { today: TODAY });
    expect(st.bankConfident).toBe(false);
  });

  it("fatura com virada de ano: dezembro fica no ano anterior ao vencimento", async () => {
    const { rows } = await rowsOf(F.ITAU_FATURA_VIRADA);
    expect(rows).toEqual([
      ["2026-12-28", 21000, "RESTAURANTE MAR AZUL"],
      ["2027-01-02", 18000, "POSTO IPIRANGA"],
      ["2027-01-05", -21000, "ESTORNO RESTAURANTE MAR AZUL"],
    ]);
  });
});

describe("PDF: classificação, senha e digitalizado", () => {
  it("comprovante de Pix não é extrato", async () => {
    const pdf = await F.makePdf(F.PIX_COMPROVANTE);
    const st = await parsePdfStatement(pdf, { today: TODAY });
    expect(classifyPdf(st, st.lines.map((l) => l.text).join(" ").toLowerCase())).toBe("RECEIPT");
    const fatura = await parsePdfStatement(await F.makePdf(F.NUBANK_FATURA), { today: TODAY });
    expect(classifyPdf(fatura, "")).toBe("STATEMENT");
  });

  it("PDF com senha gera erro específico", async () => {
    const pdf = await F.makePdf(F.ITAU_EXTRATO, { password: "1234" });
    await expect(parsePdfStatement(pdf, { today: TODAY })).rejects.toBeInstanceOf(PdfPasswordError);
  });

  it("PDF sem texto (digitalizado) é reconhecido", async () => {
    const st = await parsePdfStatement(await F.makeScannedPdf(), { today: TODAY });
    expect(st.rows).toEqual([]);
    expect(isScanned(st)).toBe(true);
    const text = await parsePdfStatement(await F.makePdf(F.ITAU_EXTRATO), { today: TODAY });
    expect(isScanned(text)).toBe(false);
  });
});

describe("PDF: banco do documento × contas do app", () => {
  it("reconhece os nomes que a família costuma dar às contas e cartões", () => {
    const m = (bank: string, name: string) => bankMatches(bank, normalizePdfText(name));
    expect(m("Nubank", "Nu Conta")).toBe(true);
    expect(m("Nubank", "Roxinho")).toBe(true);
    expect(m("Itaú", "Itaú Personnalité")).toBe(true);
    expect(m("Banco do Brasil", "Conta BB")).toBe(true);
    expect(m("Caixa", "Poupança Caixa")).toBe(true);
    expect(m("C6 Bank", "C6")).toBe(true);
    expect(m("Inter", "Banco Inter")).toBe(true);
    expect(m("Itaú", "Nubank")).toBe(false);
    expect(m("Inter", "Internet")).toBe(false);
    expect(m("Desconhecido", "Itaú")).toBe(false);
  });
});
