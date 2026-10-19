import ExcelJS from "exceljs";
import { decodeText, parseCsvRows } from "../imports/csv";
import { cellToString } from "../imports/xlsx";
import { cleanCellText } from "./cells";
import { readOds } from "./ods";
import { isCfb, readXls, SpreadsheetReadError } from "./xls";

/**
 * Leitura de TODAS as abas de uma planilha (.xlsx, .xls, .ods ou .csv) em linhas de texto, com o
 * número da linha original (para as mensagens: "aba Janeiro, linha 12"). A interpretação (tipo de
 * aba, colunas) fica em classify.ts.
 */

export type SheetFormat = "XLSX" | "XLS" | "ODS" | "CSV";

export interface RawSheet {
  name: string;
  hidden: boolean;
  rows: string[][];
  /** Número (base 1) de cada linha na planilha original. */
  rowNumbers: number[];
  /** A aba tinha mais linhas que o limite. */
  truncated: boolean;
}

export interface RawWorkbook {
  format: SheetFormat;
  sheets: RawSheet[];
  totalRows: number;
}

/** Limite de linhas lidas por arquivo (somando as abas). */
export const MIGRATION_MAX_ROWS = 20_000;
const MAX_COLUMNS = 120;
/** Proteção contra arquivos compactados "bomba": soma do conteúdo descompactado. */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;

export { SpreadsheetReadError };

const ZIP_SIGNATURE = [0x50, 0x4b];

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === ZIP_SIGNATURE[0] && buf[1] === ZIP_SIGNATURE[1];
}

/** Confere o diretório central do .zip (xlsx/ods) antes de descompactar. */
export function assertSafeZip(buf: Buffer): void {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpreadsheetReadError("O arquivo está corrompido (não é uma planilha válida).");
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff || entries > MAX_ZIP_ENTRIES) throw new SpreadsheetReadError("A planilha é grande demais para ser lida.");
  if (cdOffset + cdSize > buf.length) throw new SpreadsheetReadError("O arquivo está corrompido (não é uma planilha válida).");
  let total = 0;
  let pos = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new SpreadsheetReadError("O arquivo está corrompido (não é uma planilha válida).");
    const compressed = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    if (size === 0xffffffff || compressed === 0xffffffff) throw new SpreadsheetReadError("A planilha é grande demais para ser lida.");
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new SpreadsheetReadError("A planilha é grande demais para ser lida (conteúdo descompactado acima do limite).");
    pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
}

export function detectSheetFormat(fileName: string, content: Buffer): SheetFormat {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (isZip(content)) {
    // .ods tem o arquivo "mimetype" logo no início do zip.
    const head = content.subarray(0, 200).toString("latin1");
    if (ext === "ods" || head.includes("application/vnd.oasis.opendocument.spreadsheet")) return "ODS";
    return "XLSX";
  }
  if (isCfb(content) || ext === "xls") return "XLS";
  return "CSV";
}

async function readXlsxSheets(content: Buffer, maxRows: number): Promise<RawSheet[]> {
  assertSafeZip(content);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as unknown as ExcelJS.Buffer);
  } catch {
    throw new SpreadsheetReadError("Não foi possível ler a planilha. Verifique se o arquivo não está corrompido ou protegido por senha.");
  }
  const sheets: RawSheet[] = [];
  let budget = maxRows;
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= budget) {
        truncated = true;
        return;
      }
      const values = row.values as ExcelJS.CellValue[];
      const cells: string[] = [];
      for (let i = 1; i < values.length && i <= MAX_COLUMNS; i++) cells.push(cleanCellText(cellToString(values[i] ?? null)));
      if (!cells.some((c) => c !== "")) return;
      rows.push(cells);
      rowNumbers.push(row.number);
    });
    budget -= rows.length;
    sheets.push({ name: ws.name.slice(0, 100), hidden: ws.state === "hidden" || ws.state === "veryHidden", rows, rowNumbers, truncated });
    if (budget <= 0) break;
  }
  return sheets;
}

function readCsvSheet(content: Buffer, fileName: string, maxRows: number): RawSheet[] {
  const text = decodeText(content);
  const { rows } = parseCsvRows(text);
  const kept: string[][] = [];
  const rowNumbers: number[] = [];
  let truncated = false;
  rows.forEach((r, i) => {
    if (!r.some((c) => c.trim() !== "")) return;
    if (kept.length >= maxRows) {
      truncated = true;
      return;
    }
    kept.push(r.slice(0, MAX_COLUMNS).map(cleanCellText));
    rowNumbers.push(i + 1);
  });
  const base = fileName.replace(/\.[^.]+$/, "").trim().slice(0, 100) || "Planilha";
  return [{ name: base, hidden: false, rows: kept, rowNumbers, truncated }];
}

export async function readWorkbook(content: Buffer, fileName: string, opts: { maxRows?: number } = {}): Promise<RawWorkbook> {
  const maxRows = opts.maxRows ?? MIGRATION_MAX_ROWS;
  const format = detectSheetFormat(fileName, content);
  let sheets: RawSheet[];
  if (format === "XLSX") sheets = await readXlsxSheets(content, maxRows);
  else if (format === "ODS") {
    assertSafeZip(content);
    sheets = await readOds(content, { maxRows });
  } else if (format === "XLS") sheets = readXls(content, { maxRows });
  else sheets = readCsvSheet(content, fileName, maxRows);
  // Células: aparadas e no máximo 500 caracteres (descrições longas não precisam mais que isso).
  // Sem células vazias no fim da linha (cada leitor guarda de um jeito).
  for (const s of sheets) {
    s.rows = s.rows.map((r) => {
      let end = r.length;
      while (end > 0 && r[end - 1] === "") end--;
      return r.slice(0, end).map((c) => (c.length > 500 ? c.slice(0, 500) : c));
    });
  }
  const totalRows = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (!totalRows) throw new SpreadsheetReadError("A planilha está vazia.");
  return { format, sheets, totalRows };
}
