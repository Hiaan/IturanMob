import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { decodeText, detectDelimiter, parseCsv } from "@/server/modules/imports/csv";
import { ofxDescription, parseOfx, parseOfxAmount, parseOfxDate } from "@/server/modules/imports/ofx";
import { parseXlsx } from "@/server/modules/imports/xlsx";
import { applyMapping, detectHeaderRow, detectMapping, mappingProblems, parseImportAmount, parseImportDate } from "@/server/modules/imports/mapping";

describe("valores e datas de extratos", () => {
  it.each([
    ["1.234,56", 123456],
    ["-45,90", -4590],
    ["(45,90)", -4590],
    ["R$ 1.234,56", 123456],
    ["-R$ 10,00", -1000],
    ["45,90-", -4590],
    ["45,90 D", -4590],
    ["45,90 C", 4590],
    ["−12,30", -1230],
    ["1234.56", 123456],
  ])("interpreta o valor %s", (input, expected) => {
    expect(parseImportAmount(input)).toBe(expected);
  });

  it("rejeita valores inválidos", () => {
    expect(parseImportAmount("abc")).toBeNull();
    expect(parseImportAmount("")).toBeNull();
  });

  it.each([
    ["05/10/2026", "2026-10-05"],
    ["5/1/26", "2026-01-05"],
    ["2026-10-05", "2026-10-05"],
    ["2026-10-05T10:00:00", "2026-10-05"],
    ["05.10.2026", "2026-10-05"],
    ["20261005", "2026-10-05"],
  ])("interpreta a data %s", (input, expected) => {
    expect(parseImportDate(input)).toBe(expected);
  });

  it("respeita o formato mês/dia quando indicado e rejeita datas impossíveis", () => {
    expect(parseImportDate("10/05/2026", "mdy")).toBe("2026-10-05");
    expect(parseImportDate("31/02/2026")).toBeNull();
    expect(parseImportDate("ontem")).toBeNull();
  });
});

describe("CSV", () => {
  it("detecta o delimitador", () => {
    expect(detectDelimiter("Data;Descrição;Valor\n05/10/2026;Mercado;-45,90\n06/10/2026;Salário;3.500,00")).toBe(";");
    expect(detectDelimiter('date,title,amount\n2026-10-05,Mercado,45.90\n2026-10-06,"Padaria, centro",12.00')).toBe(",");
    expect(detectDelimiter("Data\tHistórico\tValor\n05/10/2026\tMercado\t-45,90")).toBe("\t");
  });

  it("lê CSV brasileiro com linhas de identificação antes do cabeçalho", () => {
    const csv = [
      "Banco Exemplo S.A.",
      "Agência: 1234;Conta: 56789-0",
      "",
      "Data;Histórico;Documento;Valor (R$);Saldo (R$)",
      "01/10/2026;SALDO ANTERIOR;;;1.000,00",
      "05/10/2026;COMPRA CARTAO MERCADO BOM PRECO;123;-245,90;754,10",
      '06/10/2026;"PIX RECEBIDO; JOAO";456;1.500,00;2.254,10',
      "07/10/2026;TARIFA;789;(12,50);2.241,60",
    ].join("\r\n");
    const table = parseCsv(Buffer.from(csv, "utf8"));
    expect(table.delimiter).toBe(";");
    // Linhas vazias são descartadas: o cabeçalho é a 3ª linha não vazia.
    expect(table.headerRowIndex).toBe(2);
    expect(table.headers).toEqual(["Data", "Histórico", "Documento", "Valor (R$)", "Saldo (R$)"]);
    const mapping = detectMapping(table.headers, table.rows);
    expect(mapping).toMatchObject({ date: 0, description: 1, externalId: 2, amount: 3, debit: null, credit: null });
    const rows = applyMapping(table, mapping);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.skipReason).toMatch(/saldo/i);
    expect(rows[1]).toMatchObject({ date: "2026-10-05", amountCents: -24_590, description: "COMPRA CARTAO MERCADO BOM PRECO", externalId: "123", error: null });
    expect(rows[2]).toMatchObject({ date: "2026-10-06", amountCents: 150_000, description: "PIX RECEBIDO; JOAO" });
    expect(rows[3]).toMatchObject({ amountCents: -1_250 });
  });

  it("decodifica arquivos em Windows-1252", () => {
    const latin1 = Buffer.from([0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0xe7, 0xe3, 0x6f]); // "Descrição"
    expect(decodeText(latin1)).toBe("Descrição");
    expect(decodeText(Buffer.from("﻿Data", "utf8"))).toBe("Data");
  });

  it("aceita colunas de débito e crédito separadas", () => {
    const csv = "Data,Descrição,Débito,Crédito\n2026-10-05,Mercado,\"245,90\",\n2026-10-06,Salário,,\"3.500,00\"";
    const table = parseCsv(csv);
    const mapping = detectMapping(table.headers, table.rows);
    expect(mapping).toMatchObject({ date: 0, description: 1, amount: null, debit: 2, credit: 3 });
    const rows = applyMapping(table, mapping);
    expect(rows.map((r) => r.amountCents)).toEqual([-24_590, 350_000]);
  });

  it("aponta erros de data e valor por linha", () => {
    const table = parseCsv("Data;Descrição;Valor\n99/99/2026;X;10,00\n05/10/2026;Y;abc\n05/10/2026;Z;");
    const rows = applyMapping(table, detectMapping(table.headers, table.rows));
    expect(rows[0]!.error).toMatch(/Data inválida/);
    expect(rows[1]!.error).toMatch(/Valor inválido/);
    expect(rows[2]!.error).toMatch(/Valor ausente/);
  });

  it("detecta colunas pelo conteúdo quando não há cabeçalho", () => {
    const table = parseCsv("05/10/2026;Mercado do bairro;-45,90\n06/10/2026;Padaria;-12,00");
    expect(table.headerRowIndex).toBe(-1);
    const mapping = detectMapping(table.headers, table.rows);
    expect(mapping).toMatchObject({ date: 0, description: 1, amount: 2 });
  });

  it("aceita mapeamento informado pelo usuário e valida colunas", () => {
    const table = parseCsv("A;B;C\n2026-10-05;-10,00;Café");
    const custom = { date: 0, description: 2, amount: 1, debit: null, credit: null, category: null, externalId: null, dateFormat: "auto" as const };
    expect(mappingProblems(custom, table.headers.length)).toEqual([]);
    const rows = applyMapping(table, custom);
    expect(rows[0]).toMatchObject({ date: "2026-10-05", amountCents: -1000, description: "Café" });
    expect(mappingProblems({ ...custom, date: null, amount: 9 }, 3)).toHaveLength(2);
  });

  it("reconhece cabeçalhos em inglês (ex.: exportação de cartão)", () => {
    const table = parseCsv("date,category,title,amount\n2026-10-05,food,Restaurante Sabor,89.90");
    const mapping = detectMapping(table.headers, table.rows);
    expect(mapping).toMatchObject({ date: 0, category: 1, description: 2, amount: 3 });
    expect(detectHeaderRow([["x"], ["date", "title", "amount"]])).toBe(1);
  });
});

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261012120000[-3:BRT]<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>BRL
<BANKACCTFROM>
<BANKID>0341
<BRANCHID>1234
<ACCTID>56789-0
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20261001000000[-3:BRT]
<DTEND>20261012000000[-3:BRT]
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261005000000[-3:BRT]
<TRNAMT>-245.90
<FITID>202610050001
<CHECKNUM>123
<MEMO>COMPRA MERCADO BOM PRECO
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261006
<TRNAMT>1500.00
<FITID>202610060002
<NAME>PIX RECEBIDO
<MEMO>JOAO &amp; MARIA
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2254.10<DTASOF>20261012</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

const OFX_XML_CARD = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS>
      <TRNUID>1</TRNUID>
      <CCSTMTRS>
        <CURDEF>BRL</CURDEF>
        <CCACCTFROM><ACCTID>1234</ACCTID></CCACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20260904</DTSTART>
          <DTEND>20261003</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260910000000[-3:BRT]</DTPOSTED>
            <TRNAMT>89.90</TRNAMT>
            <FITID>abc-1</FITID>
            <MEMO>Restaurante Sabor</MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20260915000000[-3:BRT]</DTPOSTED>
            <TRNAMT>-500.00</TRNAMT>
            <FITID>abc-2</FITID>
            <MEMO>Pagamento recebido</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>`;

describe("OFX", () => {
  it("lê OFX v1 (SGML) de conta bancária", () => {
    const st = parseOfx(OFX_SGML);
    expect(st).toMatchObject({ version: 1, kind: "BANK", currency: "BRL", bankId: "0341", branchId: "1234", accountId: "56789-0", accountType: "CHECKING" });
    expect(st.startDate).toBe("2026-10-01");
    expect(st.endDate).toBe("2026-10-12");
    expect(st.ledgerBalanceCents).toBe(225_410);
    expect(st.transactions).toHaveLength(2);
    expect(st.transactions[0]).toMatchObject({ trnType: "DEBIT", datePosted: "2026-10-05", amountCents: -24_590, fitId: "202610050001", checkNum: "123", memo: "COMPRA MERCADO BOM PRECO" });
    expect(st.transactions[1]).toMatchObject({ trnType: "CREDIT", datePosted: "2026-10-06", amountCents: 150_000, name: "PIX RECEBIDO", memo: "JOAO & MARIA" });
    expect(ofxDescription(st.transactions[1]!)).toBe("PIX RECEBIDO - JOAO & MARIA");
  });

  it("lê OFX v2 (XML) de cartão de crédito", () => {
    const st = parseOfx(Buffer.from(OFX_XML_CARD, "utf8"));
    expect(st).toMatchObject({ version: 2, kind: "CREDIT_CARD", accountId: "1234" });
    expect(st.transactions.map((t) => [t.fitId, t.amountCents, t.datePosted])).toEqual([
      ["abc-1", 8_990, "2026-09-10"],
      ["abc-2", -50_000, "2026-09-15"],
    ]);
  });

  it("interpreta datas e valores do OFX", () => {
    expect(parseOfxDate("20261005120000[-3:BRT]")).toBe("2026-10-05");
    expect(parseOfxDate("2026")).toBeNull();
    expect(parseOfxAmount("-45.90")).toBe(-4590);
    expect(parseOfxAmount("-45,90")).toBe(-4590);
    expect(parseOfxAmount("1.5")).toBe(150);
    expect(parseOfxAmount("1,234.56")).toBe(123456);
    expect(parseOfxAmount("10.005")).toBe(1001);
    expect(parseOfxAmount("x")).toBeNull();
  });

  it("rejeita arquivos que não são OFX", () => {
    expect(() => parseOfx("Data;Valor\n01/01/2026;10,00")).toThrow(/OFX/);
  });
});

describe("XLSX", () => {
  it("lê a primeira planilha e detecta o cabeçalho", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Extrato");
    ws.addRow(["Extrato de conta corrente"]);
    ws.addRow([]);
    ws.addRow(["Data", "Descrição", "Categoria", "Valor"]);
    ws.addRow([new Date(Date.UTC(2026, 9, 5)), "Mercado", "Alimentação", -245.9]);
    ws.addRow(["06/10/2026", "Salário", "Trabalho", 3500]);
    ws.addRow([new Date(Date.UTC(2026, 9, 7)), { richText: [{ text: "Farmá" }, { text: "cia" }] }, null, { formula: "-10-2.5", result: -12.5 }]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const table = await parseXlsx(buffer);
    expect(table.sheetName).toBe("Extrato");
    expect(table.headers).toEqual(["Data", "Descrição", "Categoria", "Valor"]);
    const mapping = detectMapping(table.headers, table.rows);
    expect(mapping).toMatchObject({ date: 0, description: 1, category: 2, amount: 3 });
    const rows = applyMapping(table, mapping);
    expect(rows.map((r) => [r.date, r.description, r.amountCents, r.categoryName])).toEqual([
      ["2026-10-05", "Mercado", -24_590, "Alimentação"],
      ["2026-10-06", "Salário", 350_000, "Trabalho"],
      ["2026-10-07", "Farmácia", -1_250, null],
    ]);
  });

  it("falha com mensagem clara para arquivo inválido", async () => {
    await expect(parseXlsx(Buffer.from("não é planilha"))).rejects.toThrow(/planilha/);
  });
});
