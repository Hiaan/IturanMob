/** Tipos do cliente para a integração com os bancos (espelham /api/v1/integrations/open-finance). */

export type OpenFinanceProvider = "PLUGGY" | "SIMULATOR";

export interface BankLinkDTO {
  id: string;
  type: "BANK" | "CREDIT";
  name: string;
  numberLast4: string | null;
  currency: string;
  balanceCents: number | null;
  balanceAt: string | null;
  account: { id: string; name: string } | null;
  creditCard: { id: string; name: string } | null;
  enabled: boolean;
  lastSyncAt: string | null;
  lastTransactionDate: string | null;
}

export interface BankItemDTO {
  id: string;
  itemId: string;
  institutionName: string | null;
  status: string | null;
  needsAttention: boolean;
  providerUpdatedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  accounts: BankLinkDTO[];
}

export interface OpenFinanceStatusDTO {
  configured: boolean;
  provider: OpenFinanceProvider | null;
  simulated: boolean;
  simulatorAvailable: boolean;
  clientIdHint: string | null;
  autoImport: boolean;
  initialDays: number;
  lastSyncAt: string | null;
  lastError: string | null;
  maxItems: number;
  items: BankItemDTO[];
}

export interface OpenFinanceSyncResult {
  items: number;
  links: Array<{ linkId: string; name: string; fetched: number; newRows: number; pending: number; foreign: number; batchId: string | null; imported: number | null }>;
  errors: string[];
}
