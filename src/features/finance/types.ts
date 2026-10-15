/** Tipos de resposta da API usados no cliente (espelham os DTOs do servidor). */
export interface AccountDTO {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  visibility: string;
  ownerMemberId: string | null;
  ownerName: string | null;
  initialBalanceCents: number;
  initialBalanceDate: string;
  balanceCents: number;
  color: string;
  icon: string;
  includeInTotals: boolean;
  archivedAt: string | null;
  transactionsCount: number;
}

export interface StatementDTO {
  id?: string;
  referenceMonth: string;
  closingDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  status: string;
  installmentsCount?: number;
}

export interface CardDTO {
  id: string;
  name: string;
  issuer: string | null;
  brand: string | null;
  last4: string | null;
  holderMemberId: string | null;
  holderName: string | null;
  visibility: string;
  limitCents: number;
  usedLimitCents: number;
  availableLimitCents: number | null;
  closingDay: number;
  dueDay: number;
  paymentAccountId: string | null;
  paymentAccountName: string | null;
  color: string;
  icon: string;
  archivedAt: string | null;
  currentStatement: StatementDTO;
  nextDueStatement: StatementDTO | null;
  outstandingCents: number;
}

export interface SubcategoryDTO {
  id: string;
  name: string;
  keywords: string[];
  archivedAt: string | null;
}

export interface CategoryDTO {
  id: string;
  name: string;
  kind: "EXPENSE" | "INCOME";
  icon: string;
  color: string;
  isSystem: boolean;
  sortOrder: number;
  archivedAt: string | null;
  transactionsCount: number;
  subcategories: SubcategoryDTO[];
}

export interface MemberDTO {
  id: string;
  displayName: string;
  relation: string | null;
  role: string;
  color: string;
  isActive: boolean;
  hasLogin: boolean;
  email: string | null;
  lastLoginAt: string | null;
  canViewOthersPrivate: boolean;
  whatsappPhone: string | null;
  whatsappAuthorized: boolean;
  whatsappConsentAt: string | null;
  isMe: boolean;
}

export interface TransactionDTO {
  id: string;
  type: "EXPENSE" | "INCOME" | "TRANSFER" | "CARD_PAYMENT" | "ADJUSTMENT";
  status: "CONFIRMED" | "PENDING";
  amountCents: number;
  description: string;
  notes: string | null;
  date: string;
  competenceDate: string;
  paymentMethod: string | null;
  installmentCount: number;
  ownership: "SHARED" | "INDIVIDUAL";
  source: string;
  sourceMessageId: string | null;
  confidenceScore: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  goalId: string | null;
  category: { id: string; name: string; color: string; icon: string; kind: string } | null;
  subcategory: { id: string; name: string } | null;
  merchant: { id: string; name: string } | null;
  account: { id: string; name: string; color: string; icon: string } | null;
  destinationAccount: { id: string; name: string; color: string; icon: string } | null;
  creditCard: { id: string; name: string; color: string } | null;
  statement: { id: string; referenceMonth: string } | null;
  payer: { id: string; displayName: string; color: string } | null;
  responsible: { id: string; displayName: string; color: string } | null;
  allocations: Array<{ memberId: string; displayName: string; color: string; amountCents: number }>;
  attachmentsCount: number;
  installments?: Array<{ id: string; number: number; totalInstallments: number; amountCents: number; dueDate: string; referenceMonth: string; statementId: string }>;
  attachments?: Array<{ id: string; kind: string; mimeType: string; createdAt: string; contentDeletedAt: string | null; processingStatus: string }>;
  history?: Array<{ id: string; action: string; actorType: string; actorMemberId: string | null; createdAt: string; metadata: unknown; source: string | null }>;
}

export interface TransactionList {
  items: TransactionDTO[];
  total: number;
  page: number;
  pageSize: number;
  totals: { expenseCents: number; incomeCents: number; transferCents: number; cardPaymentCents: number };
}
