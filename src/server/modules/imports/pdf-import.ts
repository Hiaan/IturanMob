import type { ISODate } from "@/lib/dates";
import { ValidationError } from "../../errors";
import { extractStatementWithAI } from "../../ai/vision/statement";
import { classifyPdf, isScanned, normalizePdfText, parsePdfStatement, PdfPasswordError, PdfReadError, type PdfRow, type PdfStatementKind } from "./pdf";
import type { ParsedImportRow } from "./types";

/**
 * Extrato/fatura em PDF → linhas da prévia de importação.
 *
 * - PDF com texto: lido localmente (sem IA). Se nenhum lançamento for reconhecido e a família tiver
 *   autorizado o envio de imagens/documentos à IA, a IA tenta a leitura como reforço.
 * - PDF digitalizado (sem texto): só a IA consegue ler; sem IA configurada/autorizada, o erro explica.
 * - PDF com senha: pede o arquivo sem senha (a senha nunca é solicitada nem guardada).
 */

export const PDF_PASSWORD_MESSAGE =
  "Este PDF está protegido por senha. Envie o arquivo sem senha: no app do banco, baixe o extrato novamente ou abra o PDF e use “Imprimir → Salvar como PDF”.";

export interface PdfImportResult {
  rows: ParsedImportRow[];
  kind: PdfStatementKind;
  bank: string | null;
  /** Banco do cabeçalho/rodapé (só então a conta/cartão é escolhida automaticamente). */
  bankConfident: boolean;
  startDate: ISODate | null;
  endDate: ISODate | null;
  source: "TEXT" | "AI";
  /** Extrato/fatura × comprovante único × outro documento (decidido pelo texto). */
  classification: "STATEMENT" | "RECEIPT" | "OTHER";
  scanned: boolean;
  warnings: string[];
  /** Linhas lidas pela IA (guardadas na prévia para reprocessar sem nova chamada). */
  aiRows: PdfRow[] | null;
}

export interface PdfImportOptions {
  today: ISODate;
  /** Sem família (ex.: testes de leitura) a IA nunca é usada. */
  householdId?: string | null;
  fileName?: string;
  messageId?: string | null;
  /** Linhas já lidas pela IA (reprocessamento da prévia sem nova chamada). */
  aiRows?: PdfRow[] | null;
  aiMeta?: { kind: PdfStatementKind; bank: string | null } | null;
  maxRows: number;
}

function toParsedRows(rows: PdfRow[], source: "TEXT" | "AI"): ParsedImportRow[] {
  return rows.map<ParsedImportRow>((r, rowIndex) => {
    const raw: Record<string, string> = {};
    if (source === "AI") raw["Origem"] = "Leitura por IA (PDF sem texto)";
    else {
      if (r.page) raw["Página"] = String(r.page);
      if (r.line) raw["Linha do PDF"] = r.line.slice(0, 300);
    }
    return {
      rowIndex,
      date: r.date,
      amountCents: r.amountCents,
      description: r.description || "Lançamento",
      externalId: null,
      categoryName: null,
      raw,
      error: null,
      skipReason: r.amountCents === 0 ? "Lançamento com valor zero (ignorado)." : null,
      meta: {},
    };
  });
}

export async function readPdfForImport(content: Buffer, opts: PdfImportOptions): Promise<PdfImportResult> {
  let st: Awaited<ReturnType<typeof parsePdfStatement>>;
  try {
    st = await parsePdfStatement(content, { today: opts.today });
  } catch (err) {
    if (err instanceof PdfPasswordError) throw new ValidationError(PDF_PASSWORD_MESSAGE, { reason: "PDF_PASSWORD" });
    if (err instanceof PdfReadError) throw new ValidationError(err.message, { reason: "PDF_UNREADABLE" });
    throw new ValidationError("Não foi possível ler este PDF. Verifique se o arquivo não está corrompido.", { reason: "PDF_UNREADABLE" });
  }
  const scanned = isScanned(st);
  const text = normalizePdfText(st.lines.map((l) => l.text).join(" "));
  const classification = scanned ? "OTHER" : classifyPdf(st, text);
  const warnings = [...st.warnings];

  if (!scanned && st.rows.length) {
    if (st.rows.length > opts.maxRows) throw new ValidationError(`O PDF tem ${st.rows.length.toLocaleString("pt-BR")} lançamentos. O limite é de ${opts.maxRows.toLocaleString("pt-BR")} por importação — divida o período em partes.`);
    if (classification === "RECEIPT") warnings.push("Este PDF parece um comprovante, não um extrato. Confira as linhas antes de importar.");
    if (st.kind === "UNKNOWN") warnings.push("Não foi possível identificar se o PDF é extrato de conta ou fatura de cartão: confira os sinais (entrada/saída) na prévia.");
    return { rows: toParsedRows(st.rows, "TEXT"), kind: st.kind, bank: st.bank, bankConfident: st.bankConfident, startDate: st.startDate, endDate: st.endDate, source: "TEXT", classification, scanned, warnings, aiRows: null };
  }

  // Sem lançamentos reconhecidos no texto (ou PDF digitalizado): a IA, se autorizada, tenta a leitura.
  if (opts.aiRows?.length) {
    return aiResult(opts.aiRows, opts.aiMeta?.kind ?? "UNKNOWN", opts.aiMeta?.bank ?? st.bank, scanned, classification, warnings);
  }
  if (classification === "RECEIPT") {
    throw new ValidationError("Este PDF parece um comprovante (um único pagamento), não um extrato. Envie o comprovante pelo WhatsApp para registrá-lo ou importe o extrato completo.", { reason: "PDF_RECEIPT" });
  }
  const reasonPrefix = scanned
    ? "Este PDF não tem texto (parece digitalizado ou uma foto)"
    : "Não encontrei lançamentos neste PDF (o layout não foi reconhecido)";
  if (!opts.householdId) throw new ValidationError(`${reasonPrefix}. Exporte o extrato em OFX, CSV ou Excel pelo app do banco.`, { reason: scanned ? "PDF_SCANNED" : "PDF_NO_ROWS" });
  const ai = await extractStatementWithAI(opts.householdId, content, { fileName: opts.fileName, messageId: opts.messageId });
  if (!ai.ok && ai.notStatement) throw new ValidationError("A IA analisou o PDF e ele não parece um extrato bancário nem uma fatura de cartão.", { reason: "PDF_NOT_STATEMENT" });
  if (!ai.ok) {
    throw new ValidationError(
      `${reasonPrefix} e a leitura por IA não está disponível (${ai.reason.replace(/\.$/, "")}). Exporte o extrato em OFX, CSV ou Excel pelo app do banco.`,
      { reason: scanned ? "PDF_SCANNED" : "PDF_NO_ROWS" },
    );
  }
  if (!ai.rows.length) throw new ValidationError(`${reasonPrefix} e a IA também não encontrou lançamentos legíveis.`, { reason: "PDF_NO_ROWS" });
  if (ai.rows.length > opts.maxRows) throw new ValidationError(`O PDF tem mais de ${opts.maxRows.toLocaleString("pt-BR")} lançamentos. Divida o período em partes.`);
  return aiResult(ai.rows, ai.kind, ai.bank ?? st.bank, scanned, classification, warnings);
}

function aiResult(rows: PdfRow[], kind: PdfStatementKind, bank: string | null, scanned: boolean, classification: PdfImportResult["classification"], warnings: string[]): PdfImportResult {
  const dates = rows.map((r) => r.date).sort();
  return {
    rows: toParsedRows(rows, "AI"),
    kind,
    bank,
    bankConfident: false,
    startDate: dates[0] ?? null,
    endDate: dates[dates.length - 1] ?? null,
    source: "AI",
    classification: classification === "OTHER" ? "STATEMENT" : classification,
    scanned,
    aiRows: rows,
    warnings: [...warnings, "Lançamentos lidos pela IA a partir do PDF. Confira cada data e valor na prévia antes de importar."],
  };
}
