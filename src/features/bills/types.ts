/** Tipos de resposta da API de contas a pagar (espelham src/server/modules/bills/service.ts). */
export type BillStatus = "PENDING" | "OVERDUE" | "POSTED" | "PAID" | "SKIPPED" | "CANCELLED";

export interface BillDTO {
  id: string;
  kind: "SCHEDULED" | "CARD_STATEMENT";
  readOnly: boolean;
  type: "EXPENSE" | "INCOME";
  description: string;
  amountCents: number;
  isEstimate: boolean;
  dueDate: string;
  daysUntilDue: number;
  status: BillStatus;
  statusLabel: string;
  rawStatus: string | null;
  category: { id: string; name: string; color: string; icon: string } | null;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string; color?: string } | null;
  recurring: { id: string; frequency: string; frequencyLabel: string; autoPost: boolean } | null;
  transaction: { id: string; amountCents: number; date: string; status: string; deletedAt: string | null } | null;
  paidAmountCents: number | null;
  paidAt: string | null;
  notes: string | null;
  statement: { id: string; creditCardId: string; referenceMonth: string; closingDate: string; totalCents: number; paidCents: number; status: string } | null;
}

export interface BillTotals {
  pendingCents: number;
  pendingCount: number;
  overdueCents: number;
  overdueCount: number;
  toPayCents: number;
  paidCents: number;
  paidCount: number;
  expectedIncomeCents: number;
  receivedIncomeCents: number;
  statementsCents: number;
}

export interface BillList {
  period: { start: string; end: string };
  today: string;
  items: BillDTO[];
  totals: BillTotals;
}
