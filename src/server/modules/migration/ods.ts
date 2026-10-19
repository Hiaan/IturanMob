import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { booleanToCell, cleanCellText, numberToCell } from "./cells";
import { SpreadsheetReadError } from "./xls";
import type { RawSheet } from "./workbook";

/**
 * Planilhas OpenDocument (.ods — LibreOffice/Google Planilhas): o conteúdo fica em content.xml,
 * lido em fluxo. Repetições de linhas/colunas vazias (comuns no fim das abas) não são expandidas.
 */

const MAX_COLUMNS = 120;
/** Limite do content.xml descompactado (proteção contra arquivos "bomba"). */
const MAX_CONTENT_BYTES = 150 * 1024 * 1024;

export async function readOds(content: Buffer, opts: { maxRows: number }): Promise<RawSheet[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(content);
  } catch {
    throw new SpreadsheetReadError("Não foi possível abrir a planilha .ods. Verifique se o arquivo não está corrompido.");
  }
  const entry = zip.file("content.xml");
  if (!entry) throw new SpreadsheetReadError("O arquivo .ods não contém uma planilha.");
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (size > MAX_CONTENT_BYTES) throw new SpreadsheetReadError("A planilha .ods é grande demais para ser lida.");
  const xml = await entry.async("string");
  if (xml.length > MAX_CONTENT_BYTES) throw new SpreadsheetReadError("A planilha .ods é grande demais para ser lida.");
  return parseOdsContent(xml, opts);
}

export function parseOdsContent(xml: string, opts: { maxRows: number }): RawSheet[] {
  const sheets: RawSheet[] = [];
  let budget = opts.maxRows;
  let sheet: { name: string; rows: string[][]; rowNumbers: number[]; truncated: boolean; hidden: boolean } | null = null;
  let rowNumber = 0;
  let row: string[] | null = null;
  let rowRepeat = 1;
  let col = 0;
  let cell: { value: string | null; type: string; repeat: number; text: string[]; inP: boolean } | null = null;
  let tableDepth = 0;
  // Abas ocultas: estilo de tabela automático com table:display="false".
  const hiddenStyles = new Set<string>();
  let tableStyle: string | null = null;

  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    const a = tag.attributes as Record<string, string>;
    switch (tag.name) {
      case "style:style":
        tableStyle = a["style:family"] === "table" ? a["style:name"] ?? null : null;
        break;
      case "style:table-properties":
        if (tableStyle && a["table:display"] === "false") hiddenStyles.add(tableStyle);
        break;
      case "table:table":
        tableDepth++;
        if (tableDepth === 1) {
          sheet = {
            name: (a["table:name"] ?? `Aba ${sheets.length + 1}`).slice(0, 100),
            rows: [],
            rowNumbers: [],
            truncated: false,
            hidden: Boolean(a["table:style-name"] && hiddenStyles.has(a["table:style-name"])),
          };
          rowNumber = 0;
        }
        break;
      case "table:table-row":
        if (sheet && tableDepth === 1) {
          row = [];
          col = 0;
          rowRepeat = Math.max(1, Math.min(Number(a["table:number-rows-repeated"] ?? 1) || 1, 1_000_000));
        }
        break;
      case "table:table-cell":
      case "table:covered-table-cell":
        if (row) {
          const type = a["office:value-type"] ?? "";
          let value: string | null = null;
          if (type === "float" || type === "currency" || type === "percentage") value = numberToCell(Number(a["office:value"]));
          else if (type === "date") value = (a["office:date-value"] ?? "").slice(0, 10);
          else if (type === "boolean") value = booleanToCell(a["office:boolean-value"] === "true");
          else if (type === "string" && a["office:string-value"] !== undefined) value = a["office:string-value"]!;
          cell = { value, type, repeat: Math.max(1, Math.min(Number(a["table:number-columns-repeated"] ?? 1) || 1, 20_000)), text: [], inP: false };
        }
        break;
      case "text:p":
        if (cell) {
          cell.inP = true;
          cell.text.push("");
        }
        break;
      case "text:s":
        if (cell?.inP) cell.text[cell.text.length - 1] += " ".repeat(Math.min(Number(a["text:c"] ?? 1) || 1, 100));
        break;
      case "text:tab":
        if (cell?.inP) cell.text[cell.text.length - 1] += " ";
        break;
      case "text:line-break":
        if (cell?.inP) cell.text[cell.text.length - 1] += "\n";
        break;
      default:
        break;
    }
  });
  parser.on("text", (t) => {
    if (cell?.inP) cell.text[cell.text.length - 1] += t;
  });
  parser.on("closetag", (tag) => {
    switch (tag.name) {
      case "style:style":
        tableStyle = null;
        break;
      case "text:p":
        if (cell) cell.inP = false;
        break;
      case "table:table-cell":
      case "table:covered-table-cell":
        if (row && cell) {
          const value = cleanCellText(cell.value ?? cell.text.join("\n"));
          if (value) {
            for (let i = 0; i < cell.repeat && col < MAX_COLUMNS; i++) {
              while (row.length < col) row.push("");
              row[col++] = value;
            }
          } else {
            col += cell.repeat; // vazias repetidas: só avança
          }
          cell = null;
        }
        break;
      case "table:table-row":
        if (sheet && row) {
          if (row.some((c) => c !== "")) {
            for (let i = 0; i < Math.min(rowRepeat, 1000); i++) {
              rowNumber++;
              if (sheet.rows.length >= budget) {
                sheet.truncated = true;
                break;
              }
              sheet.rows.push([...row]);
              sheet.rowNumbers.push(rowNumber);
            }
          } else {
            rowNumber += rowRepeat;
          }
          row = null;
        }
        break;
      case "table:table":
        tableDepth--;
        if (tableDepth === 0 && sheet) {
          const s = sheet as { name: string; rows: string[][]; rowNumbers: number[]; truncated: boolean; hidden: boolean };
          budget -= s.rows.length;
          sheets.push({ name: s.name, hidden: s.hidden, rows: s.rows, rowNumbers: s.rowNumbers, truncated: s.truncated });
          sheet = null;
        }
        break;
      default:
        break;
    }
  });
  try {
    parser.write(xml).close();
  } catch {
    throw new SpreadsheetReadError("Não foi possível ler a planilha .ods (conteúdo inválido).");
  }
  return sheets;
}
