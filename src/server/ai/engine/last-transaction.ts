import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { normalizeText } from "@/lib/utils";
import { normalizeForNlu } from "../nlu/text";
import type { LastTxCommand } from "../nlu/last-tx";
import { soundsAlike } from "../transcription/fixes";
import { restoreTransaction } from "../../modules/transactions/service";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { applyCorrection, applyDescription, deleteOne, type ActionOutcome } from "./actions";
import { openClarification } from "./clarifications";
import type { HouseholdContext } from "./context";
import type { RecentTx } from "./interpret";
import type { RawCorrection } from "./schemas";

/**
 * Executa os comandos sobre o último lançamento ("cancela", "é refrigerante", "foram 15"…).
 * Alvo: os lançamentos da mensagem citada; sem citação, o último lançamento de quem escreveu, neste
 * grupo, nos últimos 15 minutos. Fora disso (ou com mais de um candidato), pergunta qual, com os 3
 * últimos. Correções sem marca explícita ("é Y", "foram 15", "no crédito") só valem dentro da janela
 * ou citando — senão a mensagem segue o fluxo normal.
 */

export const LAST_TX_WINDOW_MS = 15 * 60_000;

export interface LastTxOptions {
  channel: "WHATSAPP";
  chatId: string;
  messageId: string | null;
  quoted: { connectionId: string; externalId: string } | null;
}

const TX_FIELDS = { id: true, description: true, amountCents: true, date: true, type: true, createdByMemberId: true, createdAt: true, sourceMessageId: true, sourceIndex: true } as const;
type TxRow = Prisma.TransactionGetPayload<{ select: typeof TX_FIELDS }>;

function asRecent(rows: TxRow[]): RecentTx[] {
  return rows.map((r, i) => ({
    index: i + 1,
    id: r.id,
    description: r.description,
    amountCents: r.amountCents,
    date: r.date.toISOString().slice(0, 10),
    type: r.type,
    createdByMemberId: r.createdByMemberId,
    categoryName: null,
    merchantName: null,
    createdAt: r.createdAt,
  }));
}

/** Lançamentos da mensagem citada (a do lançamento ou a confirmação do robô, que cita a original). */
async function quotedTransactions(ctx: ServiceContext, quoted: NonNullable<LastTxOptions["quoted"]>): Promise<TxRow[] | null> {
  let msg = await prisma.whatsAppMessage.findUnique({
    where: { connectionId_externalId: { connectionId: quoted.connectionId, externalId: quoted.externalId } },
    select: { id: true, householdId: true, direction: true, quotedExternalId: true, connectionId: true },
  });
  if (!msg || msg.householdId !== ctx.householdId) return null;
  if (msg.direction === "OUTBOUND" && msg.quotedExternalId) {
    msg = await prisma.whatsAppMessage.findUnique({
      where: { connectionId_externalId: { connectionId: msg.connectionId, externalId: msg.quotedExternalId } },
      select: { id: true, householdId: true, direction: true, quotedExternalId: true, connectionId: true },
    });
    if (!msg || msg.householdId !== ctx.householdId) return null;
  }
  const rows = await prisma.transaction.findMany({ where: { householdId: ctx.householdId, sourceMessageId: msg.id, deletedAt: null }, orderBy: { sourceIndex: "asc" }, select: TX_FIELDS });
  return rows.length ? rows : null;
}

/** Último lançamento de quem escreveu, neste grupo, na janela (e os outros da mesma mensagem). */
async function lastInWindow(ctx: ServiceContext, hc: HouseholdContext, chatId: string): Promise<TxRow[] | null> {
  const memberId = hc.sender?.memberId;
  if (!memberId) return null;
  const last = await prisma.transaction.findFirst({
    where: { householdId: ctx.householdId, createdByMemberId: memberId, deletedAt: null, createdAt: { gte: new Date(Date.now() - LAST_TX_WINDOW_MS) }, sourceMessage: { chatId } },
    orderBy: [{ createdAt: "desc" }, { sourceIndex: "desc" }],
    select: TX_FIELDS,
  });
  if (!last) return null;
  if (!last.sourceMessageId) return [last];
  return prisma.transaction.findMany({ where: { householdId: ctx.householdId, sourceMessageId: last.sourceMessageId, deletedAt: null }, orderBy: { sourceIndex: "asc" }, select: TX_FIELDS });
}

async function lastThree(ctx: ServiceContext, hc: HouseholdContext): Promise<TxRow[]> {
  const memberId = hc.sender?.memberId;
  if (!memberId) return [];
  return prisma.transaction.findMany({
    where: { householdId: ctx.householdId, createdByMemberId: memberId, deletedAt: null, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, type: { not: "ADJUSTMENT" } },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: TX_FIELDS,
  });
}

const correction = (changes: RawCorrection["changes"]): RawCorrection => ({ targetLast: true, targetText: null, targetAmountCents: null, targetDate: null, changes });

async function ask(ctx: ServiceContext, hc: HouseholdContext, opts: LastTxOptions, rows: TxRow[], verb: string, payload: Record<string, unknown>, intent: string): Promise<ActionOutcome> {
  const lines = asRecent(rows).map((r, i) => `${i + 1}. ${r.description} — ${formatBRL(r.amountCents)} (${formatDateBR(r.date)})`);
  const question =
    rows.length === 1
      ? `É este que você quer ${verb}?\n${lines[0]}\nResponda *1* para confirmar.`
      : `Qual você quer ${verb}?\n${lines.join("\n")}\nResponda com o número.`;
  await openClarification({
    householdId: ctx.householdId,
    memberId: hc.sender?.memberId ?? null,
    channel: opts.channel,
    chatId: opts.chatId,
    messageId: opts.messageId,
    kind: "CHOOSE_TRANSACTION",
    question,
    payload: { ...payload, candidates: rows.map((r) => r.id) } as Prisma.InputJsonValue,
  });
  return { status: "NEEDS_CLARIFICATION", intent, replies: [question], transactionIds: [] };
}

/** A nova descrição é o nome de uma categoria ("é mercado")? Então é troca de categoria. */
function isCategoryName(hc: HouseholdContext, text: string): boolean {
  const n = normalizeForNlu(text);
  return hc.categories.some((c) => c.normalized === n || c.subcategories.some((s) => s.normalized === n));
}

/**
 * Executa o comando. Retorna null quando a mensagem não deve ser tratada como comando (ex.: "é Y"
 * sem lançamento recente) — o fluxo normal segue.
 */
export async function handleLastTxCommand(ctx: ServiceContext, hc: HouseholdContext, cmd: LastTxCommand, opts: LastTxOptions): Promise<ActionOutcome | null> {
  const quoted = opts.quoted ? await quotedTransactions(ctx, opts.quoted) : null;
  const recent = quoted ?? (await lastInWindow(ctx, hc, opts.chatId));
  const explicit = cmd.action === "CANCEL" || cmd.action === "UNDO" || cmd.action === "CATEGORY" || (cmd.action === "DESCRIBE" && cmd.explicit);

  if (cmd.action === "RESTORE") return restoreLast(ctx, hc);
  if (cmd.action === "UNDO") {
    // "desfaz" logo depois de apagar = voltar; sem exclusão recente = cancelar o último.
    const deleted = await prisma.transaction.findFirst({
      where: { householdId: ctx.householdId, deletedByMemberId: hc.sender?.memberId ?? "-", deletedAt: { gte: new Date(Date.now() - LAST_TX_WINDOW_MS) } },
      orderBy: { deletedAt: "desc" },
      select: { id: true, deletedAt: true },
    });
    const lastCreated = recent?.[recent.length - 1]?.createdAt ?? null;
    if (deleted && (!lastCreated || deleted.deletedAt! > lastCreated)) return restoreLast(ctx, hc);
  }

  // Sem alvo claro.
  if (!recent) {
    if (!explicit) return null;
    const rows = await lastThree(ctx, hc);
    if (!rows.length) return { status: "PROCESSED", intent: cmd.action === "CANCEL" || cmd.action === "UNDO" ? "DELETE" : "CORRECTION", replies: ["Não encontrei um lançamento seu recente."], transactionIds: [] };
    return askFor(ctx, hc, opts, cmd, rows);
  }

  // Mais de um lançamento na mesma mensagem: na descrição, o que soa como a palavra errada; senão, pergunta.
  let target = recent.length === 1 ? recent[0]! : null;
  if (!target && cmd.action === "DESCRIBE") {
    const hint = cmd.wrong;
    const alike = recent.filter((r) => (hint ? soundsAlike(r.description, hint) || normalizeText(r.description).includes(normalizeText(hint)) : soundsAlike(r.description, cmd.right)));
    if (alike.length === 1) target = alike[0]!;
  }
  if (!target) return askFor(ctx, hc, opts, cmd, recent.slice(0, 4));

  switch (cmd.action) {
    case "CANCEL":
    case "UNDO":
      return deleteOne(ctx, target.id, hc);
    case "DESCRIBE":
      if (!cmd.wrong && isCategoryName(hc, cmd.right)) return applyCorrection(ctx, correction({ categoryHint: cmd.right }), target.id, hc);
      // "é Y" sem marca de correção só vale quando soa como a descrição atual ("Revirante" ~ "refrigerante")
      // ou dentro da janela/citação (já garantido aqui).
      return applyDescription(ctx, target.id, cmd.right, hc);
    case "AMOUNT":
      return applyCorrection(ctx, correction({ amountCents: cmd.amountCents }), target.id, hc);
    case "PAYMENT":
      return applyCorrection(ctx, correction({ paymentMethod: cmd.paymentMethod, cardHint: cmd.cardHint, accountHint: cmd.accountHint }), target.id, hc);
    case "CATEGORY": {
      if (!isCategoryName(hc, cmd.hint)) {
        const out = await applyCorrection(ctx, correction({ categoryHint: cmd.hint }), target.id, hc);
        if (out.transactionIds.length) return out;
        return { status: "PROCESSED", intent: "CORRECTION", replies: [`Não tenho a categoria *${cmd.hint}*. Para criar: *cria categoria ${cmd.hint}*.`], transactionIds: [] };
      }
      return applyCorrection(ctx, correction({ categoryHint: cmd.hint }), target.id, hc);
    }
  }
}

function askFor(ctx: ServiceContext, hc: HouseholdContext, opts: LastTxOptions, cmd: LastTxCommand, rows: TxRow[]): Promise<ActionOutcome> {
  switch (cmd.action) {
    case "CANCEL":
    case "UNDO":
      return ask(ctx, hc, opts, rows, "apagar", { action: "delete" }, "DELETE");
    case "DESCRIBE":
      return ask(ctx, hc, opts, rows, "corrigir", { action: "describe", description: cmd.right }, "CORRECTION");
    case "AMOUNT":
      return ask(ctx, hc, opts, rows, "corrigir", { action: "correct", correction: correction({ amountCents: cmd.amountCents }) }, "CORRECTION");
    case "PAYMENT":
      return ask(ctx, hc, opts, rows, "corrigir", { action: "correct", correction: correction({ paymentMethod: cmd.paymentMethod, cardHint: cmd.cardHint, accountHint: cmd.accountHint }) }, "CORRECTION");
    case "CATEGORY":
      return ask(ctx, hc, opts, rows, "mudar de categoria", { action: "correct", correction: correction({ categoryHint: cmd.hint }) }, "CORRECTION");
    default:
      return ask(ctx, hc, opts, rows, "corrigir", { action: "delete" }, "CORRECTION");
  }
}

async function restoreLast(ctx: ServiceContext, hc: HouseholdContext): Promise<ActionOutcome> {
  const last = await prisma.transaction.findFirst({
    where: { householdId: ctx.householdId, deletedAt: { gte: new Date(Date.now() - 2 * 86_400_000) }, deletedByMemberId: hc.sender?.memberId ?? "-" },
    orderBy: { deletedAt: "desc" },
  });
  if (!last) return { status: "PROCESSED", intent: "RESTORE", replies: ["Não encontrei nada apagado recentemente para voltar."], transactionIds: [] };
  await restoreTransaction(ctx, last.id);
  return { status: "PROCESSED", intent: "RESTORE", replies: [`↩️ Voltei: *${last.description}* ${formatBRL(last.amountCents)}.`], transactionIds: [last.id] };
}
