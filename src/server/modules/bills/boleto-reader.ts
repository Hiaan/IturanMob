import { findBoletoInText, type ParsedBoleto } from "@/lib/boleto";
import { addDays, type ISODate } from "@/lib/dates";
import { buildLines, normalizePdfText, parseStatementLines, readPdfItems } from "../imports/pdf";

/**
 * Leitura de boleto em documentos (texto de PDF). O código só vale com os dígitos verificadores
 * conferidos; o que o código não traz (vencimento das contas de consumo, nome do beneficiário) vem
 * do próprio documento como sugestão — a pessoa confirma antes de gravar.
 */

export interface BoletoHints {
  /** Nome do beneficiário/cedente impresso no documento. */
  beneficiary: string | null;
  /** Vencimento impresso no documento (AAAA-MM-DD). */
  dueDate: ISODate | null;
  /** "Valor do documento"/"Total a pagar" impresso (centavos). */
  amountCents: number | null;
}

export type PdfBoletoResult =
  | { status: "BOLETO"; boleto: ParsedBoleto; hints: BoletoHints }
  /** Comprovante de pagamento de boleto (já pago): não vira conta a pagar. */
  | { status: "PAID_RECEIPT" }
  | { status: "NOT_BOLETO" };

const LONG_DIGITS = /(?:\d[ .-]?){9,}\d/g;
const PAID = /\b(comprovante de pagamento|pagamento (realizado|efetuado|confirmado)|autenticacao (mecanica|bancaria|eletronica)|transacao (efetuada|realizada)|comprovante de transacao)\b/;
const BOLETO_WORDS = /\b(vencimento|beneficiario|cedente|pagavel|linha digitavel|ficha de compensacao|codigo de barras|nosso numero|sacado|pagador|valor do documento|total a pagar)\b/;

/** Data AAAA-MM-DD a partir de dd/mm/aaaa (ou dd/mm/aa), quando válida. */
function isoFromBR(d: string, m: string, y: string): ISODate | null {
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const iso = `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = Date.parse(`${iso}T12:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? null : iso;
}

function centsFromBR(v: string): number | null {
  const n = Number(v.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** Nome do beneficiário: sem CNPJ/CPF ou números longos, até 80 caracteres. */
export function cleanBeneficiary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .replace(LONG_DIGITS, " ")
    .replace(/\b(cnpj|cpf)\b[:\s]*[\d./-]*/gi, " ")
    .replace(/[\d./-]{11,}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:–-]+|[\s:–-]+$/g, "")
    .trim();
  return s.length >= 3 ? s.slice(0, 80) : null;
}

/** Vencimento, valor e beneficiário impressos no documento (texto livre, linhas do PDF). */
export function boletoHintsFromText(lines: string[], today: ISODate): BoletoHints {
  let beneficiary: string | null = null;
  let dueDate: ISODate | null = null;
  let amountCents: number | null = null;
  const minDate = addDays(today, -400);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const norm = normalizePdfText(line);
    const next = lines[i + 1] ?? "";
    if (!dueDate && /\bvencimento\b/.test(norm)) {
      const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(line) ?? /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(next);
      const iso = m ? isoFromBR(m[1]!, m[2]!, m[3]!) : null;
      if (iso && iso >= minDate) dueDate = iso;
    }
    if (!amountCents && /\b(valor do documento|valor cobrado|total a pagar|valor a pagar|valor total)\b/.test(norm)) {
      const m = /(\d{1,3}(?:\.\d{3})*,\d{2})/.exec(line) ?? /(\d{1,3}(?:\.\d{3})*,\d{2})/.exec(next);
      if (m) amountCents = centsFromBR(m[1]!);
    }
    if (!beneficiary && /\b(beneficiario|cedente)\b/.test(norm)) {
      const after = line.replace(/^.*?(benefici[aá]rio|cedente)\s*(final)?\s*[:\-–]?\s*/i, "");
      beneficiary = cleanBeneficiary(after) ?? cleanBeneficiary(next);
    }
  }
  return { beneficiary, dueDate, amountCents };
}

/** Procura um boleto (a pagar) no texto do documento. */
export function boletoFromDocumentText(lines: string[], today: ISODate): PdfBoletoResult {
  const text = lines.join("\n");
  const norm = normalizePdfText(text);
  const boleto = findBoletoInText(text, today);
  if (!boleto) return { status: "NOT_BOLETO" };
  if (PAID.test(norm)) return { status: "PAID_RECEIPT" };
  if (!BOLETO_WORDS.test(norm)) return { status: "NOT_BOLETO" };
  return { status: "BOLETO", boleto, hints: boletoHintsFromText(lines, today) };
}

/**
 * PDF → boleto. Extratos e faturas (que às vezes trazem um boleto no final) seguem para a
 * importação: só um documento que não é extrato e traz um código válido é tratado como boleto.
 */
export async function readBoletoFromPdf(content: Buffer, today: ISODate): Promise<PdfBoletoResult> {
  let lines: ReturnType<typeof buildLines>;
  try {
    const { pages, items } = await readPdfItems(content);
    lines = buildLines(items);
    const st = parseStatementLines(lines, { today, pages });
    const texts = lines.map((l) => l.text);
    // Boleto tem poucas linhas com data e valor (vencimento, documento, processamento); extrato e
    // fatura têm muitas.
    if (st.rows.length >= 6 || (st.kind !== "UNKNOWN" && st.rows.length >= 3)) return { status: "NOT_BOLETO" };
    return boletoFromDocumentText(texts, today);
  } catch {
    // PDF com senha ou ilegível: a importação de extratos dá a mensagem certa.
    return { status: "NOT_BOLETO" };
  }
}
