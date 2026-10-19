import ExcelJS from "exceljs";
import { dateToISO } from "@/lib/dates";
import { buildTable } from "./mapping";
import type { ParsedTable } from "./types";

/**
 * Leitura de planilhas XLSX (primeira planilha visível), com detecção da linha de cabeçalho.
 * Datas viram ISO (AAAA-MM-DD) e números decimais usam ponto, para leitura uniforme.
 */

export function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : dateToISO(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "verdadeiro" : "falso";
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if ("formula" in value || "sharedFormula" in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      return result === undefined || result === null ? "" : cellToString(result as ExcelJS.CellValue);
    }
    if ("text" in value && typeof (value as ExcelJS.CellHyperlinkValue).text === "string") return (value as ExcelJS.CellHyperlinkValue).text;
    if ("error" in value) return "";
  }
  return String(value);
}

/** Linhas brutas da primeira planilha (limitado a `maxRows`). */
export async function readXlsxRows(buffer: Buffer | Uint8Array, maxRows = 5_100): Promise<{ sheetName: string; rows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new Error("Não foi possível ler a planilha. Verifique se o arquivo está no formato .xlsx.");
  }
  const sheet = wb.worksheets.find((ws) => ws.state !== "hidden" && ws.state !== "veryHidden" && ws.actualRowCount > 0) ?? wb.worksheets[0];
  if (!sheet) throw new Error("A planilha está vazia.");
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= maxRows) return;
    const values = row.values as ExcelJS.CellValue[];
    const cells: string[] = [];
    for (let i = 1; i < values.length; i++) cells.push(cellToString(values[i] ?? null).trim());
    rows.push(cells);
  });
  return { sheetName: sheet.name, rows };
}

export async function parseXlsx(buffer: Buffer | Uint8Array, opts: { headerRowIndex?: number; maxRows?: number } = {}): Promise<ParsedTable> {
  const { sheetName, rows } = await readXlsxRows(buffer, opts.maxRows);
  return { ...buildTable(rows, opts.headerRowIndex), sheetName };
}
