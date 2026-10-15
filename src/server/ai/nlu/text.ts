/** Normalização de texto para o motor local (minúsculas, sem acentos, pontuação útil preservada). */
export function normalizeForNlu(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[“”"']/g, " ")
    .replace(/r\$\s*/g, "r$ ")
    .replace(/[^\p{L}\p{N}\s$.,/:%\-?!]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Limpa entradas não confiáveis: remove caracteres de controle e limita o tamanho. */
export function sanitizeUntrusted(input: string, max = 2000): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/​|‌|‍|﻿/g, "")
    .slice(0, max)
    .trim();
}

export function words(normalized: string): string[] {
  return normalized.split(/\s+/).filter(Boolean);
}

export function containsAny(text: string, terms: string[]): boolean {
  return terms.some((t) => new RegExp(`(^|[^\\p{L}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u").test(text));
}

export function firstMatch(text: string, terms: string[]): string | null {
  for (const t of terms) {
    if (containsAny(text, [t])) return t;
  }
  return null;
}
