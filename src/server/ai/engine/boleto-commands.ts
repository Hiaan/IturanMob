import type { Clarification } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { can } from "../../auth/permissions";
import { env } from "../../env";
import { AppError } from "../../errors";
import { boletoLabel, findBoletoInText, formatDigitableLine, parseBoleto, isBoleto, type ParsedBoleto } from "@/lib/boleto";
import { addDays, formatDateBR, todayISO, type ISODate } from "@/lib/dates";
import { formatBRL } from "@/lib/money";
import { createBillFromBoleto, markPaid } from "../../modules/bills/service";
import { cleanBeneficiary, type BoletoHints } from "../../modules/bills/boleto-reader";
import { closeClarification, openClarification } from "./clarifications";
import { normalizeForNlu } from "../nlu/text";
import { extractAmounts } from "../nlu/numbers";
import type { ActionOutcome } from "./actions";

/**
 * Boleto pelo WhatsApp (código colado, PDF ou foto) → conta a pagar com lembrete.
 * Valor e vencimento vêm do código, conferido pelos dígitos verificadores. O que o código não traz
 * (vencimento das contas de consumo) é perguntado — a data impressa no documento só é usada se a
 * pessoa confirmar. O mesmo boleto nunca é cadastrado duas vezes.
 */

export type BoletoOrigin = "TEXT" | "PDF" | "IMAGE";

interface BoletoPayload {
  action: "boleto";
  line: string;
  description: string;
  amountCents: number | null;
  /** Valor sugerido pelo documento (precisa de confirmação). */
  suggestedAmountCents: number | null;
  dueDate: ISODate | null;
  /** Vencimento impresso no documento (precisa de confirmação). */
  suggestedDueDate: ISODate | null;
}

const PAID_WORDS = /\b(paguei|pago|paga|quitei|quitado|foi pago|ja paguei)\b/;
const YES = /^(sim|s|isso|pode|ok|okay|confirmo|confirma|certo|correto|beleza|blz|👍)\b/;
const NO = /^(nao|n|cancela|cancelar|deixa|esquece|descarta)\b/;

function billsLink() {
  return `${env().APP_URL.replace(/\/$/, "")}/contas-a-pagar`;
}

function summary(desc: string, amountCents: number, dueDate: ISODate, today: ISODate): string {
  const when = dueDate < today ? `venceu em ${formatDateBR(dueDate)}` : dueDate === today ? "vence hoje" : `vence em ${formatDateBR(dueDate)}`;
  return `*${desc}* — ${formatBRL(amountCents)} — ${when}`;
}

const FILLER = /^(?:(?:pagar|paga|pague|cadastra|cadastrar|cadastre|registra|registrar|anota|anotar|lembra|lembrar|lembrete|de|do|da|o|a|esse|este|essa|esta|aqui|segue|boleto|codigo|linha digitavel)\b[\s:,-]*)+/i;

/** "boleto da escola 3419..." → "Escola"; sem texto útil → null. */
export function descriptionFromCaption(caption: string): string | null {
  const rest = caption.replace(/\d[\d.\s-]{30,}\d/g, " ").replace(/\s+/g, " ").trim();
  const plain = rest.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const m = FILLER.exec(plain);
  const cut = m ? rest.slice(m[0].length) : rest;
  const clean = cleanBeneficiary(cut.replace(/[.!?]+$/, ""));
  if (!clean || clean.length > 60 || PAID_WORDS.test(normalizeForNlu(clean))) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Data de vencimento dita na resposta ("15/11", "15/11/2026", "dia 15"): sempre hoje ou depois (até ~2 meses atrás). */
export function parseDueDateAnswer(text: string, today: ISODate): ISODate | null {
  const t = normalizeForNlu(text);
  const full = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  const dayOnly = full ? null : /\bdia (\d{1,2})\b/.exec(t);
  if (!full && !dayOnly) return null;
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const day = Number(full ? full[1] : dayOnly![1]);
  const make = (y: number, m: number) => {
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const ok = !Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) && new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso;
    return ok ? iso : null;
  };
  if (full) {
    const m = Number(full[2]);
    if (full[3]) return make(full[3].length === 2 ? 2000 + Number(full[3]) : Number(full[3]), m);
    const iso = make(ty, m);
    return iso && iso < addDays(today, -60) ? make(ty + 1, m) : iso;
  }
  const iso = make(ty, tm);
  return iso && iso < today ? make(tm === 12 ? ty + 1 : ty, tm === 12 ? 1 : tm + 1) : iso;
}

async function createAndReply(ctx: ServiceContext, p: { line: string; description: string; amountCents: number; dueDate: ISODate }, origin: BoletoOrigin | "ANSWER"): Promise<ActionOutcome> {
  const today = todayISO(ctx.timezone);
  try {
    const { bill, duplicate } = await createBillFromBoleto(ctx, { line: p.line, description: p.description, amountCents: p.amountCents, dueDate: p.dueDate });
    if (duplicate) {
      const paid = bill.status === "PAID" || bill.status === "POSTED";
      return {
        status: "PROCESSED",
        intent: "BOLETO_DUPLICATE",
        replies: [`🧾 Este boleto já está nas contas a pagar: ${summary(bill.description, bill.amountCents, bill.dueDate, today)}${paid ? " (já marcado como pago)" : ""}. Nada foi duplicado.`],
        transactionIds: [],
        detail: `boleto repetido (conta ${bill.id})`,
      };
    }
    const lines = [
      `🧾 Boleto cadastrado nas contas a pagar: ${summary(bill.description, bill.amountCents, bill.dueDate, today)}.`,
      bill.dueDate >= today ? "Vou avisar perto do vencimento. Quando pagar, responda *paguei* com o código ou marque como paga no app." : "Ele já está vencido: marque como paga no app quando pagar.",
      `Código para pagar:\n${formatDigitableLine(p.line)}`,
      `Ver contas: ${billsLink()}`,
    ];
    return { status: "PROCESSED", intent: "BOLETO_BILL", replies: [lines.join("\n")], transactionIds: [], detail: `boleto (${origin}) → conta ${bill.id}` };
  } catch (err) {
    if (err instanceof AppError) return { status: "PROCESSED", intent: "BOLETO_BILL", replies: [`🧾 ${err.message}`], transactionIds: [], detail: err.message };
    throw err;
  }
}

/** Pergunta o que falta (valor ou vencimento) ou cadastra direto quando o código traz tudo. */
async function askOrCreate(ctx: ServiceContext, payload: BoletoPayload, opts: { chatId: string; messageId: string | null; origin: BoletoOrigin | "ANSWER" }): Promise<ActionOutcome> {
  if (payload.amountCents && payload.dueDate) {
    return createAndReply(ctx, { line: payload.line, description: payload.description, amountCents: payload.amountCents, dueDate: payload.dueDate }, opts.origin);
  }
  const head = `🧾 Li o boleto *${payload.description}*${payload.amountCents ? ` de ${formatBRL(payload.amountCents)}` : ""}.`;
  let question: string;
  if (!payload.amountCents) {
    question = payload.suggestedAmountCents
      ? `O código não traz o valor; no documento aparece ${formatBRL(payload.suggestedAmountCents)}. Responda *sim* para usar esse valor ou mande o valor certo.`
      : "O código não traz o valor. Qual é o valor? (ex.: 189,90)";
  } else {
    question = payload.suggestedDueDate
      ? `O código não traz o vencimento; no documento aparece ${formatDateBR(payload.suggestedDueDate)}. Responda *sim* para usar essa data ou mande a data certa (ex.: 15/11).`
      : "O código não traz o vencimento. Qual é a data de vencimento? (ex.: 15/11)";
  }
  const text = `${head}\n${question}\nPara não cadastrar, responda *cancelar*.`;
  await openClarification({
    householdId: ctx.householdId,
    memberId: ctx.memberId,
    channel: "WHATSAPP",
    chatId: opts.chatId,
    messageId: opts.messageId,
    kind: "MISSING_FIELDS",
    question: text,
    payload: { ...payload },
  });
  return { status: "NEEDS_CLARIFICATION", intent: "BOLETO_BILL", replies: [text], transactionIds: [], detail: "boleto aguardando dado" };
}

/**
 * Boleto lido (texto, PDF ou foto) → conta a pagar. `hints` são dados impressos no documento,
 * usados só como sugestão ou descrição.
 */
export async function registerBoleto(
  ctx: ServiceContext,
  boleto: ParsedBoleto,
  hints: Partial<BoletoHints>,
  opts: { chatId: string; messageId: string | null; origin: BoletoOrigin; caption?: string },
): Promise<ActionOutcome> {
  if (!can(ctx.role, "bills:write")) {
    return { status: "IGNORED", intent: "BOLETO_BILL", replies: ["🧾 Seu perfil não pode cadastrar contas a pagar. Peça a um administrador da família."], transactionIds: [], detail: "sem permissão" };
  }
  const today = todayISO(ctx.timezone);
  const existing = await prisma.scheduledPayment.findUnique({
    where: { householdId_boletoLine: { householdId: ctx.householdId, boletoLine: boleto.digitableLine } },
    select: { id: true },
  });
  const norm = normalizeForNlu(opts.caption ?? "");
  if (existing && PAID_WORDS.test(norm)) {
    try {
      const { bill } = await markPaid(ctx, existing.id, {});
      return { status: "PROCESSED", intent: "BOLETO_PAID", replies: [`✅ Conta marcada como paga: *${bill.description}* — ${formatBRL(bill.paidAmountCents ?? bill.amountCents)}.`], transactionIds: bill.transaction ? [bill.transaction.id] : [] };
    } catch (err) {
      if (err instanceof AppError) return { status: "PROCESSED", intent: "BOLETO_PAID", replies: [`🧾 ${err.message}`], transactionIds: [] };
      throw err;
    }
  }
  if (!existing && PAID_WORDS.test(norm)) {
    return {
      status: "PROCESSED",
      intent: "BOLETO_PAID",
      replies: [`🧾 Esse boleto não está nas contas a pagar, então não marquei nada. Para registrar o gasto, mande o valor e o que foi (ex.: "paguei ${boleto.amountCents ? formatBRL(boleto.amountCents) : "120,00"} de internet").`],
      transactionIds: [],
    };
  }
  const captionDesc = descriptionFromCaption(opts.caption ?? "");
  const payload: BoletoPayload = {
    action: "boleto",
    line: boleto.digitableLine,
    description: captionDesc ?? cleanBeneficiary(hints.beneficiary) ?? boletoLabel(boleto),
    amountCents: boleto.amountCents,
    suggestedAmountCents: boleto.amountCents ? null : hints.amountCents ?? null,
    dueDate: boleto.dueDate,
    suggestedDueDate: boleto.dueDate ? null : hints.dueDate && hints.dueDate >= addDays(today, -60) ? hints.dueDate : null,
  };
  return askOrCreate(ctx, payload, { chatId: opts.chatId, messageId: opts.messageId, origin: opts.origin });
}

/** Mensagem de texto com uma linha digitável válida → conta a pagar. */
export async function handleBoletoText(ctx: ServiceContext, text: string, opts: { chatId: string; messageId: string | null }): Promise<ActionOutcome | null> {
  const boleto = findBoletoInText(text, todayISO(ctx.timezone));
  if (!boleto) return null;
  return registerBoleto(ctx, boleto, {}, { ...opts, origin: "TEXT", caption: text });
}

/** Resposta à pergunta do boleto (valor ou vencimento). */
export async function answerBoletoClarification(ctx: ServiceContext, open: Clarification, text: string): Promise<ActionOutcome | null> {
  const payload = open.payload as unknown as BoletoPayload;
  const norm = normalizeForNlu(text);
  const today = todayISO(ctx.timezone);
  if (NO.test(norm)) {
    await closeClarification(open.id, "CANCELLED");
    return { status: "PROCESSED", intent: "REJECTION", replies: ["Ok, o boleto não foi cadastrado."], transactionIds: [] };
  }
  // Segurança: o código guardado na pergunta é conferido de novo.
  const boleto = parseBoleto(payload.line, today);
  if (!isBoleto(boleto)) {
    await closeClarification(open.id, "CANCELLED");
    return null;
  }
  const next = { ...payload };
  if (!next.amountCents) {
    const amounts = extractAmounts(text);
    if (amounts.length === 1) next.amountCents = amounts[0]!.cents;
    else if (YES.test(norm) && next.suggestedAmountCents) next.amountCents = next.suggestedAmountCents;
    else return { status: "NEEDS_CLARIFICATION", intent: "BOLETO_BILL", replies: ["Não entendi o valor. Mande só o valor (ex.: 189,90) ou *cancelar*."], transactionIds: [] };
  } else if (!next.dueDate) {
    const date = parseDueDateAnswer(text, today);
    if (date) next.dueDate = date;
    else if (YES.test(norm) && next.suggestedDueDate) next.dueDate = next.suggestedDueDate;
    else return { status: "NEEDS_CLARIFICATION", intent: "BOLETO_BILL", replies: ["Não entendi a data. Mande o vencimento (ex.: 15/11) ou *cancelar*."], transactionIds: [] };
  }
  await closeClarification(open.id);
  return askOrCreate(ctx, next, { chatId: open.chatId, messageId: open.messageId, origin: "ANSWER" });
}
