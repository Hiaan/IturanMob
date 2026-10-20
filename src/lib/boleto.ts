/**
 * Boleto: leitura e validação da linha digitável / código de barras (padrão FEBRABAN).
 *
 * - Bancário: linha de 47 dígitos (código de barras de 44). Banco, valor e vencimento vêm do
 *   próprio código; os dígitos verificadores (3 campos em módulo 10 e o geral em módulo 11) são
 *   conferidos — código com dígito errado é recusado (nada é "adivinhado").
 * - Arrecadação (contas de consumo, tributos; começa com 8): linha de 48 dígitos (4 blocos de 12).
 *   O valor vem do código quando o identificador indica valor efetivo; o vencimento não faz parte do
 *   padrão (fica em aberto para a pessoa informar ou vir do documento).
 *
 * Vencimento do bancário: fator de 4 dígitos contado a partir de 07/10/1997; em 22/02/2025 o fator
 * voltou para 1000. Entre as duas leituras possíveis, vale a mais próxima de hoje.
 */

export type BoletoKind = "BANK" | "UTILITY";

export interface ParsedBoleto {
  kind: BoletoKind;
  /** Linha digitável só com dígitos (47 ou 48). */
  digitableLine: string;
  /** Código de barras (44 dígitos). */
  barcode: string;
  /** Valor em centavos (null = não informado no código: valor em aberto ou de referência). */
  amountCents: number | null;
  /** Vencimento AAAA-MM-DD (null = sem vencimento no código). */
  dueDate: string | null;
  /** Bancário: código e nome do banco emissor. */
  bankCode: string | null;
  bankName: string | null;
  /** Arrecadação: segmento (energia, água, telefone, tributos…). */
  segment: string | null;
}

export type BoletoError = "LENGTH" | "CHECK_DIGIT" | "FORMAT";

const BANKS: Record<string, string> = {
  "001": "Banco do Brasil",
  "004": "Banco do Nordeste",
  "021": "Banestes",
  "033": "Santander",
  "041": "Banrisul",
  "070": "BRB",
  "077": "Inter",
  "085": "Ailos",
  "104": "Caixa",
  "133": "Cresol",
  "136": "Unicred",
  "197": "Stone",
  "208": "BTG Pactual",
  "212": "Banco Original",
  "237": "Bradesco",
  "260": "Nubank",
  "290": "PagBank",
  "323": "Mercado Pago",
  "336": "C6 Bank",
  "341": "Itaú",
  "380": "PicPay",
  "403": "Cora",
  "422": "Safra",
  "655": "Votorantim",
  "707": "Daycoval",
  "748": "Sicredi",
  "756": "Sicoob",
};

const SEGMENTS: Record<string, string> = {
  "1": "Prefeitura",
  "2": "Água e saneamento",
  "3": "Energia elétrica e gás",
  "4": "Telecomunicações",
  "5": "Órgão governamental",
  "6": "Carnê / convênio",
  "7": "Multa de trânsito",
  "9": "Uso do banco",
};

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/** Módulo 10 (pesos 2,1,2,1… da direita para a esquerda; soma dos algarismos dos produtos). */
export function mod10(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    let p = Number(digits[i]) * weight;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    weight = weight === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

/** Soma do módulo 11 (pesos 2 a 9, da direita para a esquerda). */
function mod11Sum(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  return sum;
}

/** DV geral do boleto bancário: 11 − resto; 0, 10 e 11 viram 1. */
export function mod11Bank(digits: string): number {
  const dv = 11 - (mod11Sum(digits) % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

/** DV da arrecadação em módulo 11: 11 − resto; resultados acima de 9 viram 0. */
export function mod11Utility(digits: string): number {
  const dv = 11 - (mod11Sum(digits) % 11);
  return dv > 9 ? 0 : dv;
}

const DAY_MS = 86_400_000;
const isoAddDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Vencimento a partir do fator (null para fator 0000: sem vencimento). */
export function dueDateFromFactor(factor: string, today: string): string | null {
  const f = Number(factor);
  if (!f) return null;
  const old = isoAddDays("1997-10-07", f);
  const candidates = f >= 1000 ? [old, isoAddDays("2025-02-22", f - 1000)] : [old];
  const t = Date.parse(`${today}T12:00:00Z`);
  return candidates.sort((a, b) => Math.abs(Date.parse(`${a}T12:00:00Z`) - t) - Math.abs(Date.parse(`${b}T12:00:00Z`) - t))[0]!;
}

function parseBankBarcode(barcode: string, digitableLine: string, today: string): ParsedBoleto | BoletoError {
  if (mod11Bank(barcode.slice(0, 4) + barcode.slice(5)) !== Number(barcode[4])) return "CHECK_DIGIT";
  const bankCode = barcode.slice(0, 3);
  const amount = Number(barcode.slice(9, 19));
  return {
    kind: "BANK",
    digitableLine,
    barcode,
    amountCents: amount > 0 ? amount : null,
    dueDate: dueDateFromFactor(barcode.slice(5, 9), today),
    bankCode,
    bankName: BANKS[bankCode] ?? null,
    segment: null,
  };
}

function bankLineFromBarcode(barcode: string): string {
  const free = barcode.slice(19);
  const f1 = barcode.slice(0, 4) + free.slice(0, 5);
  const f2 = free.slice(5, 15);
  const f3 = free.slice(15, 25);
  return `${f1}${mod10(f1)}${f2}${mod10(f2)}${f3}${mod10(f3)}${barcode[4]}${barcode.slice(5, 19)}`;
}

function parseUtilityBarcode(barcode: string, digitableLine: string): ParsedBoleto | BoletoError {
  if (barcode[0] !== "8") return "FORMAT";
  const valueId = barcode[2]!;
  const useMod10 = valueId === "6" || valueId === "7";
  if (!useMod10 && valueId !== "8" && valueId !== "9") return "FORMAT";
  const rest = barcode.slice(0, 3) + barcode.slice(4);
  const dv = useMod10 ? mod10(rest) : mod11Utility(rest);
  if (dv !== Number(barcode[3])) return "CHECK_DIGIT";
  const effective = valueId === "6" || valueId === "8";
  const amount = Number(barcode.slice(4, 15));
  return {
    kind: "UTILITY",
    digitableLine,
    barcode,
    amountCents: effective && amount > 0 ? amount : null,
    dueDate: null,
    bankCode: null,
    bankName: null,
    segment: SEGMENTS[barcode[1]!] ?? null,
  };
}

function utilityLineFromBarcode(barcode: string): string {
  const useMod10 = barcode[2] === "6" || barcode[2] === "7";
  let line = "";
  for (let i = 0; i < 4; i++) {
    const block = barcode.slice(i * 11, i * 11 + 11);
    line += block + (useMod10 ? mod10(block) : mod11Utility(block));
  }
  return line;
}

/**
 * Lê uma linha digitável (47/48 dígitos) ou um código de barras (44), com ou sem pontos e espaços.
 * Devolve o boleto ou o motivo da recusa.
 */
export function parseBoleto(input: string, today: string): ParsedBoleto | BoletoError {
  const d = onlyDigits(input);
  if (d.length === 47) {
    const f1 = d.slice(0, 9);
    const f2 = d.slice(10, 20);
    const f3 = d.slice(21, 31);
    if (mod10(f1) !== Number(d[9]) || mod10(f2) !== Number(d[20]) || mod10(f3) !== Number(d[31])) return "CHECK_DIGIT";
    const barcode = d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
    return parseBankBarcode(barcode, d, today);
  }
  if (d.length === 48) {
    if (d[0] !== "8") return "FORMAT";
    const useMod10 = d[2] === "6" || d[2] === "7";
    let barcode = "";
    for (let i = 0; i < 4; i++) {
      const block = d.slice(i * 12, i * 12 + 11);
      const dv = useMod10 ? mod10(block) : mod11Utility(block);
      if (dv !== Number(d[i * 12 + 11])) return "CHECK_DIGIT";
      barcode += block;
    }
    return parseUtilityBarcode(barcode, d);
  }
  if (d.length === 44) {
    return d[0] === "8" ? parseUtilityBarcode(d, utilityLineFromBarcode(d)) : parseBankBarcode(d, bankLineFromBarcode(d), today);
  }
  return "LENGTH";
}

export function isBoleto(v: ParsedBoleto | BoletoError): v is ParsedBoleto {
  return typeof v === "object";
}

/** "34191.79001 01043.510047 91020.150008 1 96610000017500" (bancário) ou 4 blocos de 12 (arrecadação). */
export function formatDigitableLine(line: string): string {
  if (line.length === 47) {
    return `${line.slice(0, 5)}.${line.slice(5, 10)} ${line.slice(10, 15)}.${line.slice(15, 21)} ${line.slice(21, 26)}.${line.slice(26, 32)} ${line[32]} ${line.slice(33)}`;
  }
  if (line.length === 48) return [0, 12, 24, 36].map((i) => `${line.slice(i, i + 11)}-${line[i + 11]}`).join(" ");
  return line;
}

/**
 * Procura uma linha digitável válida num texto (mensagem colada, texto de PDF). Só aceita sequências
 * cujos dígitos verificadores conferem.
 */
export function findBoletoInText(text: string, today: string): ParsedBoleto | null {
  const candidates = text.match(/\d[\d.\s-]{38,70}\d/g) ?? [];
  for (const c of candidates) {
    const digits = onlyDigits(c);
    for (const len of [48, 47, 44]) {
      for (let start = 0; start + len <= digits.length; start++) {
        const parsed = parseBoleto(digits.slice(start, start + len), today);
        if (isBoleto(parsed)) return parsed;
      }
    }
  }
  return null;
}

/** Nome curto para a conta a pagar quando o documento não traz o beneficiário. */
export function boletoLabel(b: ParsedBoleto): string {
  if (b.kind === "UTILITY") return b.segment ? `Conta: ${b.segment}` : "Conta (boleto de arrecadação)";
  return b.bankName ? `Boleto ${b.bankName}` : "Boleto";
}
