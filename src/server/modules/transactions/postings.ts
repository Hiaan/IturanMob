import type { LedgerEntryKind, TransactionStatus, TransactionType } from "@prisma/client";

/**
 * Geração dos movimentos de caixa (ledger) a partir de uma transação — função pura.
 *
 * Regras críticas:
 * - Compra no CRÉDITO não movimenta caixa (gera parcelas na fatura).
 * - TRANSFERÊNCIA gera saída e entrada de mesmo valor (soma zero) — não é receita nem despesa.
 *   Entre contas de moedas diferentes, a entrada é o valor creditado no destino (câmbio efetivo).
 * - PAGAMENTO DE FATURA é saída de caixa vinculada à fatura — não é despesa (a despesa já foi
 *   reconhecida na compra). Isso impede a dupla contabilização.
 * - Transações pendentes de confirmação ou excluídas não movimentam saldo.
 */
export interface PostableTransaction {
  type: TransactionType;
  status: TransactionStatus;
  amountCents: number;
  /** Transferência entre moedas: valor creditado no destino. */
  destinationAmountCents?: number | null;
  date: Date;
  accountId: string | null;
  destinationAccountId: string | null;
  creditCardId: string | null;
  deletedAt: Date | null;
}

export interface LedgerPosting {
  accountId: string;
  kind: LedgerEntryKind;
  amountCents: number;
  date: Date;
}

export function isPostable(tx: Pick<PostableTransaction, "status" | "deletedAt">): boolean {
  return tx.status === "CONFIRMED" && !tx.deletedAt;
}

export function buildLedgerPostings(tx: PostableTransaction): LedgerPosting[] {
  if (!isPostable(tx)) return [];
  const amt = tx.amountCents;
  switch (tx.type) {
    case "EXPENSE":
      if (tx.creditCardId) return [];
      return tx.accountId ? [{ accountId: tx.accountId, kind: "EXPENSE", amountCents: -amt, date: tx.date }] : [];
    case "INCOME":
      return tx.accountId ? [{ accountId: tx.accountId, kind: "INCOME", amountCents: amt, date: tx.date }] : [];
    case "TRANSFER":
      if (!tx.accountId || !tx.destinationAccountId) return [];
      return [
        { accountId: tx.accountId, kind: "TRANSFER_OUT", amountCents: -amt, date: tx.date },
        { accountId: tx.destinationAccountId, kind: "TRANSFER_IN", amountCents: tx.destinationAmountCents ?? amt, date: tx.date },
      ];
    case "CARD_PAYMENT":
      return tx.accountId ? [{ accountId: tx.accountId, kind: "CARD_PAYMENT", amountCents: -amt, date: tx.date }] : [];
    case "ADJUSTMENT": {
      const out: LedgerPosting[] = [];
      if (tx.accountId) out.push({ accountId: tx.accountId, kind: "ADJUSTMENT", amountCents: -amt, date: tx.date });
      if (tx.destinationAccountId) out.push({ accountId: tx.destinationAccountId, kind: "ADJUSTMENT", amountCents: amt, date: tx.date });
      return out;
    }
  }
}

/** Indica se o tipo de transação é contabilizado como despesa/receita familiar. */
export function countsAsExpense(type: TransactionType): boolean {
  return type === "EXPENSE";
}

export function countsAsIncome(type: TransactionType): boolean {
  return type === "INCOME";
}
