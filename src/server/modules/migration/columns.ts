import type { PaymentMethod } from "@prisma/client";
import { isISODate, makeISO } from "@/lib/dates";
import { normalizeText } from "@/lib/utils";
import { parseImportAmount, parseImportDate } from "../imports/mapping";

/**
 * Colunas reconhecidas na migração de planilha (além de data/descrição/valor da importação comum)
 * e a leitura dos valores dessas colunas. Nada é inventado: valor que não se encaixa fica vazio e a
 * linha segue com o que a pessoa escolher nas correspondências ou na prévia.
 */

export const MIGRATION_FIELDS = [
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
] as const;
export type MigrationField = (typeof MIGRATION_FIELDS)[number];
export type ColumnMap = Record<MigrationField, number | null>;

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

export function emptyColumns(): ColumnMap {
  return Object.fromEntries(MIGRATION_FIELDS.map((f) => [f, null])) as ColumnMap;
}

const SYNONYMS: Record<MigrationField, string[]> = {
  date: [
    "data", "dt", "data lancamento", "data do lancamento", "data de lancamento", "data movimento", "data movimentacao", "data mov", "data transacao",
    "data da transacao", "data compra", "data da compra", "data operacao", "data pagamento", "data de pagamento", "data do pagamento", "data da despesa",
    "data do gasto", "date", "transaction date", "quando",
  ],
  day: ["dia", "dd", "dia do mes"],
  description: [
    "descricao", "historico", "lancamento", "lancamentos", "estabelecimento", "detalhes", "detalhe", "memo", "description", "titulo", "nome", "item",
    "gasto", "o que", "produto", "servico", "local", "loja", "favorecido", "beneficiario", "descricao do lancamento", "despesa descricao", "discriminacao",
  ],
  amount: [
    "valor", "valor r", "valor rs", "valor em r", "valor brl", "valor em reais", "valor total", "valor lancamento", "valor do lancamento", "valor pago",
    "quantia", "montante", "amount", "value", "preco", "custo", "total",
  ],
  debit: ["debito", "debitos", "saida", "saidas", "valor debito", "debito r", "debit", "despesa", "despesas", "gastos", "pagamentos"],
  credit: ["credito", "creditos", "entrada", "entradas", "valor credito", "credito r", "credit", "receita", "receitas", "recebimentos"],
  type: [
    "tipo", "tipo de lancamento", "tipo lancamento", "tipo de movimento", "entrada saida", "entrada ou saida", "e s", "movimento", "operacao", "d c",
    "debito credito", "receita despesa", "receita ou despesa", "sentido",
  ],
  category: ["categoria", "categorias", "category", "classificacao", "grupo", "classe", "tipo de gasto", "tipo de despesa", "centro de custo", "rubrica"],
  subcategory: ["subcategoria", "sub categoria", "subcategorias", "subgrupo", "sub grupo", "subclasse", "detalhamento", "subtipo"],
  account: ["conta", "banco", "conta bancaria", "instituicao", "conta corrente", "origem", "carteira", "conta origem", "conta cartao", "conta ou cartao", "meio"],
  card: ["cartao", "cartao de credito", "cartao credito", "card", "credit card", "qual cartao"],
  paymentMethod: [
    "forma de pagamento", "forma pagamento", "forma de pagto", "meio de pagamento", "metodo de pagamento", "pagamento", "forma", "metodo", "como pagou",
    "pago com", "modalidade", "pagto",
  ],
  person: ["pessoa", "quem", "responsavel", "membro", "pagador", "quem pagou", "usuario", "titular", "comprador", "quem gastou", "familiar", "dono"],
  nature: ["natureza", "pf pj", "pf ou pj", "tipo pf pj", "pessoal empresa", "pessoal ou empresa", "empresa ou pessoal", "escopo", "ambito", "pj pf"],
  installment: ["parcela", "parcelas", "parc", "n parcela", "no parcela", "num parcela", "numero da parcela", "parcelamento", "qtd parcelas", "vezes", "prestacao"],
  status: ["status", "situacao", "pago", "paga", "quitado", "estado", "pago ou a pagar", "pagou", "efetivado"],
  notes: ["observacao", "observacoes", "obs", "nota", "notas", "comentario", "comentarios", "anotacao", "anotacoes", "complemento", "detalhe adicional"],
  balance: ["saldo", "saldo final", "saldo atual", "saldo do dia", "saldo acumulado", "saldo r", "saldo em conta", "balance"],
  externalId: ["identificador", "id", "fitid", "id transacao", "transaction id", "documento", "n documento", "numero documento", "nr documento", "doc"],
};

/** Ordem de desempate quando um cabeçalho serve para mais de um campo. */
const FIELD_PRIORITY: MigrationField[] = [
  "date", "amount", "debit", "credit", "balance", "day", "category", "subcategory", "card", "account", "paymentMethod", "person", "nature",
  "installment", "status", "type", "notes", "description", "externalId",
];

function headerScore(header: string, field: MigrationField): number {
  const h = normalizeText(header);
  if (!h) return 0;
  const syns = SYNONYMS[field];
  if (syns.includes(h)) return 100;
  const words = h.split(" ");
  let best = 0;
  for (const s of syns) {
    if (s.includes(" ")) {
      if (h.startsWith(`${s} `) || h.endsWith(` ${s}`) || h.includes(` ${s} `)) best = Math.max(best, 70);
    } else if (words.includes(s)) {
      best = Math.max(best, words[0] === s ? 60 : 45);
    }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Valores
// -----------------------------------------------------------------------------

export interface InstallmentInfo {
  number: number;
  total: number;
  /** "3x", "em 10 vezes": o valor da linha é o da compra inteira (não o da parcela). */
  purchaseTotal: boolean;
}

/** "3/10", "03 de 10", "parcela 3 de 10", "parc. 3/10" → 3 de 10; "3x", "em 3 vezes" → compra em 3 parcelas. */
export function parseInstallment(text: string | null | undefined): InstallmentInfo | null {
  if (!text) return null;
  const n = normalizeText(text);
  if (!n) return null;
  if (/^(a vista|avista|1x|1 x|1 1|1 de 1|unica|parcela unica)$/.test(n)) return null;
  const valid = (number: number, total: number, purchaseTotal: boolean): InstallmentInfo | null =>
    number >= 1 && total >= 2 && number <= total && total <= 72 ? { number, total, purchaseTotal } : null;
  let m = /^(?:parc(?:ela)?\s*)?(\d{1,2})\s*(?:de|of|\s)\s*(\d{1,2})$/.exec(n);
  if (m) return valid(Number(m[1]), Number(m[2]), false);
  m = /\bparc(?:ela)?\s*(\d{1,2})\s*(?:de|\s)\s*(\d{1,2})\b/.exec(n);
  if (m) return valid(Number(m[1]), Number(m[2]), false);
  m = /^(?:em\s+)?(\d{1,2})\s*(?:x|vezes|parcelas)$/.exec(n);
  if (m) return valid(1, Number(m[1]), true);
  return null;
}

/** Parcela marcada na descrição: "Geladeira (3/10)", "TV parc 2/12", "Sofá 3 de 10". */
export function installmentFromDescription(description: string): { info: InstallmentInfo; base: string } | null {
  const patterns = [
    /\s*[([]\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*[)\]]\s*/,
    /\s*\bparc(?:ela)?\.?\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b\s*/i,
    /\s+(\d{1,2})\s*\/\s*(\d{1,2})\s*$/,
    /\s+(\d{1,2})\s+de\s+(\d{1,2})\s*$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(description);
    if (!m) continue;
    const number = Number(m[1]);
    const total = Number(m[2]);
    if (number < 1 || total < 2 || number > total || total > 72) continue;
    const base = (description.slice(0, m.index) + " " + description.slice(m.index + m[0].length)).replace(/\s+/g, " ").replace(/[\s\-–—:,]+$/, "").trim();
    return { info: { number, total, purchaseTotal: false }, base: base || description };
  }
  return null;
}

export type NatureValue = "PERSONAL" | "BUSINESS" | "PASSTHROUGH";

const NATURE_WORDS: Array<[RegExp, NatureValue]> = [
  [/^(pf|p f|pessoal|pessoa fisica|particular|familia|familiar|casa|pessoal pf|pf pessoal|privado|proprio)$/, "PERSONAL"],
  [/^(pj|p j|empresa|empresarial|pessoa juridica|negocio|negocios|comercial|cnpj|mei|empresa pj|pj empresa|firma|escritorio)$/, "BUSINESS"],
  [/^(repasse|repasses|cliente|clientes|reembolsavel|terceiro|terceiros|de cliente|do cliente|repasse de cliente)$/, "PASSTHROUGH"],
];

export function parseNatureValue(text: string | null | undefined): NatureValue | null {
  const n = normalizeText(text ?? "");
  if (!n) return null;
  for (const [re, v] of NATURE_WORDS) if (re.test(n)) return v;
  return null;
}

export type FlowType = "IN" | "OUT" | "TRANSFER";

export function parseFlowType(text: string | null | undefined): FlowType | null {
  const raw = (text ?? "").trim();
  if (raw === "+") return "IN";
  if (raw === "-" || raw === "−") return "OUT";
  const n = normalizeText(raw);
  if (!n) return null;
  if (/^(entrada|entradas|receita|receitas|credito|c|e|recebimento|recebido|recebida|ganho|renda|in|income|deposito|r)$/.test(n)) return "IN";
  if (/^(saida|saidas|despesa|despesas|debito|d|s|gasto|gastos|pagamento|out|expense|compra|saque|retirada)$/.test(n)) return "OUT";
  if (/^(transferencia|transf|tr|transfer)$/.test(n)) return "TRANSFER";
  return null;
}

export type StatusValue = "PAID" | "TO_PAY";

export function parseStatusValue(text: string | null | undefined): StatusValue | null {
  const raw = (text ?? "").trim();
  if (/^[✓✔☑✅xX]$/.test(raw)) return "PAID";
  const n = normalizeText(raw);
  if (!n) return null;
  if (/^(pago|paga|pagos|pagas|quitado|quitada|liquidado|liquidada|ok|sim|s|concluido|concluida|efetuado|efetuada|recebido|recebida|realizado|realizada|feito|yes|y|verdadeiro|true|efetivado|efetivada|confirmado)$/.test(n)) return "PAID";
  if (/^(a pagar|pendente|pendentes|em aberto|aberto|aberta|nao pago|nao paga|nao|n|previsto|prevista|agendado|agendada|a receber|futuro|programado|programada|a vencer|vencer|no|falso|false|aguardando|em atraso|atrasado|atrasada|vencido|vencida)$/.test(n)) return "TO_PAY";
  return null;
}

export function parsePaymentMethodValue(text: string | null | undefined): PaymentMethod | null {
  const n = normalizeText(text ?? "");
  if (!n) return null;
  if (/\bpix\b/.test(n)) return "PIX";
  if (/\b(debito automatico|deb aut|debito em conta automatico)\b/.test(n)) return "AUTO_DEBIT";
  if (/\b(credito|cartao de credito|cc|credit|parcelado)\b/.test(n) || n === "cartao") return "CREDIT_CARD";
  if (/\b(debito|cartao de debito|debit)\b/.test(n)) return "DEBIT_CARD";
  if (/\b(dinheiro|especie|cash|em maos|nota)\b/.test(n)) return "CASH";
  if (/\b(boleto|carne|titulo)\b/.test(n)) return "BANK_SLIP";
  if (/\b(ted|doc|tef|transferencia|transf)\b/.test(n)) return "BANK_TRANSFER";
  if (/\b(vale|va|vr|vale refeicao|vale alimentacao|ticket|alelo|sodexo|pluxee|flash|caju)\b/.test(n)) return "VOUCHER";
  return null;
}

/** Linha de total/subtotal/saldo (não é lançamento). */
const TOTAL_ROW = /^(total|totais|subtotal|sub total|soma|somatorio|saldo|saldo anterior|saldo inicial|saldo final|saldo do mes|saldo atual|resumo|resultado|balanco|total geral|totalizador)(\b.*)?$/;
const OPENING_ROW = /^(saldo anterior|saldo inicial|saldo de abertura|saldo inicio|saldo do mes anterior)\b/;

export function isTotalLabel(text: string | null | undefined): boolean {
  const n = normalizeText(text ?? "");
  return Boolean(n) && TOTAL_ROW.test(n);
}

export function isOpeningBalanceLabel(text: string | null | undefined): boolean {
  return OPENING_ROW.test(normalizeText(text ?? ""));
}

/** Data com ano, ou dia/mês sem ano ("15/03") quando há mês/ano de referência. */
export function parseMigrationDate(value: string, ref: { year: number | null; month: number | null }, format: "dmy" | "mdy" = "dmy"): string | null {
  const full = parseImportDate(value, format);
  if (full) return full;
  const s = value.trim();
  const dm = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (dm && ref.year) {
    const [day, month] = format === "mdy" ? [Number(dm[2]), Number(dm[1])] : [Number(dm[1]), Number(dm[2])];
    const iso = makeISO(ref.year, month, day);
    return isISODate(iso) ? iso : null;
  }
  return null;
}

/** Só o dia (1..31), para abas mensais. */
export function parseDayValue(value: string): number | null {
  const s = value.trim().replace(/^dia\s+/i, "");
  if (!/^\d{1,2}(?:[.,]0+)?$/.test(s)) return null;
  const n = Number(s.replace(",", "."));
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

// -----------------------------------------------------------------------------
// Detecção das colunas
// -----------------------------------------------------------------------------

function columnValues(rows: string[][], col: number, sample = 200): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const v = (r[col] ?? "").trim();
    // Linhas de total/saldo não dizem nada sobre o tipo da coluna.
    if (v && !r.some((c) => isTotalLabel(c))) out.push(v);
    if (out.length >= sample) break;
  }
  return out;
}

function ratio(values: string[], test: (v: string) => boolean): number {
  if (!values.length) return 0;
  return values.filter(test).length / values.length;
}

const isAmount = (v: string) => parseImportAmount(v) !== null && !parseImportDate(v);
const isDateLike = (v: string) => parseImportDate(v) !== null || /^(\d{1,2})[-/.](\d{1,2})$/.test(v.trim());
const isText = (v: string) => parseImportAmount(v) === null && !parseImportDate(v);

/** Confere se o conteúdo da coluna combina com o campo (cabeçalho pode enganar). */
function contentFits(field: MigrationField, values: string[]): boolean {
  if (!values.length) return field !== "date" && field !== "amount";
  switch (field) {
    case "date":
      return ratio(values, isDateLike) >= 0.6;
    case "day":
      return ratio(values, (v) => parseDayValue(v) !== null) >= 0.8;
    case "amount":
    case "debit":
    case "credit":
    case "balance":
      return ratio(values, isAmount) >= 0.6;
    case "installment":
      return ratio(values, (v) => parseInstallment(v) !== null || /^1\s*(x|\/\s*1)?$/i.test(v.trim()) || /^a vista$/i.test(normalizeText(v))) >= 0.5;
    case "nature":
      return ratio(values, (v) => parseNatureValue(v) !== null) >= 0.5;
    case "type":
      return ratio(values, (v) => parseFlowType(v) !== null) >= 0.6;
    case "status":
      return ratio(values, (v) => parseStatusValue(v) !== null) >= 0.6;
    case "paymentMethod":
      return ratio(values, (v) => parsePaymentMethodValue(v) !== null) >= 0.3;
    case "description":
    case "category":
    case "subcategory":
    case "account":
    case "card":
    case "person":
    case "notes":
      return ratio(values, isText) >= 0.6;
    case "externalId":
      return true;
  }
}

/** Pontuação da linha como cabeçalho (nomes conhecidos, com ao menos uma coluna-chave). */
export function headerRowScore(row: string[]): { matches: number; hasKey: boolean } {
  let matches = 0;
  let hasKey = false;
  for (const cell of row) {
    if (!cell || parseImportDate(cell) || parseImportAmount(cell) !== null) continue;
    let best: MigrationField | null = null;
    let bestScore = 0;
    for (const f of FIELD_PRIORITY) {
      const sc = headerScore(cell, f);
      if (sc > bestScore) {
        bestScore = sc;
        best = f;
      }
    }
    if (best && bestScore >= 45) {
      matches++;
      if (best === "date" || best === "day" || best === "amount" || best === "debit" || best === "credit") hasKey = true;
    }
  }
  return { matches, hasKey };
}

export function findHeaderRow(rows: string[][], maxScan = 25): number {
  const limit = Math.min(rows.length, maxScan);
  let best = -1;
  let bestMatches = 0;
  for (let i = 0; i < limit; i++) {
    const { matches, hasKey } = headerRowScore(rows[i] ?? []);
    if (hasKey && matches >= 2 && matches > bestMatches) {
      best = i;
      bestMatches = matches;
      if (matches >= 4) break;
    }
  }
  return best;
}

/** Colunas pelo nome do cabeçalho, conferidas pelo conteúdo, com reforço pelo conteúdo quando faltam. */
export function detectColumns(headers: string[], rows: string[][]): ColumnMap {
  const map = emptyColumns();
  const used = new Set<number>();
  const pairs: Array<{ field: MigrationField; col: number; score: number }> = [];
  headers.forEach((h, col) => {
    for (const field of FIELD_PRIORITY) {
      const score = headerScore(h, field);
      if (score >= 45) pairs.push({ field, col, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score || FIELD_PRIORITY.indexOf(a.field) - FIELD_PRIORITY.indexOf(b.field) || a.col - b.col);
  const values = new Map<number, string[]>();
  const valuesOf = (col: number) => {
    let v = values.get(col);
    if (!v) {
      v = columnValues(rows, col);
      values.set(col, v);
    }
    return v;
  };
  for (const p of pairs) {
    if (used.has(p.col) || map[p.field] !== null) continue;
    // "Dia" com datas completas é a data; "Data" só com dias é o dia.
    let field = p.field;
    if (field === "day" && !contentFits("day", valuesOf(p.col)) && contentFits("date", valuesOf(p.col))) field = "date";
    if (field === "date" && !contentFits("date", valuesOf(p.col)) && contentFits("day", valuesOf(p.col))) field = "day";
    if (map[field] !== null || !contentFits(field, valuesOf(p.col))) continue;
    map[field] = p.col;
    used.add(p.col);
  }

  // Valor único tem precedência; débito/crédito só valem juntos ou sem valor.
  if (map.amount !== null) {
    map.debit = null;
    map.credit = null;
  }

  // Reforço pelo conteúdo.
  const width = headers.length;
  if (map.date === null && map.day === null) {
    for (let col = 0; col < width; col++) {
      if (used.has(col)) continue;
      if (ratio(valuesOf(col), (v) => parseImportDate(v) !== null) >= 0.8) {
        map.date = col;
        used.add(col);
        break;
      }
    }
  }
  if (map.amount === null && map.debit === null && map.credit === null) {
    for (let col = width - 1; col >= 0; col--) {
      if (used.has(col)) continue;
      const vs = valuesOf(col);
      if (ratio(vs, (v) => isAmount(v) && /[.,]\d{2}\b|^-?\d+$/.test(v.trim())) >= 0.8) {
        map.amount = col;
        used.add(col);
        break;
      }
    }
  }
  // "Conta" com muitos nomes diferentes ("Conta de luz", "Internet"...) é a descrição, não o banco.
  if (map.description === null && map.account !== null) {
    const vs = columnValues(rows, map.account, 2000);
    const distinct = new Set(vs.map(valueKey)).size;
    if (distinct > 10 && distinct > vs.length * 0.3) {
      map.description = map.account;
      map.account = null;
    }
  }
  if (map.description === null) {
    if (map.notes !== null) {
      // Só "Observação": ela é a descrição.
      map.description = map.notes;
      map.notes = null;
    } else {
      let best = -1;
      let bestLen = 0;
      for (let col = 0; col < width; col++) {
        if (used.has(col)) continue;
        const vs = valuesOf(col);
        const textual = vs.filter(isText);
        if (textual.length < vs.length * 0.6 || !textual.length) continue;
        const avg = textual.reduce((s, v) => s + v.length, 0) / textual.length;
        if (avg > bestLen) {
          bestLen = avg;
          best = col;
        }
      }
      if (best >= 0) {
        map.description = best;
        used.add(best);
      }
    }
  }
  return map;
}

/** Normaliza um valor distinto (chave das correspondências). */
export function valueKey(text: string): string {
  return normalizeText(text).slice(0, 80);
}
