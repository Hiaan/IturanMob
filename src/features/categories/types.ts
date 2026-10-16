/** Regra explícita de categorização (espelha FinancialRule + relações de listRules). */
export interface RuleDTO {
  id: string;
  name: string;
  matchField: "MERCHANT" | "DESCRIPTION" | "ANY";
  matchType: "CONTAINS" | "EQUALS" | "STARTS_WITH" | "REGEX";
  pattern: string;
  minAmountCents: number | null;
  maxAmountCents: number | null;
  transactionType: "EXPENSE" | "INCOME" | null;
  setCategoryId: string | null;
  setSubcategoryId: string | null;
  setPaymentMethod: string | null;
  setAccountId: string | null;
  /** Regra de transferência: a movimentação vira transferência com esta conta (aplicação/resgate, contas próprias). */
  setTransferAccountId: string | null;
  setOwnership: string | null;
  setResponsibleMemberId: string | null;
  priority: number;
  active: boolean;
  source: "USER" | "ASSISTANT" | "WHATSAPP";
  timesApplied: number;
  createdAt: string;
  updatedAt: string;
  category: { name: string; color: string } | null;
  subcategory: { name: string } | null;
  account: { name: string } | null;
  transferAccount: { name: string } | null;
}

export type RuleInput = Omit<RuleDTO, "id" | "source" | "timesApplied" | "createdAt" | "updatedAt" | "category" | "subcategory" | "account" | "transferAccount" | "setOwnership" | "setResponsibleMemberId">;

export const MATCH_FIELD_LABELS: Record<RuleDTO["matchField"], string> = {
  ANY: "Descrição ou estabelecimento",
  DESCRIPTION: "Descrição",
  MERCHANT: "Estabelecimento",
};

export const MATCH_TYPE_LABELS: Record<RuleDTO["matchType"], string> = {
  CONTAINS: "contém",
  EQUALS: "é igual a",
  STARTS_WITH: "começa com",
  REGEX: "corresponde à expressão regular",
};

export const RULE_SOURCE_LABELS: Record<RuleDTO["source"], string> = {
  USER: "criada no app",
  ASSISTANT: "criada pelo assistente",
  WHATSAPP: "criada pelo WhatsApp",
};
