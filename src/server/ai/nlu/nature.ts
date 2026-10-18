import { normalizeForNlu } from "./text";

/**
 * Natureza dita na mensagem de lançamento: "pj", "empresa", "da empresa" → Empresa; "pf",
 * "pessoa física", "é pessoal" → Pessoa física. Vale também no meio ("uber 30 pj", "almoço 50
 * empresa"). "pessoal" sozinho no meio da frase não conta ("almoço com o pessoal").
 */
const PJ_RE = /(^|[\s,;.(\/-])(pj|da empresa|pra empresa|para a empresa|empresa)(?=$|[\s,;:.)!?\/-])/;
const PF_RE = /(^|[\s,;.(\/-])(pf|pessoa fisica)(?=$|[\s,;:.)!?\/-])|\b(e|eh|foi)\s+pessoal\b|[,;-]\s*pessoal\s*[.!]?$/;

/** Remove os marcadores do texto original (com acentos) para não virarem descrição. */
const STRIP_RE =
  /(^|[\s,;.(\/-])(?:(?:é|e|eh|foi)\s+)?(?:(?:da|pra|para a)\s+)?(?:pj|empresa|pf|pessoa\s+f[ií]sica)(?=$|[\s,;:.)!?\/-])|(?:^|\s)(?:é|e|eh|foi)\s+pessoal\b|[,;-]\s*pessoal\s*[.!]?$/giu;

export interface NatureTokens {
  nature: "PERSONAL" | "BUSINESS" | null;
  /** PF e PJ na mesma mensagem: cada trecho decide. */
  both: boolean;
  /** Texto sem os marcadores (quando há um só tipo). */
  stripped: string;
}

/** "anota 50 de uber pf": "pf" no fim de um pedido é "por favor". */
const POR_FAVOR_RE = /^(anota|anote|registra|registre|lanca|lance|coloca|coloque|bota|poe|adiciona|adicione|inclui|inclua|salva|salve)\b.*\spf\s*[.!]?$/;

export function stripNatureTokens(text: string): string {
  return text
    .replace(STRIP_RE, "$1")
    .replace(/\s+([,;.!?])/g, "$1")
    .replace(/^[\s,;:.!-]+/u, "")
    .replace(/[\s,;.!-]+$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function detectNatureTokens(text: string): NatureTokens {
  const norm = normalizeForNlu(text).trim();
  const pj = PJ_RE.test(norm);
  const pf = PF_RE.test(POR_FAVOR_RE.test(norm) ? norm.replace(/\spf\s*[.!]?$/, "") : norm);
  if (pj && pf) return { nature: null, both: true, stripped: text };
  if (!pj && !pf) return { nature: null, both: false, stripped: text };
  return { nature: pj ? "BUSINESS" : "PERSONAL", both: false, stripped: stripNatureTokens(text) || text };
}
