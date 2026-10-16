import { z } from "zod";
import { MAX_AMOUNT_CENTS } from "@/lib/money";
import { isISODate } from "@/lib/dates";

export const isoDateSchema = z.string().refine((v) => isISODate(v), "Data inválida (use AAAA-MM-DD)");
export const idSchema = z.string().min(1).max(64);
export const amountCentsSchema = z
  .number({ error: "Valor inválido" })
  .int("O valor deve estar em centavos")
  .positive("O valor deve ser maior que zero")
  .max(MAX_AMOUNT_CENTS, "Valor acima do limite permitido");

export const TRANSACTION_TYPES = ["EXPENSE", "INCOME", "TRANSFER", "CARD_PAYMENT", "ADJUSTMENT"] as const;
export const PAYMENT_METHODS = ["PIX", "DEBIT_CARD", "CREDIT_CARD", "CASH", "BANK_SLIP", "BANK_TRANSFER", "AUTO_DEBIT", "VOUCHER", "OTHER"] as const;
export const TRANSACTION_SOURCES = ["MANUAL", "WHATSAPP_TEXT", "WHATSAPP_AUDIO", "WHATSAPP_IMAGE", "DASHBOARD_CHAT", "IMPORT", "RECURRING", "SYSTEM"] as const;

export const allocationSchema = z.object({
  memberId: idSchema,
  amountCents: amountCentsSchema,
});

export const transactionFieldsSchema = z.object({
  type: z.enum(TRANSACTION_TYPES),
  amountCents: amountCentsSchema,
  description: z.string().trim().min(1, "Informe uma descrição").max(200),
  notes: z.string().trim().max(2000).nullish(),
  date: isoDateSchema,
  competenceDate: isoDateSchema.nullish(),
  categoryId: idSchema.nullish(),
  subcategoryId: idSchema.nullish(),
  merchantName: z.string().trim().max(120).nullish(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
  accountId: idSchema.nullish(),
  destinationAccountId: idSchema.nullish(),
  /** Transferência entre contas de moedas diferentes: valor creditado no destino (na moeda dele). */
  destinationAmountCents: amountCentsSchema.nullish(),
  creditCardId: idSchema.nullish(),
  statementId: idSchema.nullish(),
  installmentCount: z.number().int().min(1).max(72).default(1),
  payerMemberId: idSchema.nullish(),
  ownership: z.enum(["SHARED", "INDIVIDUAL"]).default("SHARED"),
  responsibleMemberId: idSchema.nullish(),
  allocations: z.array(allocationSchema).max(12).nullish(),
  status: z.enum(["CONFIRMED", "PENDING"]).default("CONFIRMED"),
  goalId: idSchema.nullish(),
});

export const transactionCreateSchema = transactionFieldsSchema.extend({
  /** Natureza: Pessoal (padrão), Empresa ou Repasse (desconsiderado nos relatórios). Sem informar, valem as regras. */
  nature: z.enum(["PERSONAL", "BUSINESS", "PASSTHROUGH"]).nullish(),
});
export type TransactionCreateInput = z.input<typeof transactionCreateSchema>;
export type TransactionFields = z.output<typeof transactionFieldsSchema>;

export const transactionUpdateSchema = transactionFieldsSchema
  .omit({ status: true })
  .partial()
  .extend({ expectedVersion: z.number().int().positive().optional() });
export type TransactionUpdateInput = z.input<typeof transactionUpdateSchema>;

export const transactionListSchema = z.object({
  start: isoDateSchema.optional(),
  end: isoDateSchema.optional(),
  dateField: z.enum(["date", "competenceDate"]).default("date"),
  types: z.array(z.enum(TRANSACTION_TYPES)).optional(),
  status: z.enum(["CONFIRMED", "PENDING"]).optional(),
  categoryIds: z.array(idSchema).optional(),
  subcategoryId: idSchema.optional(),
  accountId: idSchema.optional(),
  creditCardId: idSchema.optional(),
  memberId: idSchema.optional(),
  personMode: z.enum(["any", "payer", "responsible"]).default("any"),
  ownership: z.enum(["SHARED", "INDIVIDUAL"]).optional(),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).optional(),
  sources: z.array(z.enum(TRANSACTION_SOURCES)).optional(),
  minAmountCents: z.number().int().min(0).optional(),
  maxAmountCents: z.number().int().min(0).optional(),
  search: z.string().trim().max(120).optional(),
  merchantId: idSchema.optional(),
  uncategorized: z.boolean().optional(),
  deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  /** Desconsiderados nos relatórios: mostrar junto (padrão), ocultar ou só eles. */
  excluded: z.enum(["all", "hide", "only"]).default("all"),
  /** Natureza Pessoal/Empresa (repasses: ver `excluded`). */
  scope: z.enum(["PERSONAL", "BUSINESS"]).optional(),
  /** Só os que uma regra pediu para escolher a natureza. */
  natureReview: z.boolean().optional(),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc", "created_desc"]).default("date_desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(500).default(50),
});
export type TransactionListFilters = z.input<typeof transactionListSchema>;
