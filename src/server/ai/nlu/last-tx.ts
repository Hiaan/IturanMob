import { normalizeForNlu } from "./text";
import { extractAmounts } from "./numbers";
import { detectPaymentMethod, findMentions } from "./local-parser";
import type { PaymentMethodValue } from "../engine/schemas";
import type { HouseholdContext } from "../engine/context";

/**
 * Comandos sobre o ÚLTIMO lançamento, falados de forma natural (texto ou áudio), sem IA:
 * - cancelar: "cancela", "esquece", "apaga isso", "não era pra lançar", "lancei errado, apaga";
 * - desfazer: "desfaz" (desfaz a exclusão recente; sem exclusão, cancela o último);
 * - voltar: "volta", "restaura" (desfaz a exclusão);
 * - descrição: "não é revirante, é refrigerante", "era refrigerante", "o nome é refrigerante",
 *   "errou, é refrigerante", "corrige pra refrigerante", "é refrigerante";
 * - valor: "foram 15", "foi 15 reais", "não, 15 reais", "valor errado, 15";
 * - forma de pagamento: "foi no crédito", "no débito", "foi no cartão Inter";
 * - categoria: "muda pra mercado", "coloca em lazer", "a categoria é saúde".
 * Quem decide o alvo (mensagem citada ou o último lançamento de quem escreveu) é o chamador.
 */

export type LastTxCommand =
  | { action: "CANCEL" }
  | { action: "UNDO" }
  | { action: "RESTORE" }
  /** `explicit`: tem marca de correção ("não é", "era", "o nome é", "corrige"); "é Y" sozinho não tem. */
  | { action: "DESCRIBE"; right: string; wrong: string | null; explicit: boolean }
  | { action: "AMOUNT"; amountCents: number }
  | { action: "PAYMENT"; paymentMethod: PaymentMethodValue | null; cardHint: string | null; accountHint: string | null }
  | { action: "CATEGORY"; hint: string };

const POLITE = /[\s,]+(por favor|pfv|pf|obrigad[oa]|valeu|ta|ok)\s*$/;
const LEAD = /^(ah|opa|ops|eita|nossa|putz|poxa|ei|olha)[,!.\s]+/;
/** Verbo de lançamento novo: "paguei 15 no uber" nunca é correção. */
const NEW_TX_VERB = /\b(gastei|gastou|gastamos|paguei|pagou|pagamos|comprei|comprou|compramos|recebi|recebemos|recebeu|ganhei|transferi|mandei|abasteci|almocei|jantei)\b/;

const CANCEL_RE =
  /^(?:(?:nao era isso|errei|lancei errado|lancou errado|registrou errado|registrei errado|ta errado|esta errado|errado)[,.!]?\s+)?(?:cancela|cancelar|cancele|esquece|esquecer|esqueca|apaga|apagar|apague|deleta|deletar|delete|exclui|excluir|exclua|remove|remover|remova)(?:\s+(?:isso|isso ai|esse|essa|este|esta|esse ai|esse lancamento|o lancamento|o ultimo|o ultimo lancamento|a ultima|ai|ele|ela|pra mim|por favor))*$/;
const NOT_MEANT_RE = /^(?:nao era (?:pra|para) (?:lancar|registrar|anotar)|nao (?:precisava|precisa) (?:lancar|registrar)|nao (?:lanca|registra|anota) (?:isso|esse))(?:\s+(?:isso|esse|nao))?$/;
const UNDO_RE = /^(?:desfaz|desfazer|desfaca|desfaz isso|desfaz esse|desfaz o ultimo)$/;
const RESTORE_RE = /^(?:volta|voltar|volte|volta ele|volta ela|volta isso|volta o lancamento|traz de volta|restaura|restaurar|restaure|recupera|recuperar|desfaz a exclusao|desfazer a exclusao|nao era pra apagar|apaguei errado)$/;

/** Palavras que podem sobrar numa correção de valor ("valor errado, foram 15 reais"). */
const AMOUNT_FILLER = new Set(
  "foram foi era e eh sao deu ficou nao valor errado errei o a na verdade reais real centavos centavo r$ total corrige corrigir pra para de do da certo correto na verdade ops".split(" "),
);
/** Palavras que podem sobrar numa correção de forma de pagamento. */
const PAYMENT_FILLER = new Set(
  "foi era e eh nao no na pelo pela com o a de do da cartao conta paguei pago pagamento forma credito debito pix dinheiro especie boleto ted transferencia corrige corrigir pra para muda mudar".split(" "),
);

const tidy = (s: string) =>
  s
    .replace(/[“”"'*_]/g, "")
    .replace(/[.!?;,:]+$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();

function clean(norm: string): string {
  let t = norm.replace(/[.!?]+$/g, "").trim();
  for (let i = 0; i < 2; i++) t = t.replace(POLITE, "").replace(LEAD, "").trim();
  return t;
}

/** Respostas que não são um nome ("é isso", "é verdade", "é sério"). */
const NOT_A_NAME = new Set(
  "isso isso ai isso mesmo esse essa este esta ele ela eles elas verdade serio mentira brincadeira sim nao ok certo correto errado tudo nada bom boa otimo otima legal isso sim assim aqui ali la agora hoje ontem amanha nosso nossa meu minha dele dela o a os as um uma".split(" "),
);

/** "Y" válido para descrição: 1 a 5 palavras, sem números, que não seja "isso", "verdade"… */
function asDescription(raw: string | undefined): string | null {
  const t = tidy(raw ?? "");
  if (!t || /\d/.test(t) || t.length < 3 || NOT_A_NAME.has(normalizeForNlu(t))) return null;
  const n = t.split(/\s+/);
  if (n.length > 5 || t.length > 60) return null;
  return t;
}

/** Trecho do texto original correspondente ao trecho normalizado (preserva acentos e maiúsculas). */
function recover(text: string, normSpan: string): string {
  const span = tidy(normSpan).split(/\s+/).filter(Boolean);
  const orig = text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
  for (let i = 0; i + span.length <= orig.length; i++) {
    if (span.every((w, k) => normalizeForNlu(orig[i + k]!) === w)) return orig.slice(i, i + span.length).join(" ");
  }
  return tidy(normSpan);
}

export function parseLastTxCommand(text: string, hc: HouseholdContext): LastTxCommand | null {
  if (!text || text.length > 160) return null;
  const norm = clean(normalizeForNlu(text));
  if (!norm) return null;
  const nWords = norm.split(/\s+/).length;
  if (nWords > 10) return null;

  if (CANCEL_RE.test(norm) || NOT_MEANT_RE.test(norm) || /^(?:lancei|registrei) errado[,.]?\s+(?:apaga|cancela|exclui)\b/.test(norm)) return { action: "CANCEL" };
  if (UNDO_RE.test(norm)) return { action: "UNDO" };
  if (RESTORE_RE.test(norm)) return { action: "RESTORE" };

  const amounts = extractAmounts(text);
  const newTx = NEW_TX_VERB.test(norm);

  // Valor: um valor só e nada além de palavras de ligação ("foram 15", "não, 15 reais").
  if (amounts.length === 1 && !newTx && nWords <= 7) {
    const rest = norm
      .replace(/r\$\s*/g, " ")
      .replace(/\d+(?:[.,]\d+)*/g, " ")
      .replace(/\b(mil|cem|cento|reais|real|centavos?)\b/g, " ")
      .split(/[\s,;:.!-]+/)
      .filter(Boolean)
      .filter((w) => !AMOUNT_FILLER.has(w));
    // Número solto ("2", "15") é resposta de menu ou lançamento, nunca correção: precisa de marca
    // ("foram", "foi", "era", "valor", "reais", "não,", "na verdade").
    const marked = /\b(foram|foi|era|e|eh|sao|deu|ficou|valor|reais|real|centavos?|nao|verdade|corrige|corrigir|total)\b|r\$/.test(norm);
    if (!rest.length && marked) return { action: "AMOUNT", amountCents: amounts[0]!.cents };
    return null;
  }
  if (amounts.length) return null;

  // Categoria: "muda pra mercado", "coloca em lazer", "a categoria é saúde".
  const cat =
    /^(?:muda|mude|mudar|troca|troque|trocar|coloca|coloque|colocar|poe|ponha|passa|passe|joga)(?: a categoria| de categoria| categoria)?\s+(?:pra|para|em|na|no|como)\s+(.+)$/.exec(norm) ??
    /^(?:a\s+)?categoria(?: certa| correta)?\s+(?:e|eh|era|foi)?\s*(.+)$/.exec(norm);
  if (cat) {
    const hint = asDescription(recover(text, cat[1]!));
    if (hint) return { action: "CATEGORY", hint };
  }

  // Forma de pagamento: "foi no crédito", "no débito", "foi no cartão Inter".
  const method = detectPaymentMethod(norm);
  const cards = findMentions(norm, hc.cards);
  const accounts = findMentions(norm, hc.accounts);
  if ((method || cards.length || accounts.length) && !newTx && nWords <= 7) {
    const mentioned = new Set([...cards, ...accounts].flatMap((m) => m.alias.split(" ")));
    const rest = norm
      .split(/[\s,;:.!-]+/)
      .filter(Boolean)
      .filter((w) => !PAYMENT_FILLER.has(w) && !mentioned.has(w));
    if (!rest.length && /^(?:foi|era|e|eh|nao|no|na|pelo|pela|com|paguei|pago|corrige|muda)\b/.test(norm)) {
      const card = cards[0] ? hc.cards.find((c) => c.id === cards[0]!.id) : undefined;
      const account = accounts[0] ? hc.accounts.find((a) => a.id === accounts[0]!.id) : undefined;
      return {
        action: "PAYMENT",
        paymentMethod: method ?? (card ? "CREDIT_CARD" : null),
        cardHint: card?.name ?? null,
        accountHint: account && !card ? account.name : null,
      };
    }
  }

  // Pergunta nunca é correção ("é sério?").
  if (newTx || /\?\s*$/.test(text)) return null;

  // Descrição.
  const notXisY = /^nao (?:e|eh|foi|era) (.+?),? (?:e|eh|foi|era|mas) (.+)$/.exec(norm);
  if (notXisY) {
    const right = asDescription(recover(text, notXisY[2]!.replace(/^(?:e|eh|foi|era) /, "")));
    const wrong = asDescription(notXisY[1]);
    if (right && wrong && !/^(?:e|eh|foi|era)\b/.test(right)) return { action: "DESCRIBE", right, wrong, explicit: true };
  }
  const yNotX = /^(?:e|eh|era|foi) (.+?),? (?:e )?nao (?:e |eh |era |foi )?(.+)$/.exec(norm);
  if (yNotX) {
    const right = asDescription(recover(text, yNotX[1]!));
    const wrong = asDescription(yNotX[2]);
    if (right && wrong) return { action: "DESCRIBE", right, wrong, explicit: true };
  }
  const explicitRe =
    /^(?:(?:o nome|a descricao|o certo|o correto|a palavra|o produto|o item)(?: certo| correto)? (?:e|eh|era|foi)|(?:errou|errado|ta errado|esta errado|entendeu errado|ouviu errado|escreveu errado|anotou errado|registrou errado|lancou errado|errei)[,.:]?(?: (?:e|eh|era|foi))?|(?:corrige|corrija|corrigir|troca|troque|trocar|muda|mude|mudar|renomeia|renomear)(?: o nome| a descricao)?(?: (?:pra|para|por))?:?|(?:na verdade|quis dizer|eu falei|falei|eu disse|disse)(?: (?:e|eh|foi|era))?|era) (.+)$/;
  const ex = explicitRe.exec(norm);
  if (ex) {
    const right = asDescription(recover(text, ex[1]!));
    if (right) return { action: "DESCRIBE", right, wrong: null, explicit: true };
  }
  const plain = /^(?:e|eh) (.+)$/.exec(norm);
  if (plain) {
    const right = asDescription(recover(text, plain[1]!));
    if (right && right.split(/\s+/).length <= 3) return { action: "DESCRIBE", right, wrong: null, explicit: false };
  }
  return null;
}
