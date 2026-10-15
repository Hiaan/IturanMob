import { isISODate, makeISO } from "@/lib/dates";
import { decodeText } from "./csv";

/**
 * Leitor de OFX (Open Financial Exchange):
 * - v1 (SGML): cabeçalho "OFXHEADER:100", elementos sem tag de fechamento (<TRNAMT>-45.90);
 * - v2 (XML): <?xml ...?><?OFX ...?> com tags fechadas.
 * Suporta extrato bancário (STMTRS/BANKACCTFROM) e de cartão de crédito (CCSTMTRS/CCACCTFROM).
 */

export interface OfxTransaction {
  trnType: string | null;
  datePosted: string | null;
  /** Centavos com sinal, como informado no arquivo. */
  amountCents: number | null;
  fitId: string | null;
  name: string | null;
  memo: string | null;
  checkNum: string | null;
  refNum: string | null;
}

export interface OfxStatement {
  version: 1 | 2;
  kind: "BANK" | "CREDIT_CARD";
  currency: string | null;
  bankId: string | null;
  branchId: string | null;
  accountId: string | null;
  accountType: string | null;
  startDate: string | null;
  endDate: string | null;
  ledgerBalanceCents: number | null;
  transactions: OfxTransaction[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, "&");
}

/** Valor de um elemento folha (funciona em SGML e XML). */
function leaf(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i");
  const m = re.exec(block);
  if (!m) return null;
  const v = decodeEntities(m[1] ?? "").trim();
  return v === "" ? null : v;
}

function blocks(text: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? "");
  return out;
}

/** "20261005120000[-3:BRT]" → "2026-10-05". */
export function parseOfxDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (!m) return null;
  const iso = makeISO(Number(m[1]), Number(m[2]), Number(m[3]));
  return isISODate(iso) ? iso : null;
}

/** Valor OFX (separador decimal "." — alguns bancos usam ","). Retorna centavos. */
export function parseOfxAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  let s = value.trim().replace(/\s+/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) {
    // "1,234.56" ou "1.234,56"
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const intPart = Number(m[2] || "0");
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = intPart * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return sign * cents;
}

export function isOfx(text: string): boolean {
  const head = text.slice(0, 4000).toUpperCase();
  return head.includes("OFXHEADER") || head.includes("<OFX>") || head.includes("<?OFX");
}

export function parseOfx(input: string | Buffer | Uint8Array): OfxStatement {
  const text = typeof input === "string" ? input.replace(/^﻿/, "") : decodeText(input);
  if (!isOfx(text)) throw new Error("O arquivo não parece ser um OFX válido.");
  const upperHead = text.slice(0, 500).toUpperCase();
  const version: 1 | 2 = upperHead.includes("<?XML") || upperHead.includes("<?OFX") ? 2 : 1;
  const ofxStart = text.search(/<OFX>/i);
  const body = ofxStart >= 0 ? text.slice(ofxStart) : text;

  const isCard = /<CCSTMTRS>/i.test(body);
  const acctBlock = blocks(body, isCard ? "CCACCTFROM" : "BANKACCTFROM")[0] ?? "";
  const tranList = blocks(body, "BANKTRANLIST");
  const ledger = blocks(body, "LEDGERBAL")[0] ?? "";

  const transactions = blocks(body, "STMTTRN").map((b) => ({
    trnType: leaf(b, "TRNTYPE")?.toUpperCase() ?? null,
    datePosted: parseOfxDate(leaf(b, "DTPOSTED") ?? leaf(b, "DTUSER")),
    amountCents: parseOfxAmount(leaf(b, "TRNAMT")),
    fitId: leaf(b, "FITID"),
    name: leaf(b, "NAME") ?? leaf(b, "PAYEE"),
    memo: leaf(b, "MEMO"),
    checkNum: leaf(b, "CHECKNUM"),
    refNum: leaf(b, "REFNUM"),
  }));

  return {
    version,
    kind: isCard ? "CREDIT_CARD" : "BANK",
    currency: leaf(body, "CURDEF"),
    bankId: leaf(acctBlock, "BANKID"),
    branchId: leaf(acctBlock, "BRANCHID"),
    accountId: leaf(acctBlock, "ACCTID"),
    accountType: leaf(acctBlock, "ACCTTYPE"),
    startDate: parseOfxDate(tranList[0] ? leaf(tranList[0], "DTSTART") : null),
    endDate: parseOfxDate(tranList[0] ? leaf(tranList[0], "DTEND") : null),
    ledgerBalanceCents: parseOfxAmount(leaf(ledger, "BALAMT")),
    transactions,
  };
}

/** Descrição legível de uma transação OFX (NAME e MEMO, sem repetição). */
export function ofxDescription(t: OfxTransaction): string {
  const name = (t.name ?? "").replace(/\s+/g, " ").trim();
  const memo = (t.memo ?? "").replace(/\s+/g, " ").trim();
  if (name && memo && !name.toLowerCase().includes(memo.toLowerCase()) && !memo.toLowerCase().includes(name.toLowerCase())) {
    return `${name} - ${memo}`.slice(0, 200);
  }
  return (name.length >= memo.length ? name : memo).slice(0, 200) || "Lançamento importado";
}
