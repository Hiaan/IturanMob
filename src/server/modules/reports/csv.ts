import Papa from "papaparse";
import { centsToDecimalString, formatBRL } from "@/lib/money";
import { formatDateBR, type ISODate } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS, TRANSACTION_TYPE_LABELS, labelOf } from "@/lib/labels";
import type { TransactionDTO } from "../transactions/serialize";

/**
 * Linhas de transações para exportação (CSV/XLSX), em português.
 * CSV no padrão do Excel em pt-BR: separador ";", vírgula decimal, BOM UTF-8 e CRLF.
 */

export interface ExportTransactionRow {
  id: string;
  date: ISODate;
  description: string;
  category: string;
  subcategory: string;
  type: string;
  typeLabel: string;
  /** Centavos com sinal: saídas negativas, entradas positivas (transferências: valor transferido). */
  signedAmountCents: number;
  paymentMethod: string;
  accountOrCard: string;
  responsible: string;
  status: string;
  installmentCount: number;
  deleted: boolean;
}

function signedAmount(t: TransactionDTO): number {
  switch (t.type) {
    case "EXPENSE":
    case "CARD_PAYMENT":
      return -t.amountCents;
    case "ADJUSTMENT":
      return t.account ? -t.amountCents : t.amountCents;
    default:
      return t.amountCents;
  }
}

function accountOrCard(t: TransactionDTO): string {
  if (t.type === "TRANSFER") return `${t.account?.name ?? "?"} → ${t.destinationAccount?.name ?? "?"}`;
  if (t.type === "CARD_PAYMENT") return `${t.account?.name ?? "?"} → fatura ${t.creditCard?.name ?? "do cartão"}`;
  if (t.type === "ADJUSTMENT") return t.account?.name ?? t.destinationAccount?.name ?? "";
  return t.creditCard?.name ?? t.account?.name ?? "";
}

function responsible(t: TransactionDTO): string {
  if (t.type === "TRANSFER" || t.type === "CARD_PAYMENT" || t.type === "ADJUSTMENT") return "";
  if (t.ownership === "INDIVIDUAL" && t.responsible) return t.responsible.displayName;
  if (t.allocations.length) return t.allocations.map((a) => `${a.displayName} (${formatBRL(a.amountCents)})`).join("; ");
  return "Família";
}

export function toExportRow(t: TransactionDTO): ExportTransactionRow {
  return {
    id: t.id,
    date: t.date,
    description: t.description,
    category: t.category?.name ?? (t.type === "EXPENSE" || t.type === "INCOME" ? "Sem categoria" : ""),
    subcategory: t.subcategory?.name ?? "",
    type: t.type,
    typeLabel: labelOf(TRANSACTION_TYPE_LABELS, t.type),
    signedAmountCents: signedAmount(t),
    paymentMethod: t.paymentMethod ? labelOf(PAYMENT_METHOD_LABELS, t.paymentMethod) : "",
    accountOrCard: accountOrCard(t),
    responsible: responsible(t),
    status: t.deletedAt ? "Excluída" : t.status === "PENDING" ? "Aguardando confirmação" : "Confirmada",
    installmentCount: t.installmentCount,
    deleted: Boolean(t.deletedAt),
  };
}

export const CSV_HEADERS = ["Data", "Descrição", "Categoria", "Subcategoria", "Tipo", "Valor", "Forma de pagamento", "Conta/Cartão", "Responsável", "Situação"];

/** Evita que planilhas interpretem textos como fórmulas (injeção de fórmulas em CSV). */
export function safeCsvText(value: string): string {
  const v = value.replace(/\r?\n|\r/g, " ");
  return /^[=+\-@\t]/.test(v) ? `'${v}` : v;
}

/** "-1234,56" — vírgula decimal, sem separador de milhar (lido como número pelo Excel pt-BR). */
export function csvAmount(cents: number): string {
  return centsToDecimalString(cents).replace(".", ",");
}

export function renderTransactionsCsv(rows: ExportTransactionRow[]): Buffer {
  const data = rows.map((r) => [
    formatDateBR(r.date),
    safeCsvText(r.description),
    safeCsvText(r.category),
    safeCsvText(r.subcategory),
    r.typeLabel,
    csvAmount(r.signedAmountCents),
    r.paymentMethod,
    safeCsvText(r.accountOrCard),
    safeCsvText(r.responsible),
    r.status,
  ]);
  const text = Papa.unparse({ fields: CSV_HEADERS, data }, { delimiter: ";", newline: "\r\n", quotes: false, header: true });
  return Buffer.from(`﻿${text}\r\n`, "utf8");
}

/** CSV das transações do período do relatório. */
export function renderReportCsv(rows: ExportTransactionRow[]): Buffer {
  return renderTransactionsCsv(rows);
}
