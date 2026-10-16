/** Tipos da resposta de GET /api/v1/fixed-expenses (espelham src/server/modules/fixed-expenses/service.ts). */
import type { ReportScope } from "@/features/finance/types";

export interface FixedRecurringItem {
  id: string;
  description: string;
  amountCents: number;
  /** Conta variável: o valor é uma estimativa (mostrar "≈"). */
  isEstimate: boolean;
  frequencyLabel: string;
  scheduleLabel: string;
  dayOfMonth: number | null;
  nextDueDate: string | null;
  monthlyEquivalentCents: number;
  scope: "PERSONAL" | "BUSINESS";
  category: { id: string; name: string; color: string } | null;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string } | null;
}

export interface InstallmentPlanItem {
  transactionId: string;
  description: string;
  purchaseDate: string;
  card: { id: string; name: string; color: string };
  category: { id: string; name: string; color: string } | null;
  scope: "PERSONAL" | "BUSINESS";
  totalAmountCents: number;
  installmentAmountCents: number;
  totalInstallments: number;
  /** Próxima parcela a vencer (a "atual"). */
  currentNumber: number;
  remainingCount: number;
  remainingCents: number;
  /** Mês (AAAA-MM) da última parcela. */
  endsMonth: string;
}

export interface InstallmentsByCard {
  card: { id: string; name: string; color: string };
  count: number;
  remainingCents: number;
  nextInstallmentsCents: number;
  endsMonth: string;
}

export interface ProjectionMonth {
  month: string;
  /** Contas fixas pagas por conta (fora do cartão). */
  recurringCents: number;
  /** Assinaturas e contas fixas cobradas no cartão. */
  recurringOnCardCents: number;
  installmentsByCard: Array<{ cardId: string; cardName: string; amountCents: number }>;
  installmentsCents: number;
  totalCents: number;
  /** Parcelamentos que terminam neste mês e quanto deixam de pesar a partir do mês seguinte. */
  endingCount: number;
  releasesNextMonthCents: number;
}

export interface FixedExpensesOverview {
  scope: ReportScope;
  generatedAt: string;
  today: string;
  recurring: { items: FixedRecurringItem[]; monthlyTotalCents: number; estimatedCount: number };
  installments: { items: InstallmentPlanItem[]; byCard: InstallmentsByCard[]; totalRemainingCents: number; nextInstallmentsCents: number };
  projection: ProjectionMonth[];
  assumptions: string[];
}
