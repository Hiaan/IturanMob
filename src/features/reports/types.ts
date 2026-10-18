/** Tipos do cliente para relatórios (espelham os DTOs do servidor; importações somente de tipo). */
export type {
  Certainty,
  MonthlyReportData,
  ReportCategoryItem,
  ReportData,
  ReportScope,
  ReportUpcomingBill,
  ReportView,
  WeeklyReportData,
} from "@/server/modules/reports/types";

export type ReportKind = "WEEKLY" | "MONTHLY";
export type Regime = "ACCRUAL" | "CASH";

export interface ReportListItem {
  id: string;
  type: ReportKind;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  createdAt: string;
  scheduled: boolean;
  scope: "FAMILY" | "PERSONAL";
  /** Recorte da natureza usado (null em relatórios antigos, antes do recorte). */
  natureScope: "PERSONAL" | "BUSINESS" | "ALL" | null;
  regime: Regime;
  isPartial: boolean;
  totals: { incomeCents: number; expenseCents: number; resultCents: number };
}

export interface ReportScheduleDTO {
  id: string;
  type: ReportKind;
  enabled: boolean;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
  sendWhatsApp: boolean;
  notifyInApp: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface GenerateReportInput {
  type: ReportKind;
  periodStart?: string;
  month?: string;
  scope?: "FAMILY" | "PERSONAL";
  regime?: Regime;
  /** Natureza dos totais: Pessoal, Empresa ou Tudo (sem informar: padrão da família). */
  natureScope?: "PERSONAL" | "BUSINESS" | "ALL";
}
