/** Tipos das respostas de faturas (espelham src/server/modules/cards/service.ts). */
import type { TransactionNature } from "@/features/finance/types";

export type StatementStatus = "OPEN" | "CLOSED" | "PAID" | "PARTIAL" | "OVERDUE" | "FUTURE";

export interface StatementListItem {
  id: string;
  creditCardId: string;
  referenceMonth: string;
  closingDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  installmentsCount: number;
  status: StatementStatus;
}

export interface StatementDetail extends StatementListItem {
  card: { id: string; name: string; color: string; paymentAccountId: string | null };
  installments: Array<{
    id: string;
    number: number;
    totalInstallments: number;
    amountCents: number;
    transactionId: string;
    description: string;
    purchaseDate: string;
    totalAmountCents: number;
    category: { name: string; color: string } | null;
    categoryId: string | null;
    /** Natureza do lançamento (só muda relatórios; a fatura cobra tudo). */
    nature: TransactionNature;
    payerName: string | null;
  }>;
  payments: Array<{ id: string; amountCents: number; date: string; status: string; account: { name: string } | null }>;
  /** Resumo por categoria (do maior para o menor; "Sem categoria" incluído). */
  byCategory: CategorySlice[];
  /** Valor por natureza, em centavos. */
  byNature: Record<TransactionNature, number>;
}

/** Fatia de categoria de uma fatura (espelha CategorySlice do servidor). */
export interface CategorySlice {
  categoryId: string | null;
  name: string;
  color: string;
  amountCents: number;
  percent: number;
  count: number;
}

export interface StatementCategorySummary {
  statementId: string;
  referenceMonth: string;
  dueDate: string;
  totalCents: number;
  byCategory: CategorySlice[];
  byNature: Record<TransactionNature, number>;
}

/** GET /api/v1/cards/spending-by-category: fatura atual (aberta) × anterior, por cartão e somando todos. */
export interface CardsSpendingByCategory {
  cards: Array<{ card: { id: string; name: string; color: string }; current: StatementCategorySummary | null; previous: StatementCategorySummary | null }>;
  combined: {
    current: { totalCents: number; byCategory: CategorySlice[] };
    previous: { totalCents: number; byCategory: CategorySlice[] };
  };
}

export interface Commitment {
  month: string;
  amountCents: number;
}

export const CARD_BRANDS = ["Visa", "Mastercard", "Elo", "American Express", "Hipercard", "Diners Club", "Outra"] as const;
