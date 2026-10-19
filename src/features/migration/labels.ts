/** Textos e funções puras da migração de planilha. */
import { formatBRL } from "@/lib/money";
import { formatMonthBR } from "@/lib/dates";
import type {
  Correspondence,
  CorrespondenceDecision,
  CorrespondenceField,
  MigrationDTO,
  MigrationField,
  MigrationTargetsDTO,
  SheetKind,
  SuggestionSource,
  TargetType,
} from "@/server/modules/migration/types";

export const SHEET_KIND_LABELS: Record<SheetKind, string> = {
  LIST: "Lista de lançamentos",
  MONTH: "Aba do mês",
  MATRIX: "Categorias × meses",
  SUMMARY: "Resumo (ignorada)",
  EMPTY: "Vazia",
};

export const SHEET_KIND_HINTS: Record<SheetKind, string> = {
  LIST: "Uma linha por lançamento, com data, descrição e valor.",
  MONTH: "Lançamentos de um mês só (a data pode ter só o dia).",
  MATRIX: "Categorias nas linhas e meses nas colunas (totais por mês).",
  SUMMARY: "Resumo, gráfico ou totais: não vira lançamento.",
  EMPTY: "Sem dados para importar.",
};

/** Tipos que a pessoa pode escolher para uma aba (Vazia é só detectada). */
export const SETTABLE_KINDS = ["LIST", "MONTH", "MATRIX", "SUMMARY"] as const;

export const isIgnoredKind = (kind: SheetKind) => kind === "SUMMARY" || kind === "EMPTY";
export const usesColumns = (kind: SheetKind) => kind === "LIST" || kind === "MONTH";

/** Campos das colunas, na ordem em que aparecem no seletor. */
export const FIELD_ORDER: MigrationField[] = [
  "date",
  "day",
  "description",
  "amount",
  "debit",
  "credit",
  "type",
  "category",
  "subcategory",
  "account",
  "card",
  "paymentMethod",
  "person",
  "nature",
  "installment",
  "status",
  "notes",
  "balance",
  "externalId",
];

export const FIELD_LABELS: Record<MigrationField, string> = {
  date: "Data",
  day: "Dia (aba do mês)",
  description: "Descrição",
  amount: "Valor",
  debit: "Débito / saída",
  credit: "Crédito / entrada",
  type: "Tipo (entrada/saída)",
  category: "Categoria",
  subcategory: "Subcategoria",
  account: "Conta / banco",
  card: "Cartão",
  paymentMethod: "Forma de pagamento",
  person: "Pessoa",
  nature: "Natureza (PF/PJ)",
  installment: "Parcela",
  status: "Status (pago / a pagar)",
  notes: "Observação",
  balance: "Saldo",
  externalId: "Identificador",
};

export const CORRESPONDENCE_FIELDS: CorrespondenceField[] = ["category", "subcategory", "account", "card", "person", "nature"];

export const CORRESPONDENCE_FIELD_LABELS: Record<CorrespondenceField, string> = {
  category: "Categorias",
  subcategory: "Subcategorias",
  account: "Contas",
  card: "Cartões",
  person: "Pessoas",
  nature: "Natureza",
};

/** O que acontece com as linhas de um item ignorado. */
export const IGNORE_HINTS: Record<CorrespondenceField, string> = {
  category: "fica sem categoria",
  subcategory: "fica só com a categoria",
  account: "vai para o destino padrão",
  card: "vai para o destino padrão",
  person: "sem pessoa",
  nature: "as regras da família decidem",
};

export const SOURCE_LABELS: Record<SuggestionSource, string> = {
  EXACT: "Igual",
  SIMILAR: "Parecido",
  SYNONYM: "Sinônimo",
  AI: "IA",
  TEMPLATE: "Formato salvo",
};

export const SOURCE_HINTS: Record<SuggestionSource, string> = {
  EXACT: "Mesmo nome de um item que já existe no app.",
  SIMILAR: "Nome parecido com um item do app.",
  SYNONYM: "Nome com o mesmo significado (ex.: “Mercado” e “Supermercado”).",
  AI: "Sugerido pela IA configurada.",
  TEMPLATE: "Escolha feita na última planilha com este formato.",
};

export const NATURE_TARGETS: Array<{ id: "PERSONAL" | "BUSINESS" | "PASSTHROUGH"; label: string }> = [
  { id: "PERSONAL", label: "Pessoal" },
  { id: "BUSINESS", label: "Empresa" },
  { id: "PASSTHROUGH", label: "Repasse de cliente" },
];

export const TARGET_TYPE_LABELS: Record<TargetType, string> = {
  CATEGORY: "Categoria",
  SUBCATEGORY: "Subcategoria",
  ACCOUNT: "Conta",
  CARD: "Cartão",
  MEMBER: "Pessoa",
  NATURE: "Natureza",
};

/** Letra da coluna como na planilha (0 → A, 25 → Z, 26 → AA). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function percent(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}

/** "jan/25 a dez/25" a partir dos meses (AAAA-MM). */
export function monthRangeLabel(months: string[]): string | null {
  const sorted = [...months].filter(Boolean).sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  return first === last ? formatMonthBR(first) : `${formatMonthBR(first, { short: true })} a ${formatMonthBR(last, { short: true })}`;
}

/** Linha de valores do item: "12 linhas · R$ 1.234,00 · entradas R$ 100,00 · saídas R$ 1.134,00". */
export function itemAmounts(c: Pick<Correspondence, "count" | "sumCents" | "inCents" | "outCents">): string {
  const parts = [plural(c.count, "linha", "linhas"), formatBRL(c.sumCents)];
  if (c.inCents && c.outCents) parts.push(`entradas ${formatBRL(c.inCents)}`, `saídas ${formatBRL(c.outCents)}`);
  return parts.join(" · ");
}

/** A decisão é aceitar exatamente a sugestão do item. */
export function isSuggestionDecision(c: Correspondence): boolean {
  const d = c.decision;
  return Boolean(d && d.action === "MAP" && c.suggestion && d.targetType === c.suggestion.targetType && d.targetId === c.suggestion.targetId);
}

export function acceptDecision(c: Correspondence): CorrespondenceDecision | null {
  const s = c.suggestion;
  return s ? { action: "MAP", targetType: s.targetType, targetId: s.targetId, label: s.label } : null;
}

/** Nome da categoria-mãe de uma decisão "criar". */
export function parentName(targets: MigrationTargetsDTO, parentId: string | null): string | null {
  if (!parentId) return null;
  return targets.categories.find((c) => c.id === parentId)?.name ?? null;
}

export function pendingTotal(m: Pick<MigrationDTO, "pending">): number {
  return Object.values(m.pending).reduce((s, n) => s + n, 0);
}

/** Itens sem decisão que já têm sugestão (o que "Aplicar sugestões" resolve). */
export function pendingSuggestions(items: Correspondence[], field?: CorrespondenceField): number {
  return items.filter((c) => (!field || c.field === field) && !c.decision && c.suggestion).length;
}

/** Nome do arquivo sem a extensão (nome padrão do formato salvo). */
export function baseFileName(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || name;
}
