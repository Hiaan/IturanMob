import type { Attachment, Clarification } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { can } from "../../auth/permissions";
import { env } from "../../env";
import { AppError, ValidationError } from "../../errors";
import { logger } from "../../logger";
import { readStoredFile } from "../../storage";
import { formatBRL } from "@/lib/money";
import { formatDateBR } from "@/lib/dates";
import { bulkCommitImports, createImportPreviewFromBuffer, findBatchByOriginMessage, getImportPreview, listWhatsAppPreviews } from "../../modules/imports/service";
import { closeClarification, CLARIFICATION_TTL_MS, openClarification } from "./clarifications";
import { loadHouseholdContext } from "./context";
import type { ActionOutcome } from "./actions";
import { findMentions } from "../nlu/local-parser";
import { normalizeForNlu } from "../nlu/text";

/**
 * Extrato/fatura em PDF enviado no WhatsApp → prévia de importação (a mesma do site) → resumo na
 * conversa → "confirmar" importa. Nada é gravado sem a confirmação de quem enviou. Vários PDFs
 * enviados em sequência ficam numa confirmação só ("confirmar" importa todos, sem duplicar).
 * Quando a conta/cartão não é identificada com segurança, a confirmação é feita no site.
 */

type Fail = (title: string, description: string, reply: string) => Promise<ActionOutcome>;

const CONFIRM = /^(sim|s|confirm\w*|importa\w*|pode|pode importar|ok|okay|isso|manda|bora|👍)\b/;
const CANCEL = /^(nao|n|cancel\w*|descart\w*|nada|deixa)\b/;

function importLink(batchId?: string) {
  return `${env().APP_URL.replace(/\/$/, "")}/importacao${batchId ? `?batch=${batchId}` : ""}`;
}

export function isPdfAttachment(att: Pick<Attachment, "mimeType" | "originalName">): boolean {
  return att.mimeType === "application/pdf" || /\.pdf$/i.test(att.originalName ?? "");
}

/** Conta ou cartão citado na legenda ("fatura do cartão nubank", "extrato itaú"). */
async function scopeFromCaption(ctx: ServiceContext, caption: string): Promise<{ accountId?: string; creditCardId?: string }> {
  const norm = normalizeForNlu(caption);
  if (!norm) return {};
  const hc = await loadHouseholdContext(ctx, ctx.memberId);
  const wantsCard = /\b(cartao|fatura|credito)\b/.test(norm);
  const wantsAccount = /\b(conta|extrato|corrente|poupanca)\b/.test(norm);
  const cards = wantsAccount && !wantsCard ? [] : findMentions(norm, hc.cards);
  const accounts = wantsCard ? [] : findMentions(norm, hc.accounts);
  if (cards.length === 1 && (!accounts.length || wantsCard)) return { creditCardId: cards[0]!.id };
  if (accounts.length === 1 && !cards.length) return { accountId: accounts[0]!.id };
  return {};
}

/** Retorna null quando o PDF é um comprovante (segue o fluxo de comprovantes). */
export async function processPdfStatement(
  ctx: ServiceContext,
  message: { id: string; chatId: string },
  att: Attachment,
  caption: string,
  fail: Fail,
  /** PDF enviado no grupo da empresa (ou com legenda "empresa"): linhas sem regra vêm como Empresa. */
  opts: { defaultNature?: "BUSINESS" | null } = {},
): Promise<ActionOutcome | null> {
  if (!can(ctx.role, "data:import")) {
    return { status: "IGNORED", intent: "PDF_STATEMENT", replies: ["Seu perfil não pode importar extratos. Peça a um administrador da família."], transactionIds: [], detail: "sem permissão de importação" };
  }
  const existing = await findBatchByOriginMessage(ctx, message.id);
  if (existing && existing.status !== "PREVIEW") {
    return { status: "PROCESSED", intent: "PDF_STATEMENT", replies: [`📄 Este PDF já foi processado (importação ${existing.status === "IMPORTED" ? "concluída" : "desfeita"}). Veja em: ${importLink(existing.id)}`], transactionIds: [] };
  }
  let preview: Awaited<ReturnType<typeof createImportPreviewFromBuffer>>;
  try {
    preview = existing ? await getImportPreview(ctx, existing.id) : await createImportPreviewFromBuffer(ctx, {
      fileName: att.originalName?.trim() || "extrato.pdf",
      content: await readStoredFile(att.storageKey!),
      format: "PDF",
      messageId: message.id,
      origin: { channel: "WHATSAPP", chatId: message.chatId, messageId: message.id },
      defaultNature: opts.defaultNature ?? null,
      ...(await scopeFromCaption(ctx, caption)),
    });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    const reason = (err.details as { reason?: string } | undefined)?.reason;
    if (reason === "PDF_RECEIPT") return null;
    await prisma.attachment.update({ where: { id: att.id }, data: { processingStatus: "UNREADABLE" } });
    if (reason === "PDF_PASSWORD") {
      return { status: "PROCESSED", intent: "PDF_PASSWORD", replies: [`🔒 ${err.message}`], transactionIds: [], detail: "PDF com senha" };
    }
    return fail("Extrato em PDF não lido", err.message, `📄 ${err.message}`);
  }

  const { batch, counts, rows } = preview;
  await prisma.attachment.update({
    where: { id: att.id },
    data: { processingStatus: "EXTRACTED", extractedData: { importBatchId: batch.id, rows: counts.total } },
  });
  const isCard = Boolean(batch.creditCard);
  const st = batch.statement;
  const lines: string[] = [];
  const period = st?.startDate && st.endDate ? ` (${formatDateBR(st.startDate)} a ${formatDateBR(st.endDate)})` : "";
  const what = st?.kind === "CREDIT_CARD" || isCard ? "a fatura" : "o extrato";
  lines.push(`📄 Li ${what}${st?.bank ? ` do *${st.bank}*` : ""}${period}${st?.source === "AI" ? " com ajuda da IA (PDF sem texto)" : ""}.`);
  const dest = batch.creditCard ? `cartão *${batch.creditCard.name}*` : batch.account ? `conta *${batch.account.name}*` : null;
  if (dest) lines.push(`Destino: ${dest}${batch.warnings.some((w) => w.includes("automaticamente pelo banco do PDF")) ? " (identificado pelo banco do PDF)" : ""}.`);

  const fresh = rows.filter((r) => r.selected && r.status === "NEW");
  const cardPayments = fresh.filter((r) => r.kind === "CARD_PAYMENT");
  const transfers = fresh.filter((r) => r.kind === "TRANSFER");
  const regular = fresh.filter((r) => r.kind !== "CARD_PAYMENT" && r.kind !== "TRANSFER");
  const inflow = regular.filter((r) => (r.amountCents ?? 0) > 0).reduce((s, r) => s + (r.amountCents ?? 0), 0);
  const outflow = regular.filter((r) => (r.amountCents ?? 0) < 0).reduce((s, r) => s - (r.amountCents ?? 0), 0);
  if (regular.length) {
    const money = isCard ? `compras ${formatBRL(outflow)}` : [inflow ? `entradas ${formatBRL(inflow)}` : null, outflow ? `saídas ${formatBRL(outflow)}` : null].filter(Boolean).join(" · ");
    lines.push(`• ${regular.length} lançamento(s) novo(s): ${money}`);
  }
  if (cardPayments.length) lines.push(`• ${cardPayments.length} pagamento(s) de fatura de cartão (não contam como despesa)`);
  if (transfers.length) lines.push(`• ${transfers.length} aplicação(ões)/resgate(s) ou transferência(s) entre contas próprias (não contam como receita nem despesa)`);
  const unresolvedTransfers = rows.filter((r) => !r.selected && r.status === "NEW" && r.kind === "TRANSFER" && !r.transfer?.accountId).length;
  const unselected = rows.filter((r) => !r.selected && r.status === "NEW").length - unresolvedTransfers;
  if (unselected) lines.push(`• ${unselected} lançamento(s) não marcado(s) para importar (ex.: parcela de compra antiga) — revise no site se quiser incluir`);
  if (unresolvedTransfers) lines.push(`• ${unresolvedTransfers} aplicação(ões)/resgate(s) sem a conta de investimento definida — escolha a conta no site para incluir`);
  if (counts.MATCHED) lines.push(`• ${counts.MATCHED} já registrado(s) no app (serão conciliados)`);
  if (counts.DIVERGENT) lines.push(`• ${counts.DIVERGENT} com valor diferente do app (viram pendência para conferir)`);
  if (counts.DUPLICATE) lines.push(`• ${counts.DUPLICATE} repetido(s) de importações anteriores (ignorados)`);
  if (counts.SKIPPED) lines.push(`• ${counts.SKIPPED} linha(s) ignorada(s) (pagamentos/créditos da fatura, valores zerados)`);
  const notes = batch.warnings.filter((w) => /deduzida pela descrição|lidos pela IA|também aparecem em/.test(w));
  for (const n of notes) lines.push(`⚠️ ${n}`);

  const pending = await listWhatsAppPreviews(ctx, message.chatId, CLARIFICATION_TTL_MS);
  const current = pending.find((p) => p.id === batch.id);
  const ready = pending.filter((p) => p.ready);

  if (!current?.ready) {
    const why = !dest
      ? "Não consegui identificar com segurança a conta ou o cartão deste PDF"
      : "O tipo do documento não bate com o destino identificado (extrato × fatura)";
    lines.push(`\n${why}. Escolha o destino e confirme pelo site: ${importLink(batch.id)}`);
    if (!ready.length) return { status: "NEEDS_CLARIFICATION", intent: "PDF_STATEMENT", replies: [lines.join("\n")], transactionIds: [], detail: `prévia ${batch.id} aguardando revisão no site` };
  } else if (!fresh.length && !counts.MATCHED && !counts.DIVERGENT) {
    lines.push("\nNada novo para importar: tudo já está no app.");
    if (ready.length <= 1) return { status: "PROCESSED", intent: "PDF_STATEMENT", replies: [lines.join("\n")], transactionIds: [], detail: `prévia ${batch.id} sem novidades` };
  }

  const others = ready.filter((p) => p.id !== batch.id).length;
  if (!current?.ready) {
    lines.push(`Os outros ${others} arquivo(s) enviados antes continuam aguardando: responda *confirmar* para importá-los ou *cancelar*.`);
  } else if (ready.length > 1) {
    lines.push(`\nHá *${ready.length} arquivos* aguardando. Responda *confirmar* para importar todos (o que se repete entre eles entra uma vez só) ou *cancelar*. Para revisar: ${importLink()}`);
  } else if (isCard && preview.review.purchases) {
    // Fatura: antes de confirmar, conferir compras que não são suas (cartão emprestado, cobrança errada).
    lines.push(`\n👀 Confira se há compras que não são suas antes de confirmar: ${importLink(batch.id)}`);
    lines.push("Responda *confirmar* para importar ou *cancelar*.");
  } else {
    lines.push(`\nResponda *confirmar* para importar ou *cancelar*. Para revisar linha a linha: ${importLink(batch.id)}`);
  }
  await openClarification({
    householdId: ctx.householdId,
    memberId: ctx.memberId,
    channel: "WHATSAPP",
    chatId: message.chatId,
    messageId: message.id,
    kind: "CONFIRM_IMPORT",
    question: ready.length > 1 ? `Importar ${ready.length} arquivos?` : `Importar ${batch.fileName}?`,
    payload: { batchIds: ready.map((p) => p.id) },
  });
  return { status: "NEEDS_CLARIFICATION", intent: "PDF_STATEMENT", replies: [lines.join("\n")], transactionIds: [], detail: `prévia ${batch.id}${others ? ` (+${others} na fila)` : ""}` };
}

/** "confirmar" / "confirmar importação" sem a pergunta aberta (outra pergunta a substituiu). */
export const EXPLICIT_IMPORT_CONFIRM = /^confirm(ar|o|a)( (a |as |os )?(importacao|importacoes|tudo|todos|extratos?|faturas?|arquivos?|pdfs?))*$/;

/** Resposta à pergunta "confirmar a importação?". Outras mensagens seguem o fluxo normal. */
export async function answerImportConfirmation(ctx: ServiceContext, chatId: string, text: string, open: Clarification | null): Promise<ActionOutcome | null> {
  const norm = normalizeForNlu(text);
  if (open && CANCEL.test(norm) && norm.split(" ").length <= 4) {
    await closeClarification(open.id, "CANCELLED");
    return { status: "PROCESSED", intent: "IMPORT_CANCELLED", replies: [`Ok, não importei nada. As prévias continuam no site, se quiser revisar: ${importLink()}`], transactionIds: [] };
  }
  if (!CONFIRM.test(norm) || norm.split(" ").length > 4) return null;

  // As prévias são buscadas de novo: arquivos processados em paralelo entram na mesma confirmação.
  const listed = ((open?.payload as { batchIds?: string[] } | undefined)?.batchIds ?? []) as string[];
  const pending = await listWhatsAppPreviews(ctx, chatId, CLARIFICATION_TTL_MS * 2);
  const ids = [...new Set([...listed.filter((id) => pending.some((p) => p.id === id && p.ready)), ...pending.filter((p) => p.ready).map((p) => p.id)])];
  if (open) await closeClarification(open.id);
  else if (!ids.length) return null;
  if (!ids.length) return { status: "PROCESSED", intent: "IMPORT_CONFIRMED", replies: [`Não há mais nada aguardando confirmação. Veja as importações no site: ${importLink()}`], transactionIds: [] };

  let res: Awaited<ReturnType<typeof bulkCommitImports>>;
  try {
    res = await bulkCommitImports(ctx, { batchIds: ids.slice(0, 20) });
  } catch (err) {
    if (err instanceof AppError) return { status: "PROCESSED", intent: "IMPORT_CONFIRMED", replies: [`Não consegui importar: ${err.message}`], transactionIds: [] };
    throw err;
  }
  logger.info({ householdId: ctx.householdId, files: res.totals.files, created: res.totals.created }, "whatsapp: importação confirmada pela conversa");
  const t = res.totals;
  const lines = [`✅ Importação concluída${t.files > 1 ? ` (${t.ok} de ${t.files} arquivos)` : ""}: ${t.created} lançamento(s) novo(s).`];
  if (t.matched) lines.push(`• ${t.matched} conciliado(s) com o que já estava no app`);
  if (t.duplicatesAtCommit) lines.push(`• ${t.duplicatesAtCommit} repetido(s) entre os arquivos (entraram uma vez só)`);
  if (t.divergent) lines.push(`• ${t.divergent} com valor diferente: veja em Pendências`);
  if (t.errors) lines.push(`• ${t.errors} linha(s) com erro: revise no site`);
  for (const r of res.results.filter((x) => !x.ok)) lines.push(`⚠️ ${r.fileName || "Arquivo"}: ${r.error}`);
  lines.push(`Para desfazer ou revisar: ${importLink()}`);
  return { status: "PROCESSED", intent: "IMPORT_CONFIRMED", replies: [lines.join("\n")], transactionIds: [] };
}
