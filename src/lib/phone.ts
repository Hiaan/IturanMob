/**
 * Telefones digitados por pessoas (cadastro de membros). Função pura, usada no navegador e no servidor.
 */

/** DDD + número nacional brasileiro: celular (9 + 8 dígitos) ou fixo/celular antigo (8 dígitos de 2 a 9). */
function isBrazilianNational(digits: string): boolean {
  if (!/^[1-9][1-9]/.test(digits)) return false;
  const local = digits.slice(2);
  return (local.length === 9 && local.startsWith("9")) || (local.length === 8 && /^[2-9]/.test(local));
}

/**
 * Normaliza um telefone digitado por uma pessoa para E.164.
 * - Com "+" ou "00" na frente, o DDI informado é mantido ("+1 212 555-1234" → "+12125551234").
 * - Sem DDI, DDD + número brasileiro recebe +55 ("(83) 99999-5364" → "+5583999995364"),
 *   inclusive com o 0 de longa distância ("083…") ou com código de operadora ("0 21 83…").
 * - "55" + DDD + número sem o "+" também é reconhecido.
 * Retorna null quando o formato é ambíguo (ex.: número estrangeiro sem "+").
 */
export function normalizePhoneInput(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  let digits = raw.replace(/\D/g, "");
  const international = raw.startsWith("+") || digits.startsWith("00");
  if (international) {
    if (!raw.startsWith("+")) digits = digits.slice(2);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.startsWith("0")) {
    if (digits.length === 11 || digits.length === 12) digits = digits.slice(1);
    else if (digits.length === 13 || digits.length === 14) digits = digits.slice(3);
  }
  if ((digits.length === 10 || digits.length === 11) && isBrazilianNational(digits)) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55") && isBrazilianNational(digits.slice(2))) return `+${digits}`;
  return null;
}
