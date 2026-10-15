import { z } from "zod";

/**
 * Esquemas do Financial Intelligence Engine.
 *
 * O resultado bruto (de um LLM ou do motor local) NUNCA é gravado diretamente:
 * passa por resolução de referências (nomes → IDs da própria família), verificação
 * anti-alucinação (o valor precisa constar na mensagem), cálculo de confiança e
 * validação de negócio do serviço de transações.
 */

export const PAYMENT_METHOD_VALUES = ["PIX", "DEBIT_CARD", "CREDIT_CARD", "CASH", "BANK_SLIP", "BANK_TRANSFER", "AUTO_DEBIT", "VOUCHER", "OTHER"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHOD_VALUES)[number];

export const INTENTS = ["CREATE_TRANSACTIONS", "QUERY", "CORRECTION", "DELETE", "RESTORE", "CONFIRMATION", "REJECTION", "SMALL_TALK", "UNKNOWN"] as const;
export type Intent = (typeof INTENTS)[number];

export const DRAFT_KINDS = ["EXPENSE", "INCOME", "TRANSFER", "CARD_PAYMENT", "GOAL_CONTRIBUTION"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** Rascunho de lançamento ainda com referências textuais (não resolvidas). */
export interface RawDraft {
  kind: DraftKind;
  amountCents: number | null;
  /** Trecho em que o valor aparece (para verificação). */
  amountText: string | null;
  /** O valor informado é o de cada parcela ("10 vezes de 240"). */
  amountIsInstallmentValue: boolean;
  description: string;
  merchant: string | null;
  categoryHint: string | null;
  date: string | null;
  dateExplicit: boolean;
  paymentMethod: PaymentMethodValue | null;
  accountHint: string | null;
  destinationAccountHint: string | null;
  cardHint: string | null;
  installments: number | null;
  /** Quem gastou/recebeu ("eu", "esposa", nome). */
  personHint: string | null;
  /** Responsável econômico quando diferente de quem pagou (ex.: "filho"). */
  responsibleHint: string | null;
  ownership: "SHARED" | "INDIVIDUAL" | null;
  goalHint: string | null;
  confidence: number;
  /** Texto do segmento que originou o lançamento. */
  segment: string;
}

export interface RawCorrection {
  /** Transação alvo identificada diretamente (por índice da lista recente). */
  targetId?: string | null;
  targetLast: boolean;
  targetText: string | null;
  targetAmountCents: number | null;
  targetDate: string | null;
  changes: {
    amountCents?: number | null;
    categoryHint?: string | null;
    paymentMethod?: PaymentMethodValue | null;
    accountHint?: string | null;
    cardHint?: string | null;
    personHint?: string | null;
    installments?: number | null;
    date?: string | null;
    description?: string | null;
  };
}

export interface RawDeletion {
  targetId?: string | null;
  targetLast: boolean;
  targetText: string | null;
  targetAmountCents: number | null;
  /** Pedido de exclusão em massa — sempre recusado pelo WhatsApp. */
  bulk: boolean;
}

export interface RawInterpretation {
  intent: Intent;
  drafts: RawDraft[];
  correction: RawCorrection | null;
  deletion: RawDeletion | null;
  question: string | null;
  confidence: number;
  engine: "LOCAL" | "ANTHROPIC" | "OPENAI" | "OPENAI_COMPATIBLE";
  model: string | null;
}

// -----------------------------------------------------------------------------
// Esquema de saída exigido dos LLMs (structured outputs)
// -----------------------------------------------------------------------------

const nullableString = z.string().nullable();

export const llmDraftSchema = z.object({
  kind: z.enum(DRAFT_KINDS),
  amount: z.number().nullable().describe("Valor em reais exatamente como dito (ex.: 283.9). null se não informado."),
  amount_text: nullableString.describe("Trecho literal da mensagem onde o valor aparece."),
  amount_is_installment_value: z.boolean().describe("true se o valor informado é o de cada parcela."),
  description: z.string().describe("Descrição curta em português (ex.: 'Supermercado')."),
  merchant: nullableString,
  category: nullableString.describe("Categoria da lista no formato 'Categoria > Subcategoria' ou null."),
  date: nullableString.describe("Data AAAA-MM-DD resolvida a partir da referência de hoje, ou null se não mencionada."),
  payment_method: z.enum(PAYMENT_METHOD_VALUES).nullable(),
  account: nullableString.describe("Nome da conta mencionada (origem), exatamente como na lista, ou null."),
  destination_account: nullableString.describe("Conta de destino em transferências, ou null."),
  card: nullableString.describe("Nome do cartão mencionado, exatamente como na lista, ou null."),
  installments: z.number().int().nullable(),
  person: nullableString.describe("Quem gastou: 'remetente' ou o nome do membro da lista; null se não indicado."),
  responsible: nullableString.describe("Membro economicamente responsável, se explicitamente diferente; senão null."),
  ownership: z.enum(["SHARED", "INDIVIDUAL"]).nullable(),
  goal: nullableString.describe("Nome da meta (contribuições), ou null."),
  confidence: z.number().min(0).max(1),
});

export const llmInterpretationSchema = z.object({
  intent: z.enum(INTENTS),
  transactions: z.array(llmDraftSchema).max(10),
  correction: z
    .object({
      target_last: z.boolean(),
      target_index: z.number().int().nullable().describe("Índice (#) da transação recente a corrigir, ou null."),
      target_text: nullableString,
      target_amount: z.number().nullable(),
      new_amount: z.number().nullable(),
      new_category: nullableString,
      new_payment_method: z.enum(PAYMENT_METHOD_VALUES).nullable(),
      new_account: nullableString,
      new_card: nullableString,
      new_person: nullableString,
      new_installments: z.number().int().nullable(),
      new_date: nullableString,
      new_description: nullableString,
    })
    .nullable(),
  deletion: z
    .object({
      target_last: z.boolean(),
      target_index: z.number().int().nullable(),
      target_text: nullableString,
      target_amount: z.number().nullable(),
    })
    .nullable(),
  question: nullableString,
  confidence: z.number().min(0).max(1),
});

export type LlmInterpretation = z.infer<typeof llmInterpretationSchema>;

/** JSON Schema (para structured outputs) — objetos fechados, todos os campos obrigatórios. */
export function llmInterpretationJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(llmInterpretationSchema, { target: "draft-7" }) as Record<string, unknown>;
  return closeObjects(schema);
}

/** Garante additionalProperties:false e required com todas as chaves (exigência de structured outputs). */
export function closeObjects(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return node.map(closeObjects) as unknown as Record<string, unknown>;
  if (!node || typeof node !== "object") return node as Record<string, unknown>;
  const obj = { ...(node as Record<string, unknown>) };
  delete obj.$schema;
  delete obj.minimum;
  delete obj.maximum;
  delete obj.maxItems;
  if (obj.type === "object" && obj.properties) {
    obj.additionalProperties = false;
    obj.required = Object.keys(obj.properties as Record<string, unknown>);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") obj[k] = closeObjects(v);
  }
  return obj;
}
