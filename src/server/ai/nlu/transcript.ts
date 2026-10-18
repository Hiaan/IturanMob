import { normalizeText } from "@/lib/utils";

/**
 * Correções no texto que veio da transcrição de áudio, ANTES do interpretador. Só troca trechos que
 * o Whisper costuma ouvir errado e que decidem o lançamento:
 * - natureza: "em presa" → "empresa"; "personal" no fim/"é personal" → "pessoal";
 * - contas e cartões da família por som parecido: "no bank", "no banque" → "Nubank";
 * - nomes conhecidos (membros, clientes, pessoas das regras): "proí caro" → "pro Ícaro";
 * - centavos: "D87-50", "D87,50" e "87 e 50" → "87,50".
 * Nada é inventado: quando um trecho casa com mais de um nome, fica como está (o fluxo normal
 * pergunta o que faltar). Valores só mudam de forma ("D87-50" → "de 87,50"), nunca de número.
 */

export interface TranscriptVocabulary {
  /** Nomes de contas e cartões (e palavras marcantes deles: "Nubank", "Inter", "Wise"). */
  accounts: string[];
  /** Nomes de pessoas/clientes/estabelecimentos conhecidos ("Ícaro", "Daniel", "Queren"). */
  names: string[];
}

/** Palavras comuns: um trecho só com elas nunca é trocado ("no banco" continua "no banco"). */
const COMMON = new Set(
  "a o as os e de do da dos das no na nos nas em um uma pro pra para pelo pela por com sem ao mais menos que foi e eh paguei gastei comprei recebi banco bancos conta contas cartao credito debito pix dinheiro caro cara reais real mercado loja casa".split(" "),
);
/** Preposições que o Whisper costuma colar no nome seguinte ("proí caro" = "pro Ícaro"). */
const NAME_PREFIXES = ["pro", "pra", "para", "do", "da", "de", "pelo", "pela", "no", "na", "o", "a"];

/** Chave sonora simplificada para português: "no banque" e "Nubank" → "nubank". */
export function soundKey(text: string): string {
  let t = normalizeText(text).replace(/[^a-z0-9]/g, "");
  t = t
    .replace(/ph/g, "f")
    .replace(/qu/g, "k")
    .replace(/ck/g, "k")
    .replace(/c(?=[aou]|$)/g, "k")
    .replace(/y/g, "i")
    .replace(/w/g, "u")
    .replace(/h/g, "")
    .replace(/o/g, "u")
    .replace(/e/g, "i")
    .replace(/(.)\1+/g, "$1")
    // vogal fraca no fim depois de consoante ("banki", "banku") não conta
    .replace(/([^aiu])[iu]$/, "$1");
  return t;
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 9;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

interface Candidate {
  key: string;
  /** Texto que entra no lugar do trecho. */
  replacement: string;
  /** A palavra trocada (a mesma palavra como conta e como nome não é ambiguidade). */
  target: string;
  /** Aceita uma letra de diferença (marcas longas). */
  fuzzy: boolean;
}

function candidates(vocab: TranscriptVocabulary): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of vocab.accounts) {
    const name = raw.trim();
    const key = soundKey(name);
    if (key.length < 4) continue;
    out.push({ key, replacement: name, target: normalizeText(name), fuzzy: key.length >= 6 });
  }
  for (const raw of vocab.names) {
    const name = raw.trim();
    const key = soundKey(name);
    if (key.length < 4) continue;
    out.push({ key, replacement: name, target: normalizeText(name), fuzzy: false });
    for (const p of NAME_PREFIXES) out.push({ key: soundKey(`${p}${name}`), replacement: `${p} ${name}`, target: normalizeText(name), fuzzy: false });
  }
  return out;
}

const WORD = /[\p{L}\p{N}$]+/gu;

/** Natureza mal ouvida: "em presa" → "empresa"; "personal" no fim ou depois de "é/foi" → "pessoal". */
function fixNature(text: string): string {
  return text
    .replace(/\b(?:em|im|in)\s+presa\b/giu, "empresa")
    .replace(/(^|[\s,;:.-])(?:é|e|eh|foi)\s+personal\b/giu, "$1é pessoal")
    .replace(/([,;:.-]\s*)personal(\s*[.!?]?\s*)$/iu, "$1pessoal$2");
}

/**
 * Valor com centavos mal ouvido: "D87-50"/"D87,50" ("de 87,50" colado) → "de 87,50"; "de 87 e 50"
 * (oitenta e sete e cinquenta) → "de 87,50". "100 e 50 de pão" continua sendo dois valores.
 */
function fixMoney(text: string): string {
  return text
    .replace(/(^|[\s(])D\s?(\d{1,6})[-.,](\d{2})(?!\d)/gu, "$1de $2,$3")
    .replace(/(^|[\s(])(de|R\$)\s?(\d{1,6})-(\d{2})(?!\d)/giu, "$1$2 $3,$4")
    .replace(/(^|[\s(])(\d{1,6}) (?:reais )?e (\d{2})(?: centavos)?(?!\d|[,.]\d)(?!\s+(?:de|do|da|dos|das)\s)/gu, "$1$2,$3");
}

export function normalizeTranscript(text: string, vocab: TranscriptVocabulary): string {
  let out = fixMoney(fixNature(text));
  const cands = candidates(vocab);
  if (!cands.length) return out;

  const words = [...out.matchAll(WORD)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < words.length; ) {
    let applied = 0;
    for (const size of [3, 2, 1]) {
      const win = words.slice(i, i + size);
      if (win.length < size) continue;
      if (win.some((w) => /\d|\$/.test(w.text))) continue;
      const norm = win.map((w) => normalizeText(w.text));
      if (norm.every((n) => COMMON.has(n))) continue;
      const key = soundKey(norm.join(""));
      if (key.length < 4) continue;
      const hits = cands.filter((c) => c.key === key || (c.fuzzy && distance(c.key, key) <= 1));
      const targets = new Set(hits.map((h) => h.target));
      if (targets.size !== 1) continue; // nenhum ou ambíguo: deixa como está
      const hit = hits.find((h) => h.key === key) ?? hits[0]!;
      const original = out.slice(win[0]!.start, win[win.length - 1]!.end);
      if (normalizeText(original) === normalizeText(hit.replacement)) break; // já está certo
      replacements.push({ start: win[0]!.start, end: win[win.length - 1]!.end, text: hit.replacement });
      applied = size;
      break;
    }
    i += applied || 1;
  }
  for (const r of replacements.reverse()) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}
