/** Tipos de resposta da API de recorrências (espelham src/server/modules/recurring/service.ts). */
export const FREQUENCIES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY", "CUSTOM_DAYS", "CUSTOM_MONTHS"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface RecurringDTO {
  id: string;
  type: "EXPENSE" | "INCOME";
  description: string;
  amountCents: number;
  isVariableAmount: boolean;
  category: { id: string; name: string; color: string; icon: string } | null;
  subcategory: { id: string; name: string } | null;
  merchant: { id: string; name: string } | null;
  paymentMethod: string | null;
  account: { id: string; name: string; color: string } | null;
  creditCard: { id: string; name: string; color: string } | null;
  ownership: string;
  /** Natureza herdada pelos lançamentos gerados (Pessoal ou Empresa). */
  scope: "PERSONAL" | "BUSINESS";
  responsible: { id: string; displayName: string; color: string } | null;
  frequency: Frequency;
  frequencyLabel: string;
  scheduleLabel: string;
  interval: number;
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
  autoPost: boolean;
  reminderDaysBefore: number;
  active: boolean;
  nextOccurrence: string | null;
  nextScheduledPaymentId: string | null;
  monthlyEquivalentCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringList {
  items: RecurringDTO[];
  totals: { activeCount: number; monthlyExpenseCents: number; monthlyIncomeCents: number; monthlyNetCents: number; estimatedCount: number };
}
