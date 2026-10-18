import type { Prisma, ReportExclusionReason } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { formatBRL } from "@/lib/money";
import { normalizeText } from "@/lib/utils";
import { dateToISO } from "@/lib/dates";
import { EXCLUSION_REASON_LABELS, passthroughSummary, setReportExclusion } from "../../modules/transactions/report-exclusion";
import { setTransactionNature } from "../../modules/transactions/nature";
import { extractAmounts } from "../nlu/numbers";
import { normalizeForNlu } from "../nlu/text";
import { closeClarification, openClarification } from "./clarifications";
import { relativeDate } from "./replies";
import type { HouseholdContext } from "./context";

/**
 * "Desconsiderar nos relatórios" pelo WhatsApp — comandos determinísticos (sem IA):
 * - "desconsidera esse" respondendo (citando) a mensagem do lançamento ou a confirmação do robô;
 * - "o pix do fulano é repasse", "isso foi reembolso", "desconsidera o anúncio de 300";
 * - "considerar de novo" / "volta a considerar" desfaz.
 * Só marca o lançamento: saldo da conta, fatura do cartão e projeção não mudam.
 */

export interface ExclusionCommand {
  /** EXCLUDE = Repasse (desconsiderar); INCLUDE = desfazer; BUSINESS/PERSONAL = natureza Empresa/Pessoal. */
  action: "EXCLUDE" | "INCLUDE" | "BUSINESS" | "PERSONAL";
  reason: ReportExclusionReason;
  /** Cliente/pessoa citada ("pix do Fulano", "repasse do cliente X"). */
  party: string | null;
  /** Palavras para achar o lançamento (sem os termos do comando). */
  targetText: string | null;
  targetAmountCents: number | null;
  targetType: "INCOME" | "EXPENSE" | null;
}

const INCLUDE_RE = /^(volta(r)? a considerar|voltar? a contar|considera(r)? (de novo|novamente)|reconsidera(r)?|pode considerar|nao (e|eh|era|foi) (um |uma )?(repasse|reembolso))\b/;
const DESCONSIDERA_RE = /\bdesconsider(a|ar|e|em|ou)\b/;
const COPULA_RE = /\b(e|eh|foi|era|sao|foram|e um|e uma|foi um|foi uma)\s+(um\s+|uma\s+)?(repasse|reembolso)\b/;
const MARK_RE = /\b(marca(r)?|marque|considera(r)?|considere|trata(r)?|trate|coloca(r)?|coloque)\s+(como|de)\s+(repasse|reembolso)\b/;
/** Mensagem com verbo de gasto/recebimento e valor é um lançamento novo ("recebi 500 do Fulano, é repasse"). */
const NEW_TX_VERB = /\b(gastei|gastou|gastamos|paguei|pagou|pagamos|comprei|comprou|compramos|recebi|recebemos|recebeu|ganhei|entrou|entraram|caiu|cairam|transferi|fiz um pix|fiz pix|mandei)\b/;

const CONNECTORS = new Set(["de", "da", "do", "das", "dos", "e"]);

/** "isso é da empresa", "marca como empresa", "é empresa". */
const BUSINESS_RE = /\b(e|eh|foi|era|sao|foram)\s+((da|de|pra|para a|p\/ a)\s+)?empresa\b|\b(marca\w*|marque|considera\w*|considere|coloca\w*|coloque|passa\w*|passe|trata\w*|trate|joga\w*|joga)\s+(como|na|pra|para a|para)\s+(da\s+)?empresa\b|\b(gasto|despesa|custo|receita|pagamento|conta)\s+da\s+empresa\b/;
/** "isso é pessoal", "não é da empresa", "marca como pessoal". */
const PERSONAL_RE = /\b(e|eh|foi|era)\s+(pessoal|particular|meu|minha|nosso|nossa|da familia|de casa)\b|\b(marca\w*|marque|considera\w*|considere|coloca\w*|coloque|volta\w*|passa\w*)\s+(como|pra|para|no)\s+pessoal\b|\bnao\s+(e|eh|foi|era)\s+(da\s+)?empresa\b/;

function titleCase(s: string): string {
  return s
    .split(" ")
    .filter(Boolean)
    .map((w, i) => (i > 0 && CONNECTORS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Nome depois de "pix do/da/de", "repasse do/da/de (cliente)", "anúncio do cliente" etc. */
function extractParty(norm: string): string | null {
  const m =
    /\b(?:repasse|reembolso|pix|pagamento|transferencia|ted|deposito|anuncios?|ads|campanha|gastos?)(?:\s+(?:de\s+)?(?:r\$\s*)?\d[\d.,]*(?:\s*reais)?)?\s+(?:recebido\s+)?(?:do|da|de|dos|das|pro|pra|para o|para a|para)\s+(?:cliente\s+|empresa\s+)?([a-z][a-z0-9]*(?:\s+(?:de|da|do|dos|das|e)?\s*[a-z][a-z0-9]*){0,3})/.exec(norm) ??
    /\bcliente\s+([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*){0,2})/.exec(norm) ??
    // "recebi 200 do Beltrano, é repasse"
    /\b(?:recebi|recebemos|recebeu|recebido|recebida|veio|chegou)\b[^,;]*?\b(?:do|da|dos|das)\s+(?!pix\b|cliente\b)([a-z][a-z0-9]*(?:\s+(?:de|da|do|dos|das|e)?\s*[a-z][a-z0-9]*){0,3})/.exec(norm);
  if (!m) return null;
  // Corta no que já não é nome: verbos de ligação, termos do comando, pronomes.
  const stop = /\s+(e|eh|foi|era|sao|foram|que|nos|no|na|do mes|desse|deste|esse|este|isso|repasse|reembolso|desconsidera\w*|hoje|ontem|semana|mes|de \d.*|\d.*)$/;
  let name = m[1]!.trim();
  for (let i = 0; i < 4; i++) name = name.replace(stop, "").trim();
  if (!name || ["esse", "este", "isso", "ele", "ela", "mim", "voce", "cliente", "conta", "cartao", "mes"].includes(name)) return null;
  return titleCase(name).slice(0, 80);
}

/** Interpreta o comando; null quando a mensagem não é sobre desconsiderar. */
export function parseExclusionCommand(text: string): ExclusionCommand | null {
  const norm = normalizeForNlu(text).trim();
  if (!norm || norm.length > 300) return null;
  // "desconsidera a mensagem anterior" é desfazer o que foi enviado (exclusão), não repasse.
  if (/\bmensage(m|ns)\b/.test(norm) && !/\b(repasse|reembolso|relatorios?)\b/.test(norm)) return null;
  const personal = PERSONAL_RE.test(norm);
  const business = !personal && BUSINESS_RE.test(norm);
  const include = !personal && !business && INCLUDE_RE.test(norm);
  const exclude = !personal && !business && !include && (DESCONSIDERA_RE.test(norm) || COPULA_RE.test(norm) || MARK_RE.test(norm));
  if (!include && !exclude && !personal && !business) return null;
  const amounts = extractAmounts(text);
  // "paguei 750 pro Ícaro, empresa" é lançamento novo (natureza vai junto no registro).
  if ((business || personal) && amounts.length && NEW_TX_VERB.test(norm)) return null;
  // "recebi 500 do Fulano, é repasse" é um lançamento novo: quem trata é o fluxo normal.
  if (exclude && amounts.length && NEW_TX_VERB.test(norm)) return null;

  const reason: ReportExclusionReason = /\breembolso\b/.test(norm) ? "REIMBURSEMENT" : /\b(repasse|cliente)\b/.test(norm) ? "CLIENT_PASSTHROUGH" : "OTHER";
  const party = extractParty(norm);
  const targetType: ExclusionCommand["targetType"] = /\b(pix|transferencia|ted|deposito|pagamento) (recebido |)(do|da|de)\b|\brecebid[oa]\b/.test(norm)
    ? "INCOME"
    : /\b(anuncios?|ads|facebook|facebk|meta ads|google ads|compra|gasto|cartao)\b/.test(norm)
      ? "EXPENSE"
      : null;
  // Texto-alvo: o que sobra tirando os termos do comando e palavras de ligação.
  const rest = norm
    .replace(INCLUDE_RE, " ")
    .replace(PERSONAL_RE, " ")
    .replace(BUSINESS_RE, " ")
    .replace(/\b(empresa|pessoal|particular)\b/g, " ")
    .replace(/\bdesconsider\w*\b|\b(e|eh|foi|era|sao|foram)\s+(um\s+|uma\s+)?(repasse|reembolso)\b|\b(marca\w*|marque|considera\w*|considere|trata\w*|trate|coloca\w*|coloque)\s+(como|de)\s+(repasse|reembolso)\b/g, " ")
    .replace(/\b(repasse|reembolso|de cliente|do cliente|da cliente|cliente|nos relatorios|no relatorio|relatorios?|esse|este|essa|esta|isso|isto|aqui|ai|o|a|os|as|um|uma|lancamento|por favor|pf|pfv|favor|tambem|de novo|novamente)\b/g, " ")
    .replace(/[.,!?:;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const targetText = party ? normalizeText(party) : rest.length >= 3 && !/^\d+$/.test(rest) ? rest : null;
  const action: ExclusionCommand["action"] = personal ? "PERSONAL" : business ? "BUSINESS" : include ? "INCLUDE" : "EXCLUDE";
  return {
    action,
    reason,
    party: action === "EXCLUDE" || action === "INCLUDE" ? party : null,
    targetText: action === "EXCLUDE" || action === "INCLUDE" ? targetText : rest.length >= 3 && !/^\d+$/.test(rest) ? rest : null,
    targetAmountCents: amounts[0]?.cents ?? null,
    targetType,
  };
}

/** Tira o marcador ("é repasse", "desconsidera") do texto do lançamento novo (não vira descrição). */
const MARKER_STRIP =
  /(^|[\s,;.!])(?:(?:é|e|eh|foi|era|são|sao|foram)\s+(?:um\s+|uma\s+)?(?:repasse|reembolso)|(?:marca|marcar|marque|considera|considerar|considere|trata|tratar|trate)\s+(?:como|de)\s+(?:repasse|reembolso)|desconsider(?:a|ar|e)(?:\s+(?:esse|este|isso|nos relat[óo]rios))?)(?:\s+(?:de|do|da)\s+cliente)?(?=$|[\s,;.!])/giu;
export function stripExclusionMarker(text: string): string {
  return text
    .replace(MARKER_STRIP, "$1")
    .replace(/[\s,;.!-]+$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Marcador de repasse/reembolso numa mensagem que também cria o lançamento. */
export function hasExclusionMarker(text: string): ExclusionCommand | null {
  const norm = normalizeForNlu(text).trim();
  // "empresa"/"PF" no lançamento novo é natureza, decidida na criação (nlu/nature.ts).
  if (!(COPULA_RE.test(norm) || MARK_RE.test(norm) || DESCONSIDERA_RE.test(norm))) return null;
  // Só em mensagem de lançamento novo (verbo + valor); "desconsidera a mensagem anterior" segue o fluxo normal.
  if (/\bmensage(m|ns)\b/.test(norm) || !NEW_TX_VERB.test(norm) || !extractAmounts(text).length) return null;
  const reason: ReportExclusionReason = /\breembolso\b/.test(norm) ? "REIMBURSEMENT" : /\b(repasse|cliente)\b/.test(norm) ? "CLIENT_PASSTHROUGH" : "OTHER";
  return { action: "EXCLUDE", reason, party: extractParty(norm), targetText: null, targetAmountCents: null, targetType: null };
}

// -----------------------------------------------------------------------------
// Alvo do comando
// -----------------------------------------------------------------------------

export interface QuotedRef {
  connectionId: string;
  externalId: string;
}

type Candidate = { id: string; description: string; amountCents: number; date: Date; type: string; excludedFromReports: boolean; exclusionParty: string | null; createdByMemberId: string | null; scope: string; natureReview: boolean };
const CANDIDATE_SELECT = { id: true, description: true, amountCents: true, date: true, type: true, excludedFromReports: true, exclusionParty: true, createdByMemberId: true, scope: true, natureReview: true } as const;

/** Lançamentos da mensagem citada (a do próprio lançamento ou a confirmação do robô). */
async function fromQuoted(ctx: ServiceContext, quoted: QuotedRef): Promise<Candidate[] | null> {
  let msg = await prisma.whatsAppMessage.findUnique({
    where: { connectionId_externalId: { connectionId: quoted.connectionId, externalId: quoted.externalId } },
    select: { id: true, householdId: true, direction: true, quotedExternalId: true, connectionId: true },
  });
  if (!msg || msg.householdId !== ctx.householdId) return null;
  // Resposta do robô: ela cita a mensagem original do lançamento.
  if (msg.direction === "OUTBOUND" && msg.quotedExternalId) {
    msg = await prisma.whatsAppMessage.findUnique({
      where: { connectionId_externalId: { connectionId: msg.connectionId, externalId: msg.quotedExternalId } },
      select: { id: true, householdId: true, direction: true, quotedExternalId: true, connectionId: true },
    });
    if (!msg || msg.householdId !== ctx.householdId) return null;
  }
  const txs = await prisma.transaction.findMany({
    where: { householdId: ctx.householdId, sourceMessageId: msg.id, deletedAt: null, type: { in: ["INCOME", "EXPENSE"] } },
    orderBy: { sourceIndex: "asc" },
    select: CANDIDATE_SELECT,
  });
  return txs;
}

async function searchCandidates(ctx: ServiceContext, cmd: ExclusionCommand, hc: HouseholdContext): Promise<Candidate[]> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const where: Prisma.TransactionWhereInput = {
    householdId: ctx.householdId,
    deletedAt: null,
    type: cmd.targetType ? cmd.targetType : { in: ["INCOME", "EXPENSE"] },
    ...(cmd.action === "INCLUDE" ? { excludedFromReports: true } : {}),
    ...(cmd.targetAmountCents ? { amountCents: cmd.targetAmountCents } : {}),
  };
  if (!cmd.targetText) {
    // "desconsidera esse"/"isso é repasse" sem citar: o último lançamento de quem escreveu.
    if (cmd.action === "INCLUDE") {
      const last = await prisma.transaction.findFirst({
        where: { ...where, excludedByMemberId: hc.sender?.memberId ?? undefined, excludedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        orderBy: { excludedAt: "desc" },
        select: CANDIDATE_SELECT,
      });
      return last ? [last] : [];
    }
    const last = await prisma.transaction.findFirst({
      where: { ...where, createdByMemberId: hc.sender?.memberId ?? undefined, createdAt: { gte: new Date(Date.now() - 2 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      select: CANDIDATE_SELECT,
    });
    return last ? [last] : [];
  }
  const rows = await prisma.transaction.findMany({
    where: { ...where, OR: [{ date: { gte: since } }, { createdAt: { gte: since } }] },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 400,
    select: { ...CANDIDATE_SELECT, merchant: { select: { name: true } } },
  });
  const words = cmd.targetText.split(" ").filter((w) => w.length >= 3 && !CONNECTORS.has(w));
  const matches = rows.filter((r) => {
    const hay = normalizeText(`${r.description} ${r.merchant?.name ?? ""} ${r.exclusionParty ?? ""}`);
    return words.length ? words.every((w) => hay.includes(w)) : hay.includes(cmd.targetText!);
  });
  return matches.map(({ merchant: _m, ...r }) => r);
}

function line(c: Candidate, hc: HouseholdContext): string {
  return `${c.description} — ${formatBRL(c.amountCents)} (${relativeDate(dateToISO(c.date), hc.today)})`;
}

export interface ExclusionOutcome {
  status: "PROCESSED" | "NEEDS_CLARIFICATION";
  intent: "REPORT_EXCLUSION";
  replies: string[];
  transactionIds: string[];
  detail?: string;
}

async function partyBalanceLine(ctx: ServiceContext, party: string | null): Promise<string | null> {
  if (!party) return null;
  const sum = await passthroughSummary(ctx);
  const p = sum.parties.find((x) => x.party && normalizeText(x.party) === normalizeText(party));
  if (!p || (!p.receivedCents && !p.spentCents)) return null;
  const tail =
    p.balanceCents < 0 ? `falta receber ${formatBRL(-p.balanceCents)}` : p.balanceCents > 0 ? `recebido a mais ${formatBRL(p.balanceCents)}` : "repasse zerado";
  return `Repasse com ${p.party}: recebido ${formatBRL(p.receivedCents)}, gasto ${formatBRL(p.spentCents)} → ${tail}.`;
}

/** Aplica o comando aos lançamentos escolhidos e monta a resposta. */
export async function applyExclusion(ctx: ServiceContext, hc: HouseholdContext, cmd: Pick<ExclusionCommand, "action" | "reason" | "party">, ids: string[]): Promise<ExclusionOutcome> {
  if (cmd.action === "BUSINESS" || cmd.action === "PERSONAL") {
    const res = await setTransactionNature(ctx, { transactionIds: ids, nature: cmd.action }, { reason: `Natureza via WhatsApp: ${cmd.action === "BUSINESS" ? "Empresa" : "Pessoal"} (saldo e fatura não mudam)` });
    if (!res.updated) return { status: "PROCESSED", intent: "REPORT_EXCLUSION", replies: [res.skipped[0]?.reason ?? "Nada a alterar."], transactionIds: [], detail: "nada alterado" };
    const lines = res.items.map((t) => `• ${t.description} — ${formatBRL(t.amountCents)} (${relativeDate(t.date, hc.today)})`).join("\n");
    return {
      status: "PROCESSED",
      intent: "REPORT_EXCLUSION",
      replies: [
        cmd.action === "BUSINESS"
          ? `🏢 Marcado como *Empresa*:\n${lines}\nSai dos relatórios pessoais e entra no resultado da empresa. Saldo e fatura não mudam.`
          : `🏠 Marcado como *Pessoal*:\n${lines}\nVolta a contar nos relatórios da família. Saldo e fatura não mudam.`,
      ],
      transactionIds: res.items.map((t) => t.id),
    };
  }
  const res = await setReportExclusion(
    ctx,
    cmd.action === "EXCLUDE" ? { transactionIds: ids, excluded: true, reason: cmd.reason, ...(cmd.party ? { party: cmd.party } : {}) } : { transactionIds: ids, excluded: false },
    { reason: cmd.action === "EXCLUDE" ? "Desconsiderado via WhatsApp (saldo e fatura não mudam)" : "Voltou a ser considerado via WhatsApp" },
  );
  if (!res.updated) {
    const why = res.skipped[0]?.reason ?? "Nada a alterar.";
    return { status: "PROCESSED", intent: "REPORT_EXCLUSION", replies: [why], transactionIds: [], detail: "nada alterado" };
  }
  const items = res.items.map((t) => `• ${t.description} — ${formatBRL(t.amountCents)} (${relativeDate(t.date, hc.today)})`).join("\n");
  if (cmd.action === "INCLUDE") {
    return {
      status: "PROCESSED",
      intent: "REPORT_EXCLUSION",
      replies: [`↩️ Voltou a contar nos relatórios:\n${items}`],
      transactionIds: res.items.map((t) => t.id),
    };
  }
  const label = EXCLUSION_REASON_LABELS[cmd.reason].toLowerCase();
  const party = res.items.find((t) => t.exclusion?.party)?.exclusion?.party ?? cmd.party ?? null;
  const balance = cmd.reason === "CLIENT_PASSTHROUGH" ? await partyBalanceLine(ctx, party) : null;
  return {
    status: "PROCESSED",
    intent: "REPORT_EXCLUSION",
    replies: [
      [
        `🚫 Desconsiderado nos relatórios (${label}${party ? ` · ${party}` : ""}):`,
        items,
        "O saldo da conta e a fatura do cartão não mudam.",
        ...(balance ? [balance] : []),
        "Para voltar, responda *considerar de novo*.",
      ].join("\n"),
    ],
    transactionIds: res.items.map((t) => t.id),
  };
}

/**
 * Executa o comando: alvo pela mensagem citada, pelo texto (cliente/descrição/valor) ou pelo último
 * lançamento de quem escreveu. Vários candidatos → pergunta com números (ou *todos*).
 */
export async function handleExclusionCommand(
  ctx: ServiceContext,
  hc: HouseholdContext,
  cmd: ExclusionCommand,
  opts: { channel: "WHATSAPP" | "DASHBOARD"; chatId: string; messageId?: string | null; quoted?: QuotedRef | null },
): Promise<ExclusionOutcome> {
  let candidates: Candidate[] = [];
  // Citou a mensagem do lançamento: vale para os lançamentos dela (até 5), sem perguntar.
  let fromQuote = false;
  if (opts.quoted) {
    const quoted = await fromQuoted(ctx, opts.quoted);
    if (quoted && quoted.length) {
      candidates = cmd.action === "INCLUDE" ? quoted.filter((c) => c.excludedFromReports) : quoted;
      fromQuote = candidates.length > 0;
    }
  }
  if (!candidates.length) candidates = await searchCandidates(ctx, cmd, hc);
  if (cmd.action === "BUSINESS" || cmd.action === "PERSONAL") {
    const want = cmd.action === "BUSINESS" ? "BUSINESS" : "PERSONAL";
    const pending = candidates.filter((c) => c.excludedFromReports || c.scope !== want || c.natureReview);
    if (candidates.length && !pending.length) {
      return { status: "PROCESSED", intent: "REPORT_EXCLUSION", replies: [`Já está como ${want === "BUSINESS" ? "Empresa" : "Pessoal"}: ${candidates.map((c) => line(c, hc)).join("; ")}.`], transactionIds: [] };
    }
    candidates = pending;
  }
  if (cmd.action === "EXCLUDE") {
    // Já desconsiderado com o mesmo cliente não precisa de nova marcação.
    const pending = candidates.filter((c) => !c.excludedFromReports || (cmd.party && c.exclusionParty !== cmd.party));
    if (candidates.length && !pending.length) {
      return { status: "PROCESSED", intent: "REPORT_EXCLUSION", replies: [`Já está desconsiderado nos relatórios: ${candidates.map((c) => line(c, hc)).join("; ")}.`], transactionIds: [] };
    }
    candidates = pending;
  }
  if (!candidates.length) {
    const what = cmd.action === "INCLUDE" ? "desconsiderado" : "recente";
    return {
      status: "PROCESSED",
      intent: "REPORT_EXCLUSION",
      replies: [
        `Não encontrei um lançamento ${what}${cmd.party ? ` de ${cmd.party}` : ""}. Responda (citando) a mensagem do lançamento com *desconsidera esse*, ou use o painel (Lançamentos → Desconsiderar).`,
      ],
      transactionIds: [],
    };
  }
  if (candidates.length === 1 || (fromQuote && candidates.length <= 5)) return applyExclusion(ctx, hc, cmd, candidates.map((c) => c.id));

  const shown = candidates.slice(0, 6);
  const question = [
    `Encontrei ${candidates.length} lançamentos${cmd.party ? ` de ${cmd.party}` : ""}. Qual você quer ${
      cmd.action === "INCLUDE" ? "voltar a considerar" : cmd.action === "BUSINESS" ? "marcar como Empresa" : cmd.action === "PERSONAL" ? "marcar como Pessoal" : "desconsiderar"
    }?`,
    ...shown.map((c, i) => `${i + 1}. ${line(c, hc)}`),
    `Responda com o número${shown.length > 1 ? " ou *todos*" : ""}.`,
  ].join("\n");
  await openClarification({
    householdId: ctx.householdId,
    memberId: hc.sender?.memberId ?? null,
    channel: opts.channel,
    chatId: opts.chatId,
    messageId: opts.messageId,
    kind: "CHOOSE_TRANSACTION",
    question,
    payload: { action: "report-exclusion", candidates: shown.map((c) => c.id), exclusion: { action: cmd.action, reason: cmd.reason, party: cmd.party } } as Prisma.InputJsonValue,
  });
  return { status: "NEEDS_CLARIFICATION", intent: "REPORT_EXCLUSION", replies: [question], transactionIds: [] };
}

/** Resposta à pergunta "qual?" (número ou *todos*). null = não é resposta. */
export async function answerExclusionChoice(
  ctx: ServiceContext,
  hc: HouseholdContext,
  open: { id: string; payload: unknown },
  norm: string,
): Promise<ExclusionOutcome | null> {
  const payload = open.payload as { candidates?: string[]; exclusion?: { action: ExclusionCommand["action"]; reason: ReportExclusionReason; party: string | null } };
  const candidates = payload.candidates ?? [];
  const cmd = payload.exclusion;
  if (!cmd || !candidates.length) return null;
  let ids: string[] = [];
  if (/^(todos|todas|tudo|todos eles|todas elas)\b/.test(norm)) ids = candidates;
  else {
    const m = /^(\d{1,2})\b|\b(primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa]|sext[oa])\b/.exec(norm);
    if (!m) return null;
    const ord = m[1] ? Number(m[1]) : ["primeir", "segund", "terceir", "quart", "quint", "sext"].findIndex((p) => m[2]!.startsWith(p)) + 1;
    const id = candidates[ord - 1];
    if (!id) return { status: "NEEDS_CLARIFICATION", intent: "REPORT_EXCLUSION", replies: [`Escolha um número entre 1 e ${candidates.length}${candidates.length > 1 ? " ou *todos*" : ""}.`], transactionIds: [] };
    ids = [id];
  }
  await closeClarification(open.id);
  return applyExclusion(ctx, hc, cmd, ids);
}
