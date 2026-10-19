/**
 * Tipos da migração de planilha compartilhados entre servidor e telas (importe só como `type`).
 * Valores em centavos; datas AAAA-MM-DD; meses AAAA-MM.
 */

export type SheetFormat = "XLSX" | "XLS" | "ODS" | "CSV";
export type SheetKind = "LIST" | "MONTH" | "MATRIX" | "SUMMARY" | "EMPTY";

export type MigrationField =
  | "date"
  | "day"
  | "description"
  | "amount"
  | "debit"
  | "credit"
  | "type"
  | "category"
  | "subcategory"
  | "account"
  | "card"
  | "paymentMethod"
  | "person"
  | "nature"
  | "installment"
  | "status"
  | "notes"
  | "balance"
  | "externalId";

/** Índice da coluna (base 0, na linha de cabeçalho) de cada campo; null = não usada. */
export type ColumnMap = Record<MigrationField, number | null>;

/** Valores sem sinal: todos despesas, todos receitas, ou pelo tipo da categoria escolhida. */
export type UnsignedAs = "EXPENSE" | "INCOME" | "BY_CATEGORY";
export type MatrixMode = "TRANSACTIONS" | "BUDGET";

export interface MatrixLayoutDTO {
  headerRowIndex: number;
  labelColumn: number;
  months: Array<{ column: number; month: string }>;
}

export interface SheetConfig {
  index: number;
  name: string;
  hidden: boolean;
  /** A aba tinha mais linhas que o limite (20 mil por arquivo). */
  truncated: boolean;
  /** Linhas com conteúdo na aba. */
  rowCount: number;
  detectedKind: SheetKind;
  kind: SheetKind;
  reason: string;
  selected: boolean;
  /** Índice (base 0, entre as linhas com conteúdo) da linha de cabeçalho; -1 = sem cabeçalho. */
  headerRowIndex: number;
  headers: string[];
  columns: ColumnMap;
  /** Mês/ano da aba (abas mensais e datas sem ano). */
  month: string | null;
  /** O ano não estava no nome da aba: confira. */
  yearGuessed: boolean;
  /** Valores sem sinal na aba (nenhum negativo e sem coluna de tipo). */
  unsigned: boolean;
  unsignedAs: UnsignedAs | null;
  invertSigns: boolean;
  matrix: MatrixLayoutDTO | null;
  matrixMode: MatrixMode | null;
  /** Lançamentos (ou linhas da matriz) na aba, sem totais. */
  dataRows: number;
  /** Linhas de total/subtotal/saldo ignoradas. */
  ignoredRows: number;
  /** Primeiras linhas de dados (até 8), para conferir as colunas. */
  sample: string[][];
  warnings: string[];
  /** Configuração veio de um formato salvo. */
  fromTemplate: boolean;
  /** Identifica o formato da aba (cabeçalhos), para lembrar o mapeamento. */
  signature: string;
}

export type CorrespondenceField = "category" | "subcategory" | "account" | "card" | "person" | "nature";

export type TargetType = "CATEGORY" | "SUBCATEGORY" | "ACCOUNT" | "CARD" | "MEMBER" | "NATURE";

export type SuggestionSource = "EXACT" | "SIMILAR" | "SYNONYM" | "AI" | "TEMPLATE";

export interface CorrespondenceSuggestion {
  targetType: TargetType;
  /** Id da categoria/subcategoria/conta/cartão/membro; natureza: PERSONAL | BUSINESS | PASSTHROUGH. */
  targetId: string;
  label: string;
  source: SuggestionSource;
  /** 0..1 */
  confidence: number;
}

export type CorrespondenceDecision =
  | { action: "MAP"; targetType: TargetType; targetId: string; label: string }
  /** Só categorias e subcategorias (contas e cartões são criados na hora pelo endpoint de destinos). */
  | { action: "CREATE"; name: string; parentId: string | null; kind: "EXPENSE" | "INCOME" }
  | { action: "IGNORE" };

export interface Correspondence {
  field: CorrespondenceField;
  /** Valor normalizado (identifica o item). Subcategoria: "categoria›subcategoria". */
  key: string;
  /** Como aparece na planilha. */
  label: string;
  /** Subcategoria: a categoria da mesma linha na planilha. */
  parentLabel: string | null;
  count: number;
  /** Soma dos valores (absolutos). */
  sumCents: number;
  inCents: number;
  outCents: number;
  /** Tipo predominante das linhas (para criar/sugerir categoria de despesa ou receita). */
  kindHint: "EXPENSE" | "INCOME" | "MIXED" | null;
  suggestion: CorrespondenceSuggestion | null;
  decision: CorrespondenceDecision | null;
  fromTemplate: boolean;
}

export interface InitialBalanceChoice {
  accountId: string;
  /** INITIAL: saldo antes do primeiro lançamento migrado; CURRENT: saldo de hoje (o inicial é calculado). */
  mode: "INITIAL" | "CURRENT";
  cents: number;
}

export interface MigrationOptionsDTO {
  /** Destino das linhas sem conta/cartão (ou com conta/cartão "ignorado"). */
  defaultAccountId: string | null;
  /** Destino das compras no crédito sem cartão identificado. */
  defaultCardId: string | null;
  /** Contas já existentes: lançamentos anteriores ao saldo inicial não mudam o saldo de hoje. */
  keepCurrentBalance: boolean;
  initialBalances: InitialBalanceChoice[];
  saveTemplate: boolean;
  templateName: string | null;
}

export interface MigrationBalanceDTO {
  /** Conta criada pela migração (saldo inicial vem da planilha ou da pessoa). */
  isNew: boolean;
  currentBalanceCents: number;
  initialBalanceCents: number;
  initialBalanceDate: string;
  /** Saldo inicial sugerido (coluna de saldo ou linha "saldo inicial" da planilha). */
  suggestedInitialCents: number | null;
  suggestedInitialDate: string | null;
  suggestedFrom: "BALANCE_COLUMN" | "OPENING_ROW" | null;
  /** Escolha da pessoa (se houver). */
  choice: InitialBalanceChoice | null;
  /** Lançamentos novos anteriores ao saldo inicial da conta existente (compensados para manter o saldo de hoje). */
  rowsBeforeInitial: number;
  /** Saldo depois de importar (estimativa da prévia). */
  projectedBalanceCents: number;
  /** Falta informar o saldo inicial (conta nova sem coluna de saldo). */
  needsInitialBalance: boolean;
}

export interface MigrationDestinationDTO {
  batchId: string;
  kind: "ACCOUNT" | "CARD" | "NONE" | "MATRIX";
  id: string | null;
  name: string;
  newRows: number;
  selectedRows: number;
  matchedRows: number;
  duplicateRows: number;
  divergentRows: number;
  skippedRows: number;
  errorRows: number;
  transfers: number;
  installmentPurchases: number;
  inCents: number;
  outCents: number;
  start: string | null;
  end: string | null;
  balance: MigrationBalanceDTO | null;
}

export interface PlannedBill {
  type: "EXPENSE" | "INCOME";
  description: string;
  amountCents: number;
  dueDate: string;
  categoryId: string | null;
  accountId: string | null;
  notes: string;
  /** A pagar na planilha ou parcela futura de compra parcelada. */
  origin: "TO_PAY" | "FUTURE_INSTALLMENT";
}

export interface PlannedBudget {
  categoryId: string;
  categoryLabel: string;
  month: string;
  limitCents: number;
  previousCents: number | null;
}

export interface MigrationSummaryDTO {
  destinations: MigrationDestinationDTO[];
  period: { start: string; end: string } | null;
  totals: { rows: number; selected: number; inCents: number; outCents: number };
  bills: PlannedBill[];
  skippedBills: number;
  budgets: PlannedBudget[];
  matrixTransactions: number;
  createdCategories: string[];
  createdAccounts: string[];
  createdCards: string[];
  /** Faturas passadas dos cartões que ficarão sem pagamento registrado. */
  cardStatementsWithoutPayment: Array<{ cardName: string; count: number }>;
  warnings: string[];
}

export interface MigrationResultDTO {
  created: number;
  matched: number;
  duplicates: number;
  errors: number;
  bills: number;
  budgets: number;
  balances: Array<{ accountId: string; name: string; beforeCents: number; afterCents: number }>;
  templateSaved: boolean;
}

export type MigrationStatus = "READING" | "READY" | "PREVIEWING" | "PREVIEW" | "COMMITTING" | "IMPORTED" | "UNDONE" | "DISCARDED" | "FAILED";

export interface MigrationTargetsDTO {
  categories: Array<{ id: string; name: string; kind: "EXPENSE" | "INCOME"; subcategories: Array<{ id: string; name: string }> }>;
  accounts: Array<{ id: string; name: string; type: string; institution: string | null }>;
  cards: Array<{ id: string; name: string }>;
  members: Array<{ id: string; name: string }>;
}

export interface MigrationDTO {
  id: string;
  fileName: string;
  format: SheetFormat;
  status: MigrationStatus;
  progress: number;
  progressLabel: string | null;
  error: string | null;
  createdAt: string;
  importedAt: string | null;
  undoneAt: string | null;
  origin: "WHATSAPP" | null;
  template: { id: string; name: string } | null;
  sheets: SheetConfig[];
  correspondences: Correspondence[];
  /** Itens sem decisão (por campo). */
  pending: Record<CorrespondenceField, number>;
  options: MigrationOptionsDTO;
  targets: MigrationTargetsDTO;
  /** IA configurada e autorizada (botão "Sugerir com IA"). */
  aiAvailable: boolean;
  /** Pode gerar a prévia? Senão, o que falta. */
  ready: { canPreview: boolean; problems: string[] };
  summary: MigrationSummaryDTO | null;
  result: MigrationResultDTO | null;
}

export interface MigrationListItemDTO {
  id: string;
  fileName: string;
  format: SheetFormat;
  status: MigrationStatus;
  progress: number;
  createdAt: string;
  importedAt: string | null;
  undoneAt: string | null;
  rows: number | null;
  created: number | null;
}

export interface MigrationTemplateDTO {
  id: string;
  name: string;
  sheets: number;
  correspondences: number;
  timesUsed: number;
  lastUsedAt: string | null;
  createdAt: string;
}
