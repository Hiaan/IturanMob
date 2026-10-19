import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { readWorkbook, assertSafeZip } from "@/server/modules/migration/workbook";
import { parseHtmlTables, parseSpreadsheetMl, readXls, SpreadsheetReadError } from "@/server/modules/migration/xls";
import { isDateFormatCode, serialToISO } from "@/server/modules/migration/cells";
import { messySheet, simpleList } from "../fixtures/migration/build";

const fixture = (name: string) => readFileSync(`tests/fixtures/migration/${name}`);

/** Linhas da primeira aba sem a formatação de número (para comparar formatos). */
const cells = (rows: string[][]) => rows.map((r) => r.map((c) => c.replace(/\.00$/, "")));

describe("leitura de planilhas (todas as abas)", () => {
  it("lista simples dá as mesmas linhas em .xlsx, .xls (Excel 97–2003), .ods e .csv", async () => {
    const xlsx = await readWorkbook(fixture("lista-simples.xlsx"), "lista-simples.xlsx");
    const xls = await readWorkbook(fixture("lista-simples.xls"), "lista-simples.xls");
    const ods = await readWorkbook(fixture("lista-simples.ods"), "lista-simples.ods");
    const csv = await readWorkbook(fixture("lista-simples.csv"), "lista-simples.csv");
    expect([xlsx.format, xls.format, ods.format, csv.format]).toEqual(["XLSX", "XLS", "ODS", "CSV"]);
    expect(xlsx.sheets[0]!.rows[1]).toEqual(["2025-01-05", "Supermercado Pão de Açúcar", "-320.45", "Supermercado"]);
    expect(cells(xls.sheets[0]!.rows)).toEqual(cells(xlsx.sheets[0]!.rows));
    expect(cells(ods.sheets[0]!.rows)).toEqual(cells(xlsx.sheets[0]!.rows));
    // CSV brasileiro: datas e valores no formato do arquivo (a interpretação vem depois).
    expect(csv.sheets[0]!.rows[2]).toEqual(["06/01/2025", "Salário", "5.200,00", "Salário"]);
    expect(xlsx.sheets[0]!.rowNumbers.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("planilha bagunçada .xls (gerada pelo LibreOffice) equivale à .xlsx, com abas ocultas e números de linha", async () => {
    const xlsx = await readWorkbook(fixture("planilha-baguncada.xlsx"), "a.xlsx");
    const xls = await readWorkbook(fixture("planilha-baguncada.xls"), "a.xls");
    expect(xls.sheets.map((s) => [s.name, s.hidden])).toEqual(xlsx.sheets.map((s) => [s.name, s.hidden]));
    expect(xls.sheets.map((s) => s.name)).toEqual(["Capa", "Lançamentos 2025", "Gráfico", "Listas"]);
    expect(xls.sheets[3]!.hidden).toBe(true);
    const a = xlsx.sheets[1]!;
    const b = xls.sheets[1]!;
    expect(b.rowNumbers).toEqual(a.rowNumbers);
    expect(b.rowNumbers[1]).toBe(3); // a linha vazia entre o título e o cabeçalho não aparece, mas o número sim
    expect(cells(b.rows).map((r) => r.slice(0, 11))).toEqual(cells(a.rows).map((r) => r.slice(0, 11)));
  });

  it(".ods: abas mensais e aba oculta", async () => {
    const ods = await readWorkbook(fixture("abas-mensais.ods"), "abas.ods");
    expect(ods.sheets.map((s) => s.name)).toEqual(["Janeiro 2025", "Fevereiro 2025", "Março", "Resumo"]);
    expect(ods.sheets[0]!.rows[1]).toEqual(["3", "Padaria", "18.50", "Padaria"]);
  });

  it("Excel 2003 (XML) e .xls que é página HTML", () => {
    const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
      <Worksheet ss:Name="Gastos"><Table>
        <Row><Cell><Data ss:Type="String">Data</Data></Cell><Cell><Data ss:Type="String">Valor</Data></Cell></Row>
        <Row><Cell><Data ss:Type="DateTime">2025-03-04T00:00:00.000</Data></Cell><Cell ss:Index="2"><Data ss:Type="Number">-12.5</Data></Cell></Row>
      </Table></Worksheet></Workbook>`;
    expect(parseSpreadsheetMl(xml, { maxRows: 100 })).toEqual([{ name: "Gastos", hidden: false, rows: [["Data", "Valor"], ["2025-03-04", "-12.50"]], rowNumbers: [1, 2], truncated: false }]);
    const html = `<html><body><table><tr><th>Data</th><th>Hist&oacute;rico</th><th>Valor</th></tr>
      <tr><td>05/01/2025</td><td>PIX&nbsp;ENVIADO <b>Jo&atilde;o</b></td><td>-50,00</td></tr></table></body></html>`;
    const sheets = parseHtmlTables(html, { maxRows: 100 });
    expect(sheets[0]!.rows[1]).toEqual(["05/01/2025", "PIX ENVIADO João", "-50,00"]);
    expect(readXls(Buffer.from(html, "latin1"), { maxRows: 100 })[0]!.name).toBe("Tabela 1");
  });

  it("arquivos inválidos, protegidos ou grandes demais falham com mensagem clara", async () => {
    await expect(readWorkbook(Buffer.from("PK\u0003\u0004 lixo"), "x.xlsx")).rejects.toThrow(SpreadsheetReadError);
    const cfb = Buffer.alloc(1024);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb);
    expect(() => readXls(cfb, { maxRows: 10 })).toThrow(/corrompida/);
    // Zip "bomba": tamanho descompactado declarado no diretório central acima do limite.
    const zip = new JSZip();
    zip.file("xl/big.xml", "<x/>");
    const bomb = await zip.generateAsync({ type: "nodebuffer" });
    const cd = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(300 * 1024 * 1024, cd + 24);
    expect(() => assertSafeZip(bomb)).toThrow(/grande demais/);
    await expect(readWorkbook(Buffer.from(""), "vazia.csv")).rejects.toThrow(/vazia/);
  });

  it("limite de linhas por arquivo marca a aba como truncada", async () => {
    const wb = await readWorkbook(await simpleList(), "lista.xlsx", { maxRows: 5 });
    expect(wb.sheets[0]!.rows).toHaveLength(5);
    expect(wb.sheets[0]!.truncated).toBe(true);
  });

  it("datas e formatos numéricos do Excel", async () => {
    expect(serialToISO(45658)).toBe("2025-01-01");
    expect(serialToISO(59)).toBe("1900-02-28");
    expect(serialToISO(61)).toBe("1900-03-01");
    expect(serialToISO(43831, true)).toBe("2024-01-02");
    expect(isDateFormatCode("dd/mm/yyyy")).toBe(true);
    expect(isDateFormatCode("[$-416]mmm-yy")).toBe(true);
    expect(isDateFormatCode('"R$ "#,##0.00')).toBe(false);
    expect(isDateFormatCode("[Red]#,##0.00;-#,##0.00")).toBe(false);
    expect(isDateFormatCode("hh:mm")).toBe(false);
    const messy = await readWorkbook(await messySheet(), "m.xlsx");
    expect(messy.sheets[1]!.rows[2]![0]).toBe("2025-01-03");
  });
});
