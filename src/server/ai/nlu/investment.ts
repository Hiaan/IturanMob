/**
 * Mensagens de aplicação/resgate ("apliquei 1000 no CDB", "resgatei 500 da caixinha",
 * "guardei 200 na poupança"): é dinheiro da família indo para (IN) ou voltando de (OUT) uma conta de
 * investimento — transferência, não receita/despesa. Rendimento/juros continuam sendo receita.
 * Recebe texto já normalizado (normalizeForNlu).
 */

const YIELD = /\b(rendeu|renderam|rendimento|rendimentos|juros|dividendo|dividendos|proventos)\b/;
const OUT_VERB = /\b(resgatei|resgatamos|resgatou|resgataram|resgatar|resgate|resgatado)\b/;
const WITHDRAW_VERB = /\b(saquei|sacamos|sacou|tirei|tiramos|tirou|retirei|retiramos|retirou|peguei|pegamos)\b/;
const IN_VERB = /\b(apliquei|aplicamos|aplicou|aplicaram|aplicar|aplicacao|investi|investimos|investiu|investiram)\b/;
const SAVE_VERB = /\b(guardei|guardamos|guardou|coloquei|colocamos|colocou|depositei|depositamos|aportei|aportamos|separei|separamos|poupei|poupamos|mandei|transferi|transferimos|passei|movi)\b/;
export const INVESTMENT_PRODUCT = /\b(cdb|rdb|lci|lca|tesouro|poupanca|caixinha|caixinhas|cofrinho|porquinho|investimento|investimentos|renda fixa|fundo de investimento|previdencia)\b/;

export function detectInvestmentMessage(norm: string): "IN" | "OUT" | null {
  if (!norm || YIELD.test(norm)) return null;
  const product = INVESTMENT_PRODUCT.test(norm);
  if (OUT_VERB.test(norm) || (WITHDRAW_VERB.test(norm) && product)) return "OUT";
  if (IN_VERB.test(norm) || (SAVE_VERB.test(norm) && product)) return "IN";
  return null;
}

export function isInvestmentAccountType(type: string): boolean {
  return type === "INVESTMENT" || type === "SAVINGS";
}
