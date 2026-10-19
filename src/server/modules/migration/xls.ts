import { SaxesParser } from "saxes";
import { decodeText, parseCsvRows } from "../imports/csv";
import { booleanToCell, cleanCellText, isBuiltinDateFormat, isDateFormatCode, numberToCell, serialToISO } from "./cells";
import type { RawSheet } from "./workbook";

/**
 * Planilhas .xls. Três formatos chegam com essa extensão:
 * 1. Excel 97–2003 (BIFF8 dentro de um arquivo composto OLE/CFB) — lido aqui, sem bibliotecas externas;
 * 2. página HTML com tabela (muitos bancos exportam assim) — tabelas viram abas;
 * 3. XML do Excel 2003 (SpreadsheetML) ou texto separado por tabulação.
 * Arquivos corrompidos ou maliciosos falham com mensagem clara: todo acesso confere limites.
 */

export class SpreadsheetReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetReadError";
  }
}

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
/** Colunas lidas por aba (o resto é ignorado). */
const MAX_COLUMNS = 120;

export function isCfb(buf: Buffer): boolean {
  return buf.length >= 512 && buf.subarray(0, 8).equals(CFB_SIGNATURE);
}

// -----------------------------------------------------------------------------
// Arquivo composto (MS-CFB)
// -----------------------------------------------------------------------------

interface CfbEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

function invalid(): never {
  throw new SpreadsheetReadError("A planilha .xls está corrompida ou não é um arquivo do Excel.");
}

/** Lê um fluxo (stream) do arquivo composto pelo nome (sem diferenciar maiúsculas). */
export function readCfbStreams(buf: Buffer): { find(name: string): Buffer | null; names: string[] } {
  if (!isCfb(buf)) invalid();
  const sectorShift = buf.readUInt16LE(0x1e);
  if (sectorShift !== 9 && sectorShift !== 12) invalid();
  const sectorSize = 1 << sectorShift;
  const miniShift = buf.readUInt16LE(0x20);
  if (miniShift !== 6) invalid();
  const miniSize = 1 << miniShift;
  const numFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  let difatNext = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);
  const maxSectors = Math.ceil(buf.length / sectorSize);
  if (numFat > maxSectors || numDifat > maxSectors) invalid();

  const sector = (n: number): Buffer => {
    if (n >= maxSectors) invalid();
    const off = (n + 1) * sectorSize;
    if (off >= buf.length) invalid();
    return buf.subarray(off, Math.min(off + sectorSize, buf.length));
  };

  // DIFAT: 109 entradas no cabeçalho e o restante em setores encadeados.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s !== FREESECT) fatSectors.push(s);
  }
  for (let d = 0; d < numDifat && fatSectors.length < numFat && difatNext !== ENDOFCHAIN && difatNext !== FREESECT; d++) {
    const sec = sector(difatNext);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFat; i++) {
      const s = sec.readUInt32LE(i * 4);
      if (s !== FREESECT) fatSectors.push(s);
    }
    difatNext = sec.readUInt32LE(per * 4);
  }
  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
  fatSectors.forEach((s, i) => {
    const sec = sector(s);
    for (let k = 0; k < sectorSize / 4 && k * 4 + 4 <= sec.length; k++) fat[i * (sectorSize / 4) + k] = sec.readUInt32LE(k * 4);
  });

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    let s = start;
    while (s !== ENDOFCHAIN && s !== FREESECT) {
      if (s >= table.length || out.length > limit) invalid();
      out.push(s);
      s = table[s]!;
    }
    return out;
  };
  const readChain = (start: number, size: number | null): Buffer => {
    const parts = chain(start, fat, maxSectors).map(sector);
    const all = Buffer.concat(parts);
    return size === null ? all : all.subarray(0, Math.min(size, all.length));
  };

  // Diretório: entradas de 128 bytes.
  const dir = readChain(dirStart, null);
  const entries: CfbEntry[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 0x40);
    const type = dir[off + 0x42]!;
    if (type === 0 || nameLen < 2 || nameLen > 64) {
      entries.push({ name: "", type: 0, start: 0, size: 0 });
      continue;
    }
    const name = dir.toString("utf16le", off, off + nameLen - 2);
    const start = dir.readUInt32LE(off + 0x74);
    const sizeLow = dir.readUInt32LE(off + 0x78);
    const sizeHigh = dir.readUInt32LE(off + 0x7c);
    entries.push({ name, type, start, size: sectorShift === 9 ? sizeLow : sizeHigh ? Number.MAX_SAFE_INTEGER : sizeLow });
  }
  const root = entries[0];
  if (!root || root.type !== 5) invalid();

  let miniStream: Buffer | null = null;
  let miniFat: Uint32Array | null = null;
  const loadMini = () => {
    if (miniStream && miniFat) return;
    miniStream = readChain(root.start, root.size);
    const mf = miniFatStart === ENDOFCHAIN || miniFatStart === FREESECT ? Buffer.alloc(0) : readChain(miniFatStart, null);
    miniFat = new Uint32Array(Math.floor(mf.length / 4));
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mf.readUInt32LE(i * 4);
  };

  const readEntry = (e: CfbEntry): Buffer => {
    if (e.size > buf.length * 2) invalid();
    if (e.size < miniCutoff) {
      loadMini();
      const ms = miniStream!;
      const parts = chain(e.start, miniFat!, Math.ceil(ms.length / miniSize) + 1).map((s) => {
        const off = s * miniSize;
        if (off >= ms.length) invalid();
        return ms.subarray(off, Math.min(off + miniSize, ms.length));
      });
      return Buffer.concat(parts).subarray(0, e.size);
    }
    return readChain(e.start, e.size);
  };

  return {
    names: entries.filter((e) => e.type === 2).map((e) => e.name),
    find(name: string) {
      const e = entries.find((x) => x.type === 2 && x.name.toLowerCase() === name.toLowerCase());
      return e ? readEntry(e) : null;
    },
  };
}

// -----------------------------------------------------------------------------
// BIFF8 (Excel 97–2003)
// -----------------------------------------------------------------------------

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  FORMAT: 0x041e,
  XF: 0x00e0,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
} as const;

interface BiffRecord {
  type: number;
  data: Buffer;
  offset: number;
}

function* records(stream: Buffer, from = 0): Generator<BiffRecord> {
  let pos = from;
  while (pos + 4 <= stream.length) {
    const type = stream.readUInt16LE(pos);
    const len = stream.readUInt16LE(pos + 2);
    const end = pos + 4 + len;
    if (end > stream.length) return;
    yield { type, data: stream.subarray(pos + 4, end), offset: pos };
    pos = end;
  }
}

function decodeChars(buf: Buffer, start: number, count: number, highByte: boolean): { text: string; end: number } {
  if (highByte) {
    const end = Math.min(buf.length, start + count * 2);
    return { text: buf.toString("utf16le", start, end), end };
  }
  const end = Math.min(buf.length, start + count);
  return { text: buf.toString("latin1", start, end), end };
}

/** XLUnicodeString de um registro (LABEL, STRING, FORMAT): cch(2) + flags(1) + caracteres. */
function xlUnicodeString(data: Buffer, offset: number, cchBytes: 1 | 2 = 2): string {
  if (offset + cchBytes + 1 > data.length) return "";
  const cch = cchBytes === 2 ? data.readUInt16LE(offset) : data[offset]!;
  const flags = data[offset + cchBytes]!;
  let pos = offset + cchBytes + 1;
  if (flags & 0x08) pos += 2; // rich text: cRun
  if (flags & 0x04) pos += 4; // estendido: cbExtRst
  return decodeChars(data, pos, cch, Boolean(flags & 0x01)).text;
}

/** Tabela de strings compartilhadas (SST), que pode continuar em registros CONTINUE. */
function readSst(segments: Buffer[]): string[] {
  let si = 0;
  let off = 0;
  const advance = () => {
    while (si < segments.length && off >= segments[si]!.length) {
      si++;
      off = 0;
    }
  };
  const byte = () => {
    advance();
    if (si >= segments.length) throw new RangeError("fim");
    return segments[si]![off++]!;
  };
  const u16 = () => byte() | (byte() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n: number) => {
    while (n > 0) {
      advance();
      if (si >= segments.length) return;
      const take = Math.min(n, segments[si]!.length - off);
      off += take;
      n -= take;
    }
  };
  const chars = (count: number, highByte: boolean) => {
    let out = "";
    let hb = highByte;
    while (count > 0) {
      if (si >= segments.length) break;
      if (off >= segments[si]!.length) {
        // Caracteres que continuam em outro registro: ele começa com um novo byte de opções.
        si++;
        off = 0;
        if (si >= segments.length) break;
        hb = Boolean(segments[si]![off++]! & 0x01);
        continue;
      }
      const seg = segments[si]!;
      const avail = seg.length - off;
      if (hb) {
        const n = Math.min(count, Math.floor(avail / 2));
        if (n === 0) {
          off = seg.length;
          continue;
        }
        out += seg.toString("utf16le", off, off + n * 2);
        off += n * 2;
        count -= n;
      } else {
        const n = Math.min(count, avail);
        out += seg.toString("latin1", off, off + n);
        off += n;
        count -= n;
      }
    }
    return out;
  };

  const strings: string[] = [];
  try {
    u32(); // total
    const unique = u32();
    for (let i = 0; i < unique && i < 2_000_000; i++) {
      const cch = u16();
      const flags = byte();
      const cRun = flags & 0x08 ? u16() : 0;
      const cbExt = flags & 0x04 ? u32() : 0;
      strings.push(chars(cch, Boolean(flags & 0x01)));
      skip(cRun * 4);
      skip(cbExt);
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
  }
  return strings;
}

function decodeRk(rk: number): number {
  let value: number;
  if (rk & 0x02) {
    value = rk >> 2; // inteiro com sinal de 30 bits
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = b.readDoubleLE(0);
  }
  return rk & 0x01 ? value / 100 : value;
}

interface BiffSheetRef {
  name: string;
  offset: number;
  hidden: boolean;
  kind: number;
}

export function parseBiff8(stream: Buffer, opts: { maxRows: number }): RawSheet[] {
  const first = records(stream).next();
  if (first.done || first.value.type !== R.BOF) {
    throw new SpreadsheetReadError("Esta planilha .xls é de uma versão muito antiga do Excel. Abra e salve como .xlsx.");
  }
  const version = first.value.data.length >= 2 ? first.value.data.readUInt16LE(0) : 0;
  if (version !== 0x0600) throw new SpreadsheetReadError("Esta planilha .xls é de uma versão antiga do Excel (95 ou anterior). Abra e salve como .xlsx.");

  // Globais do livro: formatos, estilos (XF), abas e strings compartilhadas.
  const formats = new Map<number, string>();
  const xfFormat: number[] = [];
  const sheets: BiffSheetRef[] = [];
  let sst: string[] = [];
  let date1904 = false;
  let sstSegments: Buffer[] | null = null;
  for (const rec of records(stream)) {
    if (sstSegments && rec.type === R.CONTINUE) {
      sstSegments.push(rec.data);
      continue;
    }
    if (sstSegments) {
      sst = readSst(sstSegments);
      sstSegments = null;
    }
    if (rec.type === R.FILEPASS) throw new SpreadsheetReadError("A planilha está protegida por senha. Remova a senha no Excel e envie de novo.");
    if (rec.type === R.DATEMODE && rec.data.length >= 2) date1904 = rec.data.readUInt16LE(0) === 1;
    else if (rec.type === R.FORMAT && rec.data.length >= 5) formats.set(rec.data.readUInt16LE(0), xlUnicodeString(rec.data, 2));
    else if (rec.type === R.XF && rec.data.length >= 4) xfFormat.push(rec.data.readUInt16LE(2));
    else if (rec.type === R.BOUNDSHEET && rec.data.length >= 8) {
      sheets.push({
        offset: rec.data.readUInt32LE(0),
        hidden: (rec.data[4]! & 0x03) !== 0,
        kind: rec.data[5]!,
        name: xlUnicodeString(rec.data, 6, 1).slice(0, 100) || `Aba ${sheets.length + 1}`,
      });
    } else if (rec.type === R.SST) sstSegments = [rec.data];
    else if (rec.type === R.EOF) break;
  }
  if (sstSegments) sst = readSst(sstSegments);

  const isDateXf = (ixfe: number) => {
    const ifmt = xfFormat[ixfe];
    if (ifmt === undefined) return false;
    if (isBuiltinDateFormat(ifmt)) return true;
    const code = formats.get(ifmt);
    return code ? isDateFormatCode(code) : false;
  };
  const numberCell = (value: number, ixfe: number) => (isDateXf(ixfe) ? serialToISO(value, date1904) || numberToCell(value) : numberToCell(value));

  const out: RawSheet[] = [];
  let budget = opts.maxRows;
  for (const ref of sheets) {
    if (ref.kind !== 0) continue; // gráficos e macros
    if (ref.offset >= stream.length) continue;
    const cells = new Map<number, Map<number, string>>();
    let truncated = false;
    const set = (row: number, col: number, value: string) => {
      if (col >= MAX_COLUMNS || !value) return;
      let r = cells.get(row);
      if (!r) {
        if (cells.size >= budget) {
          truncated = true;
          return;
        }
        r = new Map();
        cells.set(row, r);
      }
      r.set(col, value);
    };
    let pendingFormula: { row: number; col: number } | null = null;
    let depth = 0;
    for (const rec of records(stream, ref.offset)) {
      const d = rec.data;
      if (rec.type === R.BOF) {
        depth++;
        continue;
      }
      if (rec.type === R.EOF) {
        depth--;
        if (depth <= 0) break;
        continue;
      }
      if (depth > 1) continue; // subfluxo embutido (gráfico)
      // Fórmula compartilhada/matricial pode vir entre a FORMULA e o STRING do resultado.
      if (rec.type === 0x04bc || rec.type === 0x0221 || rec.type === 0x0236) continue;
      if (rec.type === R.STRING && pendingFormula) {
        set(pendingFormula.row, pendingFormula.col, cleanCellText(xlUnicodeString(d, 0)));
        pendingFormula = null;
        continue;
      }
      pendingFormula = null;
      if (d.length < 6) continue;
      const row = d.readUInt16LE(0);
      const col = d.readUInt16LE(2);
      switch (rec.type) {
        case R.LABELSST:
          if (d.length >= 10) set(row, col, cleanCellText(sst[d.readUInt32LE(6)] ?? ""));
          break;
        case R.LABEL:
        case R.RSTRING:
          set(row, col, cleanCellText(xlUnicodeString(d, 6)));
          break;
        case R.NUMBER:
          if (d.length >= 14) set(row, col, numberCell(d.readDoubleLE(6), d.readUInt16LE(4)));
          break;
        case R.RK:
          if (d.length >= 10) set(row, col, numberCell(decodeRk(d.readUInt32LE(6)), d.readUInt16LE(4)));
          break;
        case R.MULRK: {
          const count = Math.floor((d.length - 6) / 6);
          for (let i = 0; i < count; i++) {
            const at = 4 + i * 6;
            set(row, col + i, numberCell(decodeRk(d.readUInt32LE(at + 2)), d.readUInt16LE(at)));
          }
          break;
        }
        case R.FORMULA: {
          if (d.length < 14) break;
          const ixfe = d.readUInt16LE(4);
          if (d.readUInt16LE(12) === 0xffff) {
            const kind = d[6];
            if (kind === 0) pendingFormula = { row, col }; // texto no registro STRING seguinte
            else if (kind === 1) set(row, col, booleanToCell(d[8] === 1));
          } else {
            set(row, col, numberCell(d.readDoubleLE(6), ixfe));
          }
          break;
        }
        case R.BOOLERR:
          if (d.length >= 8 && d[7] === 0) set(row, col, booleanToCell(d[6] === 1));
          break;
        default:
          break;
      }
    }
    const rowNumbers = [...cells.keys()].sort((a, b) => a - b);
    const rows = rowNumbers.map((r) => {
      const m = cells.get(r)!;
      const width = Math.max(...m.keys()) + 1;
      return Array.from({ length: width }, (_, c) => m.get(c) ?? "");
    });
    budget -= rows.length;
    out.push({ name: ref.name, hidden: ref.hidden, rows, rowNumbers: rowNumbers.map((r) => r + 1), truncated });
    if (budget <= 0) break;
  }
  return out;
}

// -----------------------------------------------------------------------------
// .xls em HTML (exportação de bancos) e XML do Excel 2003
// -----------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ordm: "º", ordf: "ª", deg: "°", ndash: "–", mdash: "—", hellip: "…", euro: "€",
  laquo: "«", raquo: "»", ccedil: "ç", Ccedil: "Ç", ntilde: "ñ", Ntilde: "Ñ", szlig: "ß",
};
// Vogais acentuadas (&aacute; &atilde; &ecirc; …), comuns em exportações de bancos.
for (const [name, mark] of [["acute", "\u0301"], ["grave", "\u0300"], ["circ", "\u0302"], ["tilde", "\u0303"], ["uml", "\u0308"]] as const) {
  for (const v of "aeiouAEIOU") ENTITIES[`${v}${name}`] = `${v}${mark}`.normalize("NFC");
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function looksLikeHtml(text: string): boolean {
  return /<(html|table|!doctype html)[\s>]/i.test(text.slice(0, 4096));
}

/** Tabelas de uma página HTML → abas ("Tabela 1", "Tabela 2"...). */
export function parseHtmlTables(text: string, opts: { maxRows: number }): RawSheet[] {
  const sheets: RawSheet[] = [];
  let budget = opts.maxRows;
  const tables = text.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    let truncated = false;
    let n = 0;
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      n++;
      const cells: string[] = [];
      for (const m of tr.matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
        const text = cleanCellText(decodeEntities(m[3]!.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " "));
        cells.push(text);
        const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(m[2]!)?.[1] ?? 1);
        for (let i = 1; i < Math.min(span, 50); i++) cells.push("");
        if (cells.length >= MAX_COLUMNS) break;
      }
      if (!cells.some((c) => c !== "")) continue;
      if (rows.length >= budget) {
        truncated = true;
        break;
      }
      rows.push(cells);
      rowNumbers.push(n);
    }
    if (!rows.length) continue;
    budget -= rows.length;
    sheets.push({ name: `Tabela ${sheets.length + 1}`, hidden: false, rows, rowNumbers, truncated });
    if (budget <= 0) break;
  }
  return sheets;
}

export function looksLikeSpreadsheetMl(text: string): boolean {
  const head = text.slice(0, 4096);
  return /<\?xml/i.test(head) && /urn:schemas-microsoft-com:office:spreadsheet/i.test(text.slice(0, 20_000));
}

/** XML do Excel 2003 (SpreadsheetML): Worksheet → Table → Row → Cell → Data. */
export function parseSpreadsheetMl(text: string, opts: { maxRows: number }): RawSheet[] {
  const sheets: RawSheet[] = [];
  let budget = opts.maxRows;
  let current: { name: string; rows: string[][]; rowNumbers: number[]; truncated: boolean } | null = null;
  let row: string[] | null = null;
  let rowNumber = 0;
  let col = 0;
  let cellType = "";
  let inData = false;
  let dataText = "";
  const attr = (attrs: Record<string, string>, name: string) => {
    for (const [k, v] of Object.entries(attrs)) if (k === name || k.endsWith(`:${name}`)) return v;
    return undefined;
  };
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (tag) => {
    const local = tag.name.split(":").pop()!;
    const attrs = tag.attributes as Record<string, string>;
    if (local === "Worksheet") {
      current = { name: (attr(attrs, "Name") ?? `Aba ${sheets.length + 1}`).slice(0, 100), rows: [], rowNumbers: [], truncated: false };
      rowNumber = 0;
    } else if (local === "Row" && current) {
      const idx = Number(attr(attrs, "Index"));
      rowNumber = Number.isFinite(idx) && idx > 0 ? idx : rowNumber + 1;
      row = [];
      col = 0;
    } else if (local === "Cell" && row) {
      const idx = Number(attr(attrs, "Index"));
      if (Number.isFinite(idx) && idx > 0) col = idx - 1;
    } else if (local === "Data" && row) {
      inData = true;
      dataText = "";
      cellType = attr(attrs, "Type") ?? "String";
    }
  });
  parser.on("text", (t) => {
    if (inData) dataText += t;
  });
  parser.on("closetag", (tag) => {
    const local = tag.name.split(":").pop()!;
    if (local === "Data" && row) {
      inData = false;
      let value = cleanCellText(dataText);
      if (cellType === "Number") value = numberToCell(Number(value));
      else if (cellType === "DateTime") value = value.slice(0, 10);
      else if (cellType === "Boolean") value = booleanToCell(value === "1");
      if (col < MAX_COLUMNS) {
        while (row.length < col) row.push("");
        row[col] = value;
      }
    } else if (local === "Cell" && row) {
      col++;
    } else if (local === "Row" && current && row) {
      if (row.some((c) => c !== "")) {
        if (current.rows.length >= budget) current.truncated = true;
        else {
          current.rows.push(row);
          current.rowNumbers.push(rowNumber);
        }
      }
      row = null;
    } else if (local === "Worksheet" && current) {
      if (current.rows.length) {
        budget -= current.rows.length;
        sheets.push({ name: current.name, hidden: false, rows: current.rows, rowNumbers: current.rowNumbers, truncated: current.truncated });
      }
      current = null;
    }
  });
  try {
    parser.write(text).close();
  } catch {
    throw new SpreadsheetReadError("Não foi possível ler a planilha XML do Excel 2003. Abra e salve como .xlsx.");
  }
  return sheets;
}

/** Qualquer .xls: binário do Excel, HTML, XML 2003 ou texto com tabulações. */
export function readXls(content: Buffer, opts: { maxRows: number }): RawSheet[] {
  if (isCfb(content)) {
    const cfb = readCfbStreams(content);
    if (cfb.names.some((n) => n === "EncryptedPackage")) throw new SpreadsheetReadError("A planilha está protegida por senha. Remova a senha no Excel e envie de novo.");
    const workbook = cfb.find("Workbook");
    if (!workbook) {
      if (cfb.find("Book")) throw new SpreadsheetReadError("Esta planilha .xls é de uma versão antiga do Excel (95 ou anterior). Abra e salve como .xlsx.");
      throw new SpreadsheetReadError("O arquivo .xls não contém uma planilha do Excel.");
    }
    return parseBiff8(workbook, opts);
  }
  const text = decodeText(content);
  if (looksLikeSpreadsheetMl(text)) return parseSpreadsheetMl(text, opts);
  if (looksLikeHtml(text)) return parseHtmlTables(text, opts);
  // Alguns sistemas salvam texto separado por tabulação com extensão .xls.
  const { rows } = parseCsvRows(text);
  const kept: string[][] = [];
  const rowNumbers: number[] = [];
  rows.forEach((r, i) => {
    if (kept.length < opts.maxRows && r.some((c) => c.trim() !== "")) {
      kept.push(r.slice(0, MAX_COLUMNS).map(cleanCellText));
      rowNumbers.push(i + 1);
    }
  });
  if (!kept.length) throw new SpreadsheetReadError("Não foi possível ler a planilha .xls. Abra e salve como .xlsx ou CSV.");
  return [{ name: "Planilha", hidden: false, rows: kept, rowNumbers, truncated: rows.length > kept.length && kept.length >= opts.maxRows }];
}
