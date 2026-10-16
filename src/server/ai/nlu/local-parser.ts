import { extractAmounts, extractInstallments, type AmountMention } from "./numbers";
import { extractDate } from "./dates";
import { normalizeForNlu, sanitizeUntrusted } from "./text";
import { detectInvestmentMessage, isInvestmentAccountType } from "./investment";
import type { HouseholdContext } from "../engine/context";
import type { DraftKind, Intent, PaymentMethodValue, RawCorrection, RawDeletion, RawDraft, RawInterpretation } from "../engine/schemas";

/**
 * Motor local de interpretação (heurístico, determinístico, sem IA externa).
 * Funciona como adaptador padrão quando nenhum provedor de IA está configurado/autorizado
 * e como rede de segurança quando o provedor falha. Nunca inventa valores: se não houver
 * valor na mensagem, o lançamento fica com valor ausente e o sistema pede esclarecimento.
 */

const RE = {
  query: /^(quanto|quantos|quantas|qual|quais|quando|como|onde|mostra|me mostra|mostre|me mande|me manda|resumo|liste|listar|lista|compara|compare|comparar|existe|tem alguma|temos|ja pagamos|devo|devemos|posso|podemos|me diz|me diga|me fala|saldo|extrato)\b/,
  restore: /\b(restaura|restaure|restaurar|desfaz|desfaca|desfazer|recupera|recupere|recuperar|volta o|volte o)\b/,
  delete: /\b(apaga|apague|apagar|cancela|cancele|cancelar|exclui|exclua|excluir|remove|remova|remover|deleta|delete|desconsidera|desconsidere|ignora|ignore)\b/,
  deleteTarget: /\b(gasto|gastos|despesa|despesas|lancamento|lancamentos|compra|compras|receita|receitas|registro|registros|transacao|transacoes|ultimo|ultima|isso|esse|essa|aquele|aquela|tudo|todas|todos)\b/,
  bulk: /\b(todas|todos|tudo|historico|banco de dados|em massa)\b/,
  financialVocab: /\b(quanto|quantos|quantas|gast\w*|despes\w*|receit\w*|receb\w*|saldo\w*|conta|contas|fatura\w*|cart\w*|orcament\w*|meta|metas|categori\w*|pag\w*|compr\w*|mercado|resumo|extrato|parcel\w*|assinatura\w*|dinheiro|valor\w*|economi\w*|invest\w*|limite|divida\w*|boleto\w*|media|maior\w*|menor\w*|sobrou|sobra|falta|alimentacao|transporte|saude|lazer|moradia)\b/,
  correction: /\b(corrige|corrigir|corrija|correcao|corrigindo|registrei errado|lancei errado|anotei errado|errei|na verdade|muda|mude|mudar|altera|altere|alterar|troca|troque|trocar|ao inves|em vez)\b/,
  correctionFoiNao: /\bfoi\b.*\bnao\b|\bnao\b.*\bfoi\b|\be nao\b/,
  correctionRef: /\b(aquela|aquele|aquilo|a ultima|o ultimo|essa|esse|a compra|o gasto|a despesa|o lancamento|o mercado|a farmacia)\b/,
  confirm: /^(sim|s|isso|isso mesmo|confirmo|confirmado|confirma|pode|pode sim|pode lancar|ok|okay|certo|correto|exato|positivo|beleza|blz|uhum|aham|claro|perfeito|👍)\b/,
  reject: /^(nao|n|negativo|errado|errada|cancela|nada disso|nao e isso|nao foi)\b/,
  income: /\b(recebi|recebemos|recebeu|receberam|ganhei|ganhamos|ganhou|entrou|entraram|caiu|cairam|depositaram|depositou|me pagaram|nos pagaram|pagaram|vendi|vendemos|vendeu|reembolso|reembolsaram|estorno|estornaram|rendeu|renderam|rendimento|salario|bonus|freela|freelance)\b/,
  expenseVerb: /\b(gastei|gastou|gastamos|gastaram|paguei|pagou|pagamos|pagaram a|comprei|comprou|compramos|abasteci|abasteceu|abastecemos|custou|saiu|torrei|fiz um pix|fiz pix)\b/,
  transfer: /\b(transferi|transferimos|transferiu|transferencia|transferir|passei|mandei|enviei|movi|movimentei)\b/,
  cardPayment: /\bfatura\b/,
  cardPaymentVerb: /\b(paguei|pagamos|pagou|quitei|quitamos|pago|paga)\b/,
  goal: /\b(separei|separamos|separou|guardei|guardamos|guardou|reservei|reservamos|poupei|poupamos|juntei|juntamos|aportei|aportamos|coloquei na meta|depositei na meta)\b/,
};

const PAYMENT_PATTERNS: Array<[RegExp, PaymentMethodValue]> = [
  [/\bdebito automatico\b/, "AUTO_DEBIT"],
  [/\b(vale refeicao|vale alimentacao|vr|va|alelo|sodexo|ticket|flash|caju|pluxee)\b/, "VOUCHER"],
  [/\b(credito|cartao de credito|no cartao|parcelad[oa]|parcelei)\b/, "CREDIT_CARD"],
  [/\b(debito|cartao de debito)\b/, "DEBIT_CARD"],
  [/\bpix\b/, "PIX"],
  [/\b(dinheiro|em especie|especie|na mao|cash)\b/, "CASH"],
  [/\bboleto\b/, "BANK_SLIP"],
  [/\b(ted|doc|transferencia bancaria)\b/, "BANK_TRANSFER"],
];

/** Detecta a forma de pagamento mencionada (a primeira ocorrência no texto vence). */
export function detectPaymentMethod(norm: string): PaymentMethodValue | null {
  let best: { idx: number; method: PaymentMethodValue } | null = null;
  for (const [re, method] of PAYMENT_PATTERNS) {
    const m = re.exec(norm);
    if (m && (best === null || m.index < best.idx)) {
      // "debito automatico" tem precedência sobre "debito"
      if (method === "DEBIT_CARD" && /\bdebito automatico\b/.test(norm)) continue;
      best = { idx: m.index, method };
    }
  }
  return best?.method ?? null;
}

export interface Mention {
  id: string;
  alias: string;
  index: number;
  /** Palavra imediatamente anterior (ex.: "do", "para"). */
  before: string;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMentions(norm: string, entities: Array<{ id: string; aliases: string[] }>): Mention[] {
  const found: Mention[] = [];
  for (const e of entities) {
    for (const alias of e.aliases) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(alias)})(?=$|[^\\p{L}\\p{N}])`, "u");
      const m = re.exec(norm);
      if (m) {
        const index = m.index + m[1]!.length;
        const before = norm.slice(0, index).trim().split(" ").pop() ?? "";
        found.push({ id: e.id, alias, index, before });
        break;
      }
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// -----------------------------------------------------------------------------
// Categoria
// -----------------------------------------------------------------------------

export interface CategoryMatch {
  categoryId: string;
  subcategoryId: string | null;
  label: string;
  score: number;
  keyword: string;
}

export function matchCategory(norm: string, hc: HouseholdContext, kind: "EXPENSE" | "INCOME"): CategoryMatch | null {
  let best: CategoryMatch | null = null;
  const consider = (m: CategoryMatch) => {
    if (!best || m.score > best.score) best = m;
  };
  for (const c of hc.categories) {
    if (c.kind !== kind) continue;
    if (c.normalized && new RegExp(`\\b${escapeRe(c.normalized)}\\b`).test(norm)) {
      consider({ categoryId: c.id, subcategoryId: null, label: c.name, score: 0.6, keyword: c.normalized });
    }
    for (const s of c.subcategories) {
      const terms = [s.normalized, ...s.keywords];
      for (const term of terms) {
        if (!term || term.length < 2) continue;
        if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(term)}(?=$|[^\\p{L}\\p{N}])`, "u").test(norm)) {
          // O nome da subcategoria vale mais que a palavra-chave de outra ("almoço" → Almoço, não Restaurantes).
          consider({ categoryId: c.id, subcategoryId: s.id, label: `${c.name} > ${s.name}`, score: 0.7 + Math.min(term.length, 25) / 100 + (term === s.normalized ? 0.05 : 0), keyword: term });
        }
      }
    }
  }
  return best;
}

// -----------------------------------------------------------------------------
// Pessoas
// -----------------------------------------------------------------------------

const SELF_TERMS = /\b(eu|minha|meu|foi minha|foi meu|pra mim|para mim)\b/;

/** Membro mencionado como autor do gasto ("minha esposa gastou", "a Maria pagou"). */
export function findPerson(norm: string, hc: HouseholdContext): { memberId: string; alias: string } | null {
  const others = hc.members.filter((m) => m.id !== hc.sender?.memberId);
  const mentions = findMentions(norm, others.map((m) => ({ id: m.id, aliases: m.aliases })));
  if (mentions.length) return { memberId: mentions[0]!.id, alias: mentions[0]!.alias };
  // "minha esposa"/"meu marido" sem parentesco cadastrado: o outro adulto com login.
  if (/\b(minha esposa|minha mulher|meu marido|meu esposo|amor dela|ela gastou|ele gastou)\b/.test(norm)) {
    const adults = others.filter((m) => m.hasLogin);
    if (adults.length === 1) return { memberId: adults[0]!.id, alias: "cônjuge" };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Descrição
// -----------------------------------------------------------------------------

const DESCRIPTION_STOP = new Set(
  (
    "hoje ontem anteontem amanha agora amor bem vida querido querida reais real r$ conto contos pila pilas centavos centavo no na nos nas de do da dos das em com pra para pro o a os as um uma uns umas e que foi foram eu nos minha meu " +
    "esposa marido mulher esposo cartao credito debito pix dinheiro especie vezes vez parcelas parcela parcelado parcelada x passei aquele aquela daquele daquela ai ja so mais la aqui tambem conta valor total " +
    "gastei gastou gastamos gastaram gasto paguei pagou pagamos pagaram comprei comprou compramos abasteci abasteceu abastecemos custou saiu recebi recebemos recebeu receberam ganhei ganhamos ganhou entrou entraram caiu " +
    "depositaram depositou vendi vendemos vendeu fiz deu dei tive tivemos mes semana dia dias segunda terca quarta quinta sexta sabado domingo feira passada passado " +
    "por pelo pela via usando usei automatico boleto ted doc vista oi ola gente pessoal registra registrar anota anotar lanca lancar ae ae"
  ).split(" "),
);

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Descrição a partir do texto original (preserva acentos), removendo valores, verbos e referências. */
export function buildDescription(segmentOriginal: string, extraRemovals: string[]): string {
  const removals = new Set(extraRemovals.flatMap((r) => r.split(" ")));
  const tokens = segmentOriginal
    .replace(/[“”"]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  const keep = tokens.map((t) => {
    const n = normalizeForNlu(t);
    if (!n) return false;
    if (/^\d/.test(n) || /^r\$/.test(n)) return false;
    if (/^\d+x$/.test(n)) return false;
    if (removals.has(n)) return false;
    if (["um", "uma", "dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa", "cem", "cento", "mil"].includes(n)) return false;
    if (/^(duzent|trezent|quatrocent|quinhent|seiscent|setecent|oitocent|novecent|onze|doze|treze|catorze|quatorze|quinze|dezess|dezoit|dezenov|milh)/.test(n)) return false;
    return !DESCRIPTION_STOP.has(n);
  });
  const first = keep.indexOf(true);
  const last = keep.lastIndexOf(true);
  if (first < 0) return "";
  const span: string[] = [];
  for (let i = first; i <= last; i++) {
    const n = normalizeForNlu(tokens[i]!);
    if (keep[i] || ["de", "do", "da", "e"].includes(n)) span.push(tokens[i]!);
  }
  return titleCase(span.join(" ").replace(/\s+/g, " ").trim()).slice(0, 80);
}

// -----------------------------------------------------------------------------
// Segmentação (vários lançamentos na mesma mensagem)
// -----------------------------------------------------------------------------

interface Segment {
  original: string;
  norm: string;
  amounts: AmountMention[];
}

function splitSegments(original: string): Segment[] {
  // Protege separadores decimais/milhar ("283,90", "3.500") antes de dividir por vírgulas e pontos.
  const protectedText = original.replace(/(\d),(\d)/g, "$1\u0001$2").replace(/(\d)\.(\d)/g, "$1\u0002$2");
  const parts = protectedText
    .split(/[;\n]|,|\.(?=\s|$)|\s+e\s+(?=(?:r\$\s*)?\d)|\s+e\s+(?=(?:na|no|em|de|do|da|com|pra|para|mais)\s)/i)
    .map((p) => p.replace(/\u0001/g, ",").replace(/\u0002/g, ".").trim())
    .filter(Boolean);
  return parts.map((p) => ({ original: p, norm: normalizeForNlu(p), amounts: extractAmounts(p) }));
}

// -----------------------------------------------------------------------------
// Intenção
// -----------------------------------------------------------------------------

export function detectIntent(norm: string, amounts: AmountMention[]): Intent {
  const short = norm.split(" ").length <= 5;
  if (!norm || !/\p{L}|\d/u.test(norm)) return "SMALL_TALK";
  if (short && RE.confirm.test(norm) && !amounts.length) return "CONFIRMATION";
  if (short && RE.reject.test(norm) && !amounts.length && !RE.delete.test(norm.replace(/^nao\s+/, ""))) return "REJECTION";
  if (RE.restore.test(norm) && !amounts.length) return "RESTORE";
  if (RE.delete.test(norm) && RE.deleteTarget.test(norm) && !/\bfatura\b/.test(norm) && !RE.expenseVerb.test(norm.replace(RE.delete, ""))) return "DELETE";
  if (RE.correction.test(norm) || (RE.correctionFoiNao.test(norm) && (RE.correctionRef.test(norm) || /\b(foi|foram)\s+(no|na|minha|meu|da|do|dia|ontem|em)\b/.test(norm)))) {
    return "CORRECTION";
  }
  const isQuestion = /\?\s*$/.test(norm) || RE.query.test(norm);
  if (isQuestion && RE.financialVocab.test(norm) && !(amounts.length && RE.expenseVerb.test(norm))) return "QUERY";
  if (isQuestion && !amounts.length) return "SMALL_TALK";
  if (amounts.length) return "CREATE_TRANSACTIONS";
  if (RE.cardPayment.test(norm) && RE.cardPaymentVerb.test(norm)) return "CREATE_TRANSACTIONS";
  if (RE.expenseVerb.test(norm) || RE.income.test(norm) || RE.goal.test(norm)) return "CREATE_TRANSACTIONS";
  return "SMALL_TALK";
}

function detectKind(norm: string, hc: HouseholdContext): DraftKind {
  if (RE.cardPayment.test(norm) && RE.cardPaymentVerb.test(norm)) return "CARD_PAYMENT";
  // Aplicação/resgate é transferência para/da conta de investimento (a menos que cite uma meta).
  if (detectInvestmentMessage(norm) && !findMentions(norm, hc.goals).length) return "TRANSFER";
  if (RE.goal.test(norm)) return "GOAL_CONTRIBUTION";
  if (RE.transfer.test(norm)) {
    const accounts = findMentions(norm, hc.accounts);
    if (accounts.length >= 2 || accounts.some((a) => ["para", "pra", "pro", "p"].includes(a.before))) return "TRANSFER";
  }
  if (RE.income.test(norm) && !RE.expenseVerb.test(norm)) return "INCOME";
  return "EXPENSE";
}

// -----------------------------------------------------------------------------
// Rascunhos
// -----------------------------------------------------------------------------

function resolveAccountOrCard(
  norm: string,
  hc: HouseholdContext,
  method: PaymentMethodValue | null,
): { accountHint: string | null; cardHint: string | null; ambiguous: boolean } {
  const accounts = findMentions(norm, hc.accounts);
  const cards = findMentions(norm, hc.cards);
  const acc = accounts[0] ? hc.accounts.find((a) => a.id === accounts[0]!.id)!.name : null;
  const card = cards[0] ? hc.cards.find((c) => c.id === cards[0]!.id)!.name : null;
  if (method === "CREDIT_CARD") return { accountHint: null, cardHint: card, ambiguous: false };
  if (method) return { accountHint: acc, cardHint: null, ambiguous: false };
  if (acc && card) return { accountHint: null, cardHint: card, ambiguous: true };
  return { accountHint: acc, cardHint: card, ambiguous: false };
}

/** Vocabulário de instrução ao sistema (não aparece em anotações de gastos). */
const INSTRUCTION_LIKE = /\b(system|sistema|instruc\w*|ignor\w*|defin\w*|saldo|apag\w*|alter\w*|comando|prompt|sql|drop|delete|update|insert|select|table|tabela)\b/;

function draftFromSegment(seg: Segment, full: { original: string; norm: string }, hc: HouseholdContext, kind: DraftKind, single: boolean): RawDraft {
  const mainAmount = seg.amounts.find((a) => !a.isInstallmentValue) ?? null;
  const installmentValue = seg.amounts.find((a) => a.isInstallmentValue) ?? null;
  const date = extractDate(full.original, hc.today);
  let installments = extractInstallments(seg.original) ?? (single ? extractInstallments(full.original) : null);
  let method = detectPaymentMethod(seg.norm) ?? detectPaymentMethod(full.norm);
  if (installments && installments > 1 && !method) method = "CREDIT_CARD";
  if (method === "CREDIT_CARD" && !installments) installments = 1;

  let amountCents = mainAmount?.cents ?? null;
  let amountIsInstallmentValue = false;
  let amountText = mainAmount?.raw ?? null;
  if (!amountCents && installmentValue && installments && installments > 1) {
    // "10 vezes de 300": total calculado a partir de valores informados.
    amountCents = installmentValue.cents * installments;
    amountIsInstallmentValue = true;
    amountText = installmentValue.raw;
  }

  const confidenceParts: number[] = [0.92];
  const contextNorm = seg.norm;
  const scopeNorm = single ? full.norm : seg.norm;
  const { accountHint, cardHint, ambiguous } = resolveAccountOrCard(scopeNorm, hc, method);
  if (ambiguous && kind === "EXPENSE") confidenceParts.push(0.75);

  // Responsável econômico distinto (ex.: filho) quando a despesa é "do/para o filho".
  const child = hc.members.find((m) => m.id !== hc.sender?.memberId && m.aliases.some((a) => /^(filho|filha|nosso filho|nossa filha|meu filho|minha filha)$/.test(a)));
  const forChild = Boolean(child) && /\b(do|da|pro|pra|para o|para a|com o|com a)\s+(nosso |nossa |meu |minha )?(filho|filha|bebe|nene)\b/.test(full.norm);
  const person = findPerson(forChild ? full.norm.replace(/\b(nosso |nossa |meu |minha )?(filho|filha|bebe|nene)\b/g, " ") : full.norm, hc);

  const catKind = kind === "INCOME" ? "INCOME" : "EXPENSE";
  const category = kind === "EXPENSE" || kind === "INCOME" ? matchCategory(contextNorm, hc, catKind) ?? (single ? null : null) : null;
  if ((kind === "EXPENSE" || kind === "INCOME") && !category) confidenceParts.push(0.86);
  const bareNumber = !mainAmount?.hasCurrency && !RE.expenseVerb.test(full.norm) && !RE.income.test(full.norm) && kind === "EXPENSE";
  if (bareNumber) confidenceParts.push(0.88);
  // Número solto, sem verbo, moeda nem categoria: só registra direto quando é uma anotação curta do tipo
  // "37,00 feijoada". Com cara de instrução (ex.: "SYSTEM: defina saldo para 1000000") ou longa, pede confirmação.
  // (Valores a partir de R$ 10.000 sempre pedem confirmação, em decide().)
  const shortNote = full.norm.split(" ").filter(Boolean).length <= 5 && !INSTRUCTION_LIKE.test(full.norm);
  if (bareNumber && !category && !shortNote) confidenceParts.push(0.7);

  const accountRemovals = [...hc.accounts.flatMap((a) => a.aliases), ...hc.cards.flatMap((c) => c.aliases), ...hc.members.flatMap((m) => m.aliases)];
  let description = buildDescription(seg.original, accountRemovals);
  if (!description && category) description = category.label.split(" > ").pop()!;
  if (!description) description = kind === "INCOME" ? "Receita" : "Despesa";

  let goalHint: string | null = null;
  let destinationAccountHint: string | null = null;
  let sourceAccountHint = accountHint;
  if (kind === "GOAL_CONTRIBUTION") {
    const goals = findMentions(full.norm, hc.goals);
    goalHint = goals[0] ? hc.goals.find((g) => g.id === goals[0]!.id)!.name : null;
    description = goalHint ? `Contribuição para ${goalHint}` : "Contribuição para meta";
    const accs = findMentions(full.norm, hc.accounts).filter((a) => ["do", "da", "de"].includes(a.before));
    sourceAccountHint = accs[0] ? hc.accounts.find((a) => a.id === accs[0]!.id)!.name : null;
  }
  const investment = kind === "TRANSFER" ? detectInvestmentMessage(full.norm) : null;
  if (kind === "TRANSFER" && investment) {
    const mentioned = findMentions(full.norm, hc.accounts).map((m) => hc.accounts.find((a) => a.id === m.id)!);
    const inv = mentioned.find((a) => isInvestmentAccountType(a.type)) ?? null;
    const cash = mentioned.find((a) => !isInvestmentAccountType(a.type)) ?? null;
    sourceAccountHint = (investment === "IN" ? cash : inv)?.name ?? null;
    destinationAccountHint = (investment === "IN" ? inv : cash)?.name ?? null;
    description = investment === "IN" ? `Aplicação${inv ? ` em ${inv.name}` : ""}` : `Resgate${inv ? ` de ${inv.name}` : ""}`;
    method = method && method !== "CREDIT_CARD" ? method : /\bpix\b/.test(full.norm) ? "PIX" : "BANK_TRANSFER";
  } else if (kind === "TRANSFER") {
    const accs = findMentions(full.norm, hc.accounts);
    const from = accs.find((a) => ["do", "da", "de"].includes(a.before)) ?? (accs.length >= 2 ? accs[0] : undefined);
    const to = accs.find((a) => ["para", "pra", "pro", "p", "no", "na"].includes(a.before) && a.id !== from?.id) ?? (accs.length >= 2 ? accs.find((a) => a.id !== from?.id) : undefined);
    sourceAccountHint = from ? hc.accounts.find((a) => a.id === from.id)!.name : null;
    destinationAccountHint = to ? hc.accounts.find((a) => a.id === to.id)!.name : null;
    description = sourceAccountHint && destinationAccountHint ? `Transferência ${sourceAccountHint} → ${destinationAccountHint}` : "Transferência entre contas";
    method = method && method !== "CREDIT_CARD" ? method : /\bpix\b/.test(full.norm) ? "PIX" : "BANK_TRANSFER";
  }
  let cardHintFinal = cardHint;
  if (kind === "CARD_PAYMENT") {
    const cards = findMentions(full.norm, hc.cards);
    cardHintFinal = cards[0] ? hc.cards.find((c) => c.id === cards[0]!.id)!.name : hc.cards.length === 1 ? hc.cards[0]!.name : null;
    const accs = findMentions(full.norm, hc.accounts).filter((a) => ["do", "da", "pelo", "pela", "com", "no", "na"].includes(a.before) && !cards.some((c) => c.alias === a.alias));
    sourceAccountHint = accs[0] ? hc.accounts.find((a) => a.id === accs[0]!.id)!.name : null;
    description = cardHintFinal ? `Pagamento da fatura ${cardHintFinal}` : "Pagamento de fatura";
    method = method && method !== "CREDIT_CARD" ? method : null;
  }

  return {
    kind,
    amountCents,
    amountText,
    amountIsInstallmentValue,
    description,
    merchant: null,
    categoryHint: category?.label ?? null,
    date: date.date,
    dateExplicit: date.explicit,
    paymentMethod: kind === "TRANSFER" || kind === "GOAL_CONTRIBUTION" ? method : method,
    accountHint: sourceAccountHint,
    destinationAccountHint,
    cardHint: kind === "EXPENSE" || kind === "CARD_PAYMENT" ? cardHintFinal : null,
    installments: kind === "EXPENSE" ? installments : null,
    personHint: person ? person.alias : null,
    responsibleHint: forChild && child ? child.displayName : null,
    ownership: forChild ? "INDIVIDUAL" : null,
    goalHint,
    confidence: Math.min(...confidenceParts),
    segment: seg.original,
    investment,
  };
}

// -----------------------------------------------------------------------------
// Correções e exclusões
// -----------------------------------------------------------------------------

function parseCorrection(original: string, norm: string, hc: HouseholdContext): RawCorrection {
  const amounts = extractAmounts(original);
  let newAmount: number | null = null;
  let oldAmount: number | null = null;
  const naoIdx = norm.search(/\bnao\b/);
  if (amounts.length >= 2) {
    // "foram 285 e não 258" → novo = antes do "não"; "não foi 258, foi 285" → novo = depois.
    const firstPos = norm.indexOf(amounts[0]!.raw.split(" ")[0]!);
    if (naoIdx >= 0 && firstPos > naoIdx) {
      oldAmount = amounts[0]!.cents;
      newAmount = amounts[1]!.cents;
    } else {
      newAmount = amounts[0]!.cents;
      oldAmount = amounts[1]!.cents;
    }
  } else if (amounts.length === 1) {
    newAmount = amounts[0]!.cents;
  }

  // Forma de pagamento: a primeira mencionada é a correta ("foi no crédito, não no débito").
  const beforeNao = naoIdx >= 0 ? norm.slice(0, naoIdx) : norm;
  const method = detectPaymentMethod(beforeNao);

  // Categoria: "muda ... para saúde" / "é alimentação"
  let categoryHint: string | null = null;
  const paraMatch = /\b(?:para|pra|como|em)\s+([\p{L}\s]+)$/u.exec(beforeNao.replace(/[.!?]+$/, ""));
  if (paraMatch) {
    const target = paraMatch[1]!.trim();
    const cat = hc.categories.find((c) => c.kind === "EXPENSE" && (c.normalized === target || target.startsWith(c.normalized)));
    const sub = matchCategory(target, hc, "EXPENSE");
    categoryHint = cat ? cat.name : sub ? sub.label : null;
  }

  // Pessoa: "foi minha, não da minha esposa" → remetente; "foi da minha esposa" → cônjuge.
  let personHint: string | null = null;
  if (/\bfoi (minha|meu)\b|\bfui eu\b|\beu que (paguei|gastei)\b/.test(beforeNao)) personHint = "eu";
  else {
    const p = findPerson(beforeNao, hc);
    if (p && /\b(foi|era)\b/.test(beforeNao)) personHint = p.alias;
  }

  const installments = /\bparcela|vezes|\d+x\b/.test(norm) ? extractInstallments(beforeNao) ?? extractInstallments(norm) : null;
  const dateMention = /\b(foi|era)\s+(ontem|anteontem|hoje|dia|na|no)\b/.test(beforeNao) ? extractDate(beforeNao, hc.today) : null;
  const accounts = findMentions(beforeNao, hc.accounts);
  const cards = findMentions(beforeNao, hc.cards);

  // Alvo: palavras de referência (categoria/estabelecimento) e "último".
  const targetLast = /\b(ultim[oa]|esse|essa|isso|anterior)\b/.test(norm);
  const targetCategory = matchCategory(norm, hc, "EXPENSE");
  // "o último"/"a anterior" são referências de posição, não texto a procurar na descrição.
  const refWord = /\b(?:o|a|aquel[ae]|d[oa])\s+(?:compra|gasto|despesa)?\s*(?:d[oa]|n[oa])?\s*([\p{L}]{4,})/u.exec(norm)?.[1] ?? null;
  const targetText = targetCategory?.keyword ?? (refWord && !/^(ultim[oa]s?|anterior|aquel[ae])$/.test(refWord) ? refWord : null);
  const targetDate = /\b(de ontem|de hoje|de anteontem)\b/.test(norm) ? extractDate(norm, hc.today).date : null;

  const changes: RawCorrection["changes"] = {};
  if (newAmount !== null) changes.amountCents = newAmount;
  if (method) changes.paymentMethod = method;
  if (categoryHint) changes.categoryHint = categoryHint;
  if (personHint) changes.personHint = personHint;
  if (installments && installments >= 1) changes.installments = installments;
  if (dateMention?.explicit) changes.date = dateMention.date;
  if (cards[0] && method !== "DEBIT_CARD" && method !== "PIX") changes.cardHint = hc.cards.find((c) => c.id === cards[0]!.id)!.name;
  else if (accounts[0]) changes.accountHint = hc.accounts.find((a) => a.id === accounts[0]!.id)!.name;

  return {
    targetLast,
    targetText: targetCategory && categoryHint && targetCategory.label.startsWith(categoryHint) ? null : targetText,
    targetAmountCents: oldAmount,
    targetDate,
    changes,
  };
}

function parseDeletion(original: string, norm: string, hc: HouseholdContext): RawDeletion {
  const amounts = extractAmounts(original);
  const category = matchCategory(norm, hc, "EXPENSE") ?? matchCategory(norm, hc, "INCOME");
  return {
    targetLast: /\b(ultim[oa]|esse|essa|isso|anterior)\b/.test(norm) || (!category && !amounts.length),
    targetText: category?.keyword ?? null,
    targetAmountCents: amounts[0]?.cents ?? null,
    bulk: RE.bulk.test(norm),
  };
}

// -----------------------------------------------------------------------------
// Entrada principal
// -----------------------------------------------------------------------------

export function parseLocally(text: string, hc: HouseholdContext): RawInterpretation {
  const original = sanitizeUntrusted(text);
  const norm = normalizeForNlu(original);
  const amounts = extractAmounts(original);
  const intent = detectIntent(norm, amounts);
  const base: RawInterpretation = { intent, drafts: [], correction: null, deletion: null, question: null, confidence: 0.9, engine: "LOCAL", model: null };

  switch (intent) {
    case "QUERY":
      return { ...base, question: original };
    case "CORRECTION":
      return { ...base, correction: parseCorrection(original, norm, hc), confidence: 0.8 };
    case "DELETE":
      return { ...base, deletion: parseDeletion(original, norm, hc), confidence: 0.85 };
    case "CREATE_TRANSACTIONS": {
      const kind = detectKind(norm, hc);
      const realAmounts = amounts.filter((a) => !a.isInstallmentValue);
      if (realAmounts.length > 1 && kind === "EXPENSE") {
        const segments = splitSegments(original).filter((s) => s.amounts.length > 0);
        const drafts: RawDraft[] = [];
        for (const seg of segments) {
          const segAmounts = seg.amounts.filter((a) => !a.isInstallmentValue);
          if (segAmounts.length === 1) drafts.push(draftFromSegment(seg, { original, norm }, hc, kind, false));
          else {
            // Mais de um valor no mesmo trecho: divide pelas posições dos valores.
            const toks = seg.original.split(/\s+/);
            const segNormToks = seg.norm.split(" ");
            const ranges = segAmounts.map((a, i) => [a.start, segAmounts[i + 1]?.start ?? segNormToks.length] as const);
            for (const [s, e] of ranges) {
              const piece = toks.slice(s, e).join(" ");
              drafts.push(draftFromSegment({ original: piece, norm: normalizeForNlu(piece), amounts: extractAmounts(piece) }, { original, norm }, hc, kind, false));
            }
          }
        }
        // Segmentação incerta reduz a confiança (confirmação recomendada).
        const consistent = drafts.length === realAmounts.length;
        return { ...base, drafts: drafts.map((d) => ({ ...d, confidence: Math.min(d.confidence, consistent ? 0.9 : 0.6) })) };
      }
      const seg: Segment = { original, norm, amounts };
      return { ...base, drafts: [draftFromSegment(seg, { original, norm }, hc, kind, true)] };
    }
    default:
      return base;
  }
}
