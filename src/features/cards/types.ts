/** Tipos das respostas de faturas (espelham src/server/modules/cards/service.ts). */
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
    payerName: string | null;
  }>;
  payments: Array<{ id: string; amountCents: number; date: string; status: string; account: { name: string } | null }>;
}

export interface Commitment {
  month: string;
  amountCents: number;
}

export const CARD_BRANDS = ["Visa", "Mastercard", "Elo", "American Express", "Hipercard", "Diners Club", "Outra"] as const;
