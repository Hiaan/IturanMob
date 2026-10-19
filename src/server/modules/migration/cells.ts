import { dateToISO } from "@/lib/dates";

/**
 * Convenções comuns aos leitores de planilha (iguais às da importação de XLSX): datas viram ISO
 * (AAAA-MM-DD), números usam ponto decimal com duas casas (inteiros sem casas), booleanos em
 * português. Assim a leitura de colunas é a mesma para .xlsx, .xls, .ods e .csv.
 */

export function numberToCell(value: number): string {
  if (!Number.isFinite(value)) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function booleanToCell(value: boolean): string {
  return value ? "verdadeiro" : "falso";
}

const DAY_MS = 86_400_000;

/** Número de série de data do Excel/LibreOffice → AAAA-MM-DD (sistema 1900 ou 1904). */
export function serialToISO(serial: number, date1904 = false): string {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return "";
  const days = Math.floor(serial);
  // Sistema 1900: o Excel considera 29/02/1900 (inexistente); antes dele, o dia é deslocado em um.
  const ms = date1904 ? Date.UTC(1904, 0, 1) + days * DAY_MS : Date.UTC(1899, 11, 30) + (days < 60 ? days + 1 : days) * DAY_MS;
  return dateToISO(new Date(ms));
}

/** Formato numérico de data? (ignora textos entre aspas, escapes e seções [cor]/[$moeda]). */
export function isDateFormatCode(code: string): boolean {
  const cleaned = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, "")
    .toLowerCase();
  if (/[dy]/.test(cleaned)) return true;
  // "mmm" sozinho é mês; "mm" junto de h/s é minuto (hora, não data).
  return /m/.test(cleaned) && !/[hs]/.test(cleaned) && !/[0#?]/.test(cleaned);
}

/** Formatos internos do Excel que são datas (14–17, 22 e os de idiomas asiáticos). */
export function isBuiltinDateFormat(id: number): boolean {
  return (id >= 14 && id <= 17) || id === 22 || (id >= 27 && id <= 36) || (id >= 50 && id <= 58);
}

/** Limpa o texto de uma célula (espaços não separáveis, quebras de linha repetidas). */
export function cleanCellText(text: string): string {
  return text.replace(/[   ]/g, " ").replace(/\r\n?/g, "\n").trim();
}
