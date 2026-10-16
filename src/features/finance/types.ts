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
  yieldIndex: "CDI" | "SELIC" | "IPCA" | "PREFIXED" | null;
  yieldRateBps: number | null;
  yieldStartDate: string | null;
  /** Moeda da conta: saldo, saldo inicial e lançamentos ficam nela. */
  currency: string;
  /** Saldo em reais (moeda estrangeira: pela última PTAX; null enquanto não há cotação). */
  balanceBrlCents: number | null;
  /** Cotação usada (reais por 1 unidade) e a data dela; só em contas em moeda estrangeira. */
  fx: { rate: number; date: string } | null;
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

/** Natureza do lançamento: só muda relatórios e análises (saldo, fatura e projeção nunca mudam). */
export type TransactionNature = "PERSONAL" | "BUSINESS" | "PASSTHROUGH";
export type TransactionScope = "PERSONAL" | "BUSINESS";
/** Recorte dos relatórios e análises (Repasse fica sempre de fora). */
export type ReportScope = "PERSONAL" | "BUSINESS" | "ALL";

/** Motivo de "Desconsiderar nos relatórios". */
export type ExclusionReason = "CLIENT_PASSTHROUGH" | "REIMBURSEMENT" | "OTHER";

/** Marca de "Desconsiderado nos relatórios": continua no saldo, no extrato e na fatura. */
export interface TransactionExclusion {
  reason: ExclusionReason;
  /** Cliente/pessoa do repasse (agrupa o saldo do repasse). */
  party: string | null;
  note: string | null;
  excludedAt: string | null;
  excludedBy: { id: string; displayName: string } | null;
}

export interface TransactionDTO {
  id: string;
  type: "EXPENSE" | "INCOME" | "TRANSFER" | "CARD_PAYMENT" | "ADJUSTMENT";
  status: "CONFIRMED" | "PENDING";
  amountCents: number;
  /** Moeda de amountCents (a da conta de origem; cartão é sempre BRL). */
  currency: string;
  /** Transferência entre moedas: valor creditado no destino, na moeda dele. */
  destinationAmountCents: number | null;
  /** Receita/despesa em moeda estrangeira: valor em reais pela PTAX da data (null = sem cotação ainda). */
  amountBrlCents: number | null;
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
  /** Pessoal (família) ou da empresa. Repasse é a marca de desconsiderado (`excludedFromReports`). */
  scope: TransactionScope;
  /** Natureza exibida: Pessoal, Empresa ou Repasse (= desconsiderado nos relatórios). */
  nature: TransactionNature;
  /** Uma regra pediu para escolher a natureza (há uma pendência "Escolher natureza" aberta). */
  natureReview: boolean;
  /** Desconsiderado nos relatórios (repasse de cliente, reembolso…): saldo e fatura não mudam. */
  excludedFromReports: boolean;
  exclusion: TransactionExclusion | null;
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
  installments?: Array<{ id: string; number: number; totalInstallments: number; amountCents: number; dueDate: string; referenceMonth: string; statementId: string }>;
  attachments?: Array<{ id: string; kind: string; mimeType: string; createdAt: string; contentDeletedAt: string | null; processingStatus: string }>;
  history?: Array<{ id: string; action: string; actorType: string; actorMemberId: string | null; createdAt: string; metadata: unknown; source: string | null }>;
}

export interface TransactionList {
  items: TransactionDTO[];
  total: number;
  page: number;
  pageSize: number;
  /** Receitas/despesas sem os desconsiderados nos relatórios; estes vêm à parte (excluded*). */
  totals: { expenseCents: number; incomeCents: number; transferCents: number; cardPaymentCents: number; excludedExpenseCents: number; excludedIncomeCents: number };
}
