import { z } from "zod";
import { isISODate, resolvePeriod, todayISO, type Period, type PeriodPreset } from "@/lib/dates";
import { qs } from "./handler";

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "thisWeek",
  "thisMonth",
  "lastMonth",
  "last3Months",
  "last6Months",
  "last12Months",
  "thisYear",
  "lastYear",
  "custom",
] as const;

export const periodQuerySchema = z.object({
  preset: z.enum(PERIOD_PRESETS).default("thisMonth"),
  start: z.string().refine(isISODate).optional(),
  end: z.string().refine(isISODate).optional(),
  regime: z.enum(["ACCRUAL", "CASH"]).optional(),
  memberId: z.string().optional(),
  accountId: z.string().optional(),
  creditCardId: z.string().optional(),
  categoryIds: qs.list(z.string()),
  /** Natureza: Pessoal, Empresa ou Tudo (padrão da família quando não informado). */
  scope: z.enum(["PERSONAL", "BUSINESS", "ALL"]).optional(),
  /** Forma de pagamento (ex.: CREDIT_CARD para "só cartão"). */
  paymentMethod: z.enum(["PIX", "DEBIT_CARD", "CREDIT_CARD", "CASH", "BANK_SLIP", "BANK_TRANSFER", "AUTO_DEBIT", "VOUCHER", "OTHER"]).optional(),
});

export type PeriodQuery = z.output<typeof periodQuerySchema>;

export function periodFromQuery(q: { preset: PeriodPreset; start?: string; end?: string }, timezone: string): Period {
  return resolvePeriod(q.preset, todayISO(timezone), { start: q.start, end: q.end });
}

export function filtersFromQuery(q: PeriodQuery) {
  return { memberId: q.memberId, accountId: q.accountId, creditCardId: q.creditCardId, categoryIds: q.categoryIds, scope: q.scope, paymentMethod: q.paymentMethod };
}
