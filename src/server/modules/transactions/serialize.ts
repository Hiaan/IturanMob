import type { Prisma } from "@prisma/client";
import { dateToISO } from "@/lib/dates";

export const transactionInclude = {
  category: { select: { id: true, name: true, color: true, icon: true, kind: true } },
  subcategory: { select: { id: true, name: true } },
  merchant: { select: { id: true, name: true } },
  account: { select: { id: true, name: true, color: true, icon: true } },
  destinationAccount: { select: { id: true, name: true, color: true, icon: true, currency: true } },
  creditCard: { select: { id: true, name: true, color: true } },
  statement: { select: { id: true, referenceMonth: true } },
  payer: { select: { id: true, displayName: true, color: true } },
  responsible: { select: { id: true, displayName: true, color: true } },
  allocations: { include: { member: { select: { id: true, displayName: true, color: true } } } },
  excludedBy: { select: { id: true, displayName: true } },
  _count: { select: { attachments: true } },
} satisfies Prisma.TransactionInclude;

export type TransactionWithRelations = Prisma.TransactionGetPayload<{ include: typeof transactionInclude }>;

export interface TransactionDTO {
  id: string;
  type: string;
  status: string;
  amountCents: number;
  /** Moeda de amountCents (BRL, USD…). */
  currency: string;
  /** Transferência entre moedas: valor creditado no destino. */
  destinationAmountCents: number | null;
  /** Em moeda estrangeira: valor em reais pela PTAX da data. */
  amountBrlCents: number | null;
  description: string;
  notes: string | null;
  date: string;
  competenceDate: string;
  paymentMethod: string | null;
  installmentCount: number;
  ownership: string;
  source: string;
  sourceMessageId: string | null;
  sourceIndex: number;
  confidenceScore: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  goalId: string | null;
  /** Pessoal (família) ou da empresa. */
  scope: "PERSONAL" | "BUSINESS";
  /** Natureza exibida: Pessoal, Empresa ou Repasse (= desconsiderado nos relatórios). */
  nature: "PERSONAL" | "BUSINESS" | "PASSTHROUGH";
  /** Uma regra pediu para escolher a natureza. */
  natureReview: boolean;
  /** Desconsiderado nos relatórios: continua no saldo, no ledger e na fatura. */
  excludedFromReports: boolean;
  exclusion: {
    reason: "CLIENT_PASSTHROUGH" | "REIMBURSEMENT" | "OTHER";
    party: string | null;
    note: string | null;
    excludedAt: string | null;
    excludedBy: { id: string; displayName: string } | null;
  } | null;
  category: { id: string; name: string; color: string; icon: string; kind: string } | null;
  subcategory: { id: string; name: string } | null;
  merchant: { id: string; name: string } | null;
  account: { id: string; name: string; color: string; icon: string } | null;
  destinationAccount: { id: string; name: string; color: string; icon: string; currency: string } | null;
  creditCard: { id: string; name: string; color: string } | null;
  statement: { id: string; referenceMonth: string } | null;
  payer: { id: string; displayName: string; color: string } | null;
  responsible: { id: string; displayName: string; color: string } | null;
  allocations: Array<{ memberId: string; displayName: string; color: string; amountCents: number }>;
  attachmentsCount: number;
  aiMetadata: unknown;
  installments?: unknown[];
  attachments?: unknown[];
  sourceMessage?: unknown;
}

export function serializeTransaction(tx: TransactionWithRelations): TransactionDTO {
  return {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    amountCents: tx.amountCents,
    currency: tx.currency,
    destinationAmountCents: tx.destinationAmountCents,
    amountBrlCents: tx.amountBrlCents,
    description: tx.description,
    notes: tx.notes,
    date: dateToISO(tx.date),
    competenceDate: dateToISO(tx.competenceDate),
    paymentMethod: tx.paymentMethod,
    installmentCount: tx.installmentCount,
    ownership: tx.ownership,
    source: tx.source,
    sourceMessageId: tx.sourceMessageId,
    sourceIndex: tx.sourceIndex,
    confidenceScore: tx.confidenceScore,
    version: tx.version,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
    deletedAt: tx.deletedAt?.toISOString() ?? null,
    goalId: tx.goalId,
    scope: tx.scope,
    nature: tx.excludedFromReports ? "PASSTHROUGH" : tx.scope === "BUSINESS" ? "BUSINESS" : "PERSONAL",
    natureReview: tx.natureReview,
    excludedFromReports: tx.excludedFromReports,
    exclusion: tx.excludedFromReports
      ? {
          reason: tx.exclusionReason ?? "OTHER",
          party: tx.exclusionParty,
          note: tx.exclusionNote,
          excludedAt: tx.excludedAt?.toISOString() ?? null,
          excludedBy: tx.excludedBy,
        }
      : null,
    category: tx.category,
    subcategory: tx.subcategory,
    merchant: tx.merchant,
    account: tx.account,
    destinationAccount: tx.destinationAccount,
    creditCard: tx.creditCard,
    statement: tx.statement,
    payer: tx.payer,
    responsible: tx.responsible,
    allocations: tx.allocations.map((a) => ({ memberId: a.memberId, displayName: a.member.displayName, color: a.member.color, amountCents: a.amountCents })),
    attachmentsCount: tx._count.attachments,
    aiMetadata: tx.aiMetadata,
  };
}
