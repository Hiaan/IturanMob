import type { Prisma, TransactionSource } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { can } from "../../auth/permissions";
import { decryptStringSafe, encryptString } from "../../crypto";
import { readStoredFile } from "../../storage";
import { logger, errorInfo } from "../../logger";
import { publishEvent } from "../../events";
import { formatBRL } from "@/lib/money";
import { formatDateBR, formatMonthBR, isISODate, monthKey, monthRange, todayISO } from "@/lib/dates";
import { createPendingItem } from "../../modules/pending/service";
import { loadHouseholdContext } from "../engine/context";
import { interpretText } from "../engine/interpret";
import { executeInterpretation, tryAnswerClarification, type ActionOutcome } from "../engine/actions";
import { resolveDraft } from "../engine/resolve";
import type { RawDraft } from "../engine/schemas";
import { transcribeAudio } from "../transcription";
import { familyVocabulary, type FamilyVocabulary } from "../transcription/vocabulary";
import { normalizeTranscript } from "../nlu/transcript";
import { extractReceipt } from "../vision/receipt";
import { extractAmounts } from "../nlu/numbers";
import { normalizeForNlu } from "../nlu/text";
import { detectNatureTokens } from "../nlu/nature";
import { isQuestionText } from "../nlu/local-parser";
import { expensesByCategory } from "../../modules/analytics/service";
import { answerImportConfirmation, EXPLICIT_IMPORT_CONFIRM, isPdfAttachment, processPdfStatement } from "../engine/statement-import";
import { handleCategoryCommand, parseCategoryCommand } from "../engine/category-commands";
import { applyExclusion, handleExclusionCommand, hasExclusionMarker, parseExclusionCommand, stripExclusionMarker, type QuotedRef } from "../engine/report-exclusion";
import type { InboundMessageResult } from "./types";

/**
 * Processa uma WhatsAppMessage já persistida (texto, áudio ou imagem).
 * Idempotente: lançamentos são únicos por (mensagem, posição), então reprocessar não duplica.
 * Erros transitórios (provedores, banco) retornam retryable=true; erros definitivos viram pendência.
 */
export async function handleInboundMessage(messageId: string): Promise<InboundMessageResult> {
  const message = await prisma.whatsAppMessage.findUnique({
    where: { id: messageId },
    include: { attachment: true, sender: true, household: { select: { timezone: true } } },
  });
  if (!message) return { status: "IGNORED", replies: [], transactionIds: [], detail: "mensagem não encontrada" };
  if (message.direction !== "INBOUND") return { status: "IGNORED", replies: [], transactionIds: [], detail: "mensagem de saída" };
  const member = message.sender;
  if (!member || !member.isActive) return { status: "IGNORED", replies: [], transactionIds: [], detail: "remetente não autorizado" };

  const settings = await prisma.householdSettings.findUnique({ where: { householdId: message.householdId } });
  // Grupo de origem: Empresa / Pessoa física / não atribuído. Decide a natureza dos lançamentos
  // (quando a mensagem e as regras não decidem) e o recorte das perguntas (não atribuído = Tudo).
  const group = message.groupId ? await prisma.whatsAppGroup.findUnique({ where: { id: message.groupId }, select: { defaultNature: true } }) : null;
  const groupNature = group?.defaultNature ?? null;
  const nature: GroupNature | null = !message.groupId
    ? null
    : groupNature
      ? { fallback: groupNature, unassigned: false }
      : settings?.whatsappUnassignedNature === "FAMILY_DEFAULT"
        ? { fallback: settings.defaultReportScope === "BUSINESS" ? "BUSINESS" : "PERSONAL", unassigned: true }
        : { ask: true, unassigned: true };

  const ctx: ServiceContext = {
    householdId: message.householdId,
    memberId: member.id,
    userId: member.userId,
    role: member.role === "VIEWER" && !member.userId ? "MEMBER" : member.role,
    actorType: "WHATSAPP",
    timezone: message.household.timezone,
    canViewOthersPrivate: member.canViewOthersPrivate,
    ...(message.groupId ? { reportScope: groupNature ?? "ALL" } : {}),
  };
  if (!can(ctx.role, "transactions:write")) {
    return { status: "IGNORED", replies: ["Seu acesso é somente leitura; peça a um administrador para registrar lançamentos."], transactionIds: [], detail: "sem permissão de escrita" };
  }
  const answerQueries = settings?.whatsappAnswerQueries ?? true;

  try {
    let outcome: ActionOutcome;
    if (message.type === "TEXT") {
      outcome = await processText(ctx, message.text ?? "", {
        messageId,
        chatId: message.chatId,
        source: "WHATSAPP_TEXT",
        answerQueries,
        nature,
        quoted: message.quotedExternalId ? { connectionId: message.connectionId, externalId: message.quotedExternalId } : null,
      });
    } else if (message.type === "AUDIO") {
      outcome = await processAudio(ctx, message, { answerQueries, nature }, settings?.transcriptRetentionDays ?? 365);
    } else if (message.type === "IMAGE" || message.type === "DOCUMENT") {
      outcome = await processReceipt(ctx, message, { answerQueries, nature });
    } else {
      outcome = { status: "IGNORED", intent: "UNSUPPORTED", replies: [], transactionIds: [], detail: `tipo ${message.type} não processado` };
    }
    await publishEvent(ctx.householdId, "whatsapp.message", messageId);
    return { status: outcome.status, intent: outcome.intent, replies: outcome.replies, transactionIds: outcome.transactionIds, detail: outcome.detail };
  } catch (err) {
    logger.error({ err: errorInfo(err), messageId }, "pipeline: falha ao processar mensagem");
    const code = (err as { code?: string }).code;
    const retryable = !code || code.startsWith("P1") || code === "P2034" || (err as { retryable?: boolean }).retryable === true;
    return { status: "FAILED", replies: [], transactionIds: [], detail: (err as Error).message.slice(0, 300), retryable };
  }
}

/** Natureza que o grupo dá aos lançamentos: a do grupo, a padrão da família ou perguntar. */
interface GroupNature {
  fallback?: "PERSONAL" | "BUSINESS";
  ask?: boolean;
  /** Grupo sem natureza atribuída (perguntas usam Tudo e mostram a divisão PF/Empresa). */
  unassigned: boolean;
}

interface MessageOptions {
  answerQueries: boolean;
  nature: GroupNature | null;
}

interface TextOptions extends MessageOptions {
  messageId: string | null;
  chatId: string;
  source: TransactionSource;
  attachmentId?: string | null;
  /** Mensagem citada (resposta a um lançamento ou à confirmação do robô). */
  quoted?: QuotedRef | null;
}

async function processText(ctx: ServiceContext, text: string, opts: TextOptions): Promise<ActionOutcome> {
  if (!text.trim()) return { status: "IGNORED", intent: "EMPTY", replies: [], transactionIds: [] };
  const hc = await loadHouseholdContext(ctx, ctx.memberId);
  const groupNature = opts.nature ? { fallback: opts.nature.fallback ?? null, ask: Boolean(opts.nature.ask) } : undefined;
  const exec = {
    channel: "WHATSAPP" as const,
    chatId: opts.chatId,
    messageId: opts.messageId,
    source: opts.source,
    attachmentId: opts.attachmentId ?? null,
    answerQueries: opts.answerQueries,
    text,
    nature: groupNature,
  };
  const answered = await tryAnswerClarification(ctx, hc, exec);
  if (answered) return answered;
  if (opts.source === "WHATSAPP_TEXT" && EXPLICIT_IMPORT_CONFIRM.test(normalizeForNlu(text))) {
    const imported = await answerImportConfirmation(ctx, opts.chatId, text, null);
    if (imported) return imported;
  }
  // "desconsidera esse" / "o pix do fulano é repasse": comando determinístico, sem IA.
  const exclusion = parseExclusionCommand(text);
  if (exclusion) return handleExclusionCommand(ctx, hc, exclusion, { channel: "WHATSAPP", chatId: opts.chatId, messageId: opts.messageId, quoted: opts.quoted ?? null });
  // "cria categoria Pet", "nova categoria Escola dentro de Educação": comando determinístico.
  const categoryCommand = parseCategoryCommand(text, hc);
  if (categoryCommand) return handleCategoryCommand(ctx, hc, categoryCommand);
  // "recebi 500 do Fulano, é repasse": registra (sem o marcador na descrição) e já desconsidera.
  const marker = hasExclusionMarker(text);
  let toInterpret = marker ? stripExclusionMarker(text) || text : text;
  // Natureza dita na mensagem ("empresa", "da empresa", "PJ", "PF", "pessoa física", "é pessoal"):
  // vence as regras e o grupo. Em pergunta, vira o recorte da resposta (o texto vai inteiro).
  const tokens = marker ? null : detectNatureTokens(toInterpret);
  const question = isQuestionText(normalizeForNlu(toInterpret));
  if (tokens && question) {
    if (tokens.nature) ctx.reportScope = tokens.nature;
    else if (tokens.both) ctx.reportScope = "ALL";
  } else if (tokens?.nature) toInterpret = tokens.stripped;
  const result = await interpretText(ctx, toInterpret, { senderMemberId: ctx.memberId, messageId: opts.messageId, hc });
  const outcome = await executeInterpretation(ctx, result, {
    ...exec,
    text: toInterpret,
    nature: { ...groupNature, explicit: question ? null : (tokens?.nature ?? null), perSegment: !question && Boolean(tokens?.both) },
  });
  if (marker && outcome.intent === "CREATE_TRANSACTIONS" && outcome.transactionIds.length) {
    const marked = await applyExclusion(ctx, hc, marker, outcome.transactionIds);
    // Logo depois da confirmação do registro (antes de eventuais perguntas de complemento).
    if (marked.transactionIds.length) outcome.replies.splice(Math.min(1, outcome.replies.length), 0, ...marked.replies);
  }
  // Grupo sem natureza: a resposta usa Tudo e mostra a divisão Pessoa física × Empresa.
  if (outcome.intent === "QUERY" && outcome.replies.length && ctx.reportScope === "ALL" && opts.nature?.unassigned) {
    const split = await natureSplitLine(ctx);
    if (split) outcome.replies[outcome.replies.length - 1] += `\n\n${split}`;
  }
  return outcome;
}

/** "Despesas de outubro: Pessoa física R$ X · Empresa R$ Y" (mês atual, repasses fora). */
async function natureSplitLine(ctx: ServiceContext): Promise<string | null> {
  try {
    const month = monthKey(todayISO(ctx.timezone));
    const period = monthRange(month);
    const [pf, pj] = await Promise.all([
      expensesByCategory(ctx, { period, filters: { scope: "PERSONAL" } }),
      expensesByCategory(ctx, { period, filters: { scope: "BUSINESS" } }),
    ]);
    if (!pf.totalCents && !pj.totalCents) return null;
    return `📊 Despesas de ${formatMonthBR(month)}: Pessoa física ${formatBRL(pf.totalCents)} · Empresa ${formatBRL(pj.totalCents)}`;
  } catch (err) {
    logger.debug({ err: errorInfo(err) }, "pipeline: divisão PF/Empresa indisponível");
    return null;
  }
}

type MessageWithAttachment = Prisma.WhatsAppMessageGetPayload<{ include: { attachment: true } }>;

async function processAudio(ctx: ServiceContext, message: MessageWithAttachment, base: MessageOptions, transcriptRetentionDays: number): Promise<ActionOutcome> {
  const att = message.attachment;
  if (!att) return { status: "IGNORED", intent: "AUDIO", replies: [], transactionIds: [], detail: "áudio sem anexo" };
  let transcript = decryptStringSafe(att.transcription);
  let vocabulary: FamilyVocabulary | null = null;
  const loadVocabulary = async () => (vocabulary ??= await familyVocabulary(ctx.householdId));
  if (!transcript) {
    if (!att.storageKey) {
      return failWithPending(ctx, message, "PROCESSING_FAILED", "Áudio indisponível", "O conteúdo do áudio não está mais armazenado (política de retenção).", "Não consegui acessar o áudio. Envie novamente ou escreva a mensagem.");
    }
    const audio = await readStoredFile(att.storageKey);
    const res = await transcribeAudio(ctx.householdId, audio, att.mimeType, message.id, { vocabulary: loadVocabulary });
    if (!res.ok) {
      return failWithPending(
        ctx,
        message,
        "CLARIFICATION",
        "Áudio não transcrito",
        res.reason ?? "Transcrição indisponível.",
        res.reply ?? `🎙️ Não consegui ouvir o áudio: ${res.userReason ?? res.reason ?? "transcrição indisponível"}. Pode enviar por texto?`,
      );
    }
    transcript = res.text!;
    await prisma.attachment.update({
      where: { id: att.id },
      data: {
        transcription: transcriptRetentionDays > 0 ? encryptString(transcript) : null,
        processingStatus: "TRANSCRIBED",
        extractedData: { transcriptionProvider: res.provider ?? null, chars: transcript.length } as Prisma.InputJsonValue,
      },
    });
  }
  // Corrige o que o Whisper costuma ouvir errado ("em presa", "no banque", "proí caro"). O texto
  // original continua guardado; o corrigido é o que segue e aparece na resposta.
  transcript = normalizeTranscript(transcript, await loadVocabulary());
  const outcome = await processText(ctx, transcript, {
    ...base,
    messageId: message.id,
    chatId: message.chatId,
    source: "WHATSAPP_AUDIO",
    attachmentId: att.id,
    quoted: message.quotedExternalId ? { connectionId: message.connectionId, externalId: message.quotedExternalId } : null,
  });
  if (outcome.transactionIds.length) {
    await prisma.attachment.updateMany({ where: { id: att.id, transactionId: null }, data: { transactionId: outcome.transactionIds[0]! } });
  }
  // Mostra o que foi entendido quando houve ação, para o usuário poder corrigir.
  if (outcome.replies.length && outcome.intent !== "SMALL_TALK") outcome.replies[0] = `🎙️ _“${transcript.slice(0, 300)}”_\n${outcome.replies[0]}`;
  return { ...outcome, detail: `${outcome.detail ?? ""} (áudio transcrito)`.trim() };
}

async function processReceipt(ctx: ServiceContext, message: MessageWithAttachment, base: MessageOptions): Promise<ActionOutcome> {
  const att = message.attachment;
  const caption = message.text?.trim() ?? "";
  if (!att) return caption ? processText(ctx, caption, { ...base, messageId: message.id, chatId: message.chatId, source: "WHATSAPP_IMAGE" }) : { status: "IGNORED", intent: "IMAGE", replies: [], transactionIds: [] };

  // Mesmo comprovante já usado em outro lançamento → nunca duplica.
  if (att.transactionId) {
    const tx = await prisma.transaction.findFirst({ where: { id: att.transactionId, householdId: ctx.householdId } });
    const ownMessage = tx?.sourceMessageId === message.id;
    if (tx && !ownMessage) {
      return {
        status: "PROCESSED",
        intent: "DUPLICATE_RECEIPT",
        replies: [`📎 Este comprovante já foi registrado: *${tx.description}* — ${formatBRL(tx.amountCents)} (${formatDateBR(tx.date.toISOString().slice(0, 10))}). Nada foi duplicado.`],
        transactionIds: [],
        detail: "comprovante repetido",
      };
    }
  }

  const captionHasAmount = extractAmounts(caption).length > 0;
  // PDF de extrato/fatura → prévia de importação. Legenda com valor ("50 mercado") sem menção a
  // extrato/fatura indica comprovante: segue o fluxo de texto + anexo abaixo.
  if (message.type === "DOCUMENT" && isPdfAttachment(att) && (!captionHasAmount || /\b(extrato|fatura)\b/.test(normalizeForNlu(caption)))) {
    if (!att.storageKey) {
      return failWithPending(ctx, message, "PROCESSING_FAILED", "PDF indisponível", "O arquivo não está mais armazenado.", "Não consegui acessar o PDF. Envie novamente.");
    }
    // Extrato/fatura em PDF → prévia de importação com confirmação pela conversa.
    const pdfNature = caption ? detectNatureTokens(caption).nature : null;
    const statement = await processPdfStatement(
      ctx,
      message,
      att,
      caption,
      (title, description, reply) => failWithPending(ctx, message, "PROCESSING_FAILED", title, description, reply, att.id),
      { defaultNature: pdfNature === "BUSINESS" || (!pdfNature && base.nature?.fallback === "BUSINESS") ? "BUSINESS" : null },
    );
    if (statement) return statement;
    return failWithPending(
      ctx,
      message,
      "UNREADABLE_RECEIPT",
      "Comprovante em PDF",
      "Comprovantes em PDF não são lidos automaticamente.",
      "📎 Este PDF parece um comprovante. Comprovantes eu leio em imagem: envie um print/foto ou escreva o valor e o estabelecimento (ex.: \"mercado 120,50 no débito\").",
      att.id,
    );
  }
  if (captionHasAmount) {
    // Texto + comprovante da mesma compra → um único lançamento, com o comprovante vinculado.
    return processText(ctx, caption, { ...base, messageId: message.id, chatId: message.chatId, source: "WHATSAPP_IMAGE", attachmentId: att.id });
  }

  if (!att.storageKey) {
    return failWithPending(ctx, message, "UNREADABLE_RECEIPT", "Comprovante indisponível", "A imagem não está mais armazenada.", "Não consegui acessar a imagem. Envie novamente.");
  }
  if (message.type === "DOCUMENT" && !att.mimeType.startsWith("image/")) {
    return failWithPending(ctx, message, "UNREADABLE_RECEIPT", "Documento não suportado", `Formato ${att.mimeType} não é lido automaticamente.`, "Recebi o documento, mas só leio comprovantes em imagem e extratos/faturas em PDF. Informe o valor e o estabelecimento por texto.");
  }

  const image = await readStoredFile(att.storageKey);
  const extraction = await extractReceipt(ctx.householdId, image, att.mimeType, message.id);
  if (!extraction.ok || !extraction.data.legible || extraction.data.total === null || !extraction.data.is_receipt) {
    const reason = extraction.ok ? (extraction.data.is_receipt ? "Valor total não legível." : "A imagem não parece ser um comprovante.") : extraction.reason;
    await prisma.attachment.update({ where: { id: att.id }, data: { processingStatus: "UNREADABLE", extractedData: extraction.ok ? (extraction.data as unknown as Prisma.InputJsonValue) : undefined } });
    return failWithPending(
      ctx,
      message,
      "UNREADABLE_RECEIPT",
      "Comprovante não identificado",
      reason,
      `🧾 Recebi o comprovante, mas não consegui identificar os dados (${reason}). Responda com o valor e o estabelecimento, por exemplo: "mercado 120,50 no débito".`,
      att.id,
    );
  }

  const data = extraction.data;
  const totalCents = Math.round(data.total! * 100);
  await prisma.attachment.update({ where: { id: att.id }, data: { processingStatus: "EXTRACTED", extractedData: data as unknown as Prisma.InputJsonValue } });

  // Texto enviado logo antes, pelo mesmo remetente, com o mesmo valor → vincula em vez de criar outro lançamento.
  const recentText = await prisma.transaction.findFirst({
    where: {
      householdId: ctx.householdId,
      createdByMemberId: ctx.memberId,
      amountCents: totalCents,
      deletedAt: null,
      createdAt: { gte: new Date(Date.now() - 20 * 60_000) },
      attachments: { none: {} },
      source: { in: ["WHATSAPP_TEXT", "WHATSAPP_AUDIO"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (recentText) {
    await prisma.attachment.update({ where: { id: att.id }, data: { transactionId: recentText.id } });
    return { status: "PROCESSED", intent: "LINK_RECEIPT", replies: [`📎 Comprovante vinculado a *${recentText.description}* — ${formatBRL(recentText.amountCents)}.`], transactionIds: [recentText.id] };
  }

  // Cria o lançamento a partir do comprovante (sempre com confirmação: dado extraído de imagem).
  const hc = await loadHouseholdContext(ctx, ctx.memberId);
  const merchant = data.merchant?.trim() || null;
  const sourceText = `${merchant ?? "Comprovante"} ${data.total!.toFixed(2).replace(".", ",")}`;
  const raw: RawDraft = {
    kind: "EXPENSE",
    amountCents: totalCents,
    amountText: data.total!.toFixed(2),
    amountIsInstallmentValue: false,
    description: merchant ?? "Compra (comprovante)",
    merchant,
    categoryHint: null,
    date: data.date && isISODate(data.date) ? data.date : null,
    dateExplicit: Boolean(data.date),
    paymentMethod: data.payment_method,
    accountHint: null,
    destinationAccountHint: null,
    cardHint: data.card_last4 ? hc.cards.find((c) => c.last4 === data.card_last4)?.name ?? null : null,
    installments: data.installments,
    personHint: null,
    responsibleHint: null,
    ownership: null,
    goalHint: null,
    confidence: Math.min(data.confidence, 0.8),
    segment: sourceText,
  };
  const draft = resolveDraft(raw, 0, hc, `${sourceText} ${(data.items ?? []).map((i) => i.description).join(" ")}`);
  const result = { raw: { intent: "CREATE_TRANSACTIONS" as const, drafts: [raw], correction: null, deletion: null, question: null, confidence: draft.confidence, engine: "LOCAL" as const, model: extraction.model }, drafts: [draft], hc, recent: [], fallbackReason: null };
  // Legenda "empresa"/"PF" decide a natureza do comprovante; senão, a do grupo.
  const captionNature = caption ? detectNatureTokens(caption).nature : null;
  const outcome = await executeInterpretation(ctx, result, {
    channel: "WHATSAPP",
    chatId: message.chatId,
    messageId: message.id,
    source: "WHATSAPP_IMAGE",
    attachmentId: att.id,
    answerQueries: base.answerQueries,
    text: sourceText,
    nature: { fallback: base.nature?.fallback ?? null, ask: Boolean(base.nature?.ask), explicit: captionNature },
  });
  if (outcome.replies.length) outcome.replies[0] = `🧾 Li o comprovante${merchant ? ` de *${merchant}*` : ""}.\n${outcome.replies[0]}`;
  return outcome;
}

async function failWithPending(
  ctx: ServiceContext,
  message: { id: string },
  type: "PROCESSING_FAILED" | "CLARIFICATION" | "UNREADABLE_RECEIPT",
  title: string,
  description: string,
  reply: string,
  attachmentId?: string,
): Promise<ActionOutcome> {
  await createPendingItem(prisma, {
    householdId: ctx.householdId,
    type,
    title,
    description,
    messageId: message.id,
    attachmentId: attachmentId ?? null,
    dedupeKey: `msg:${type}:${message.id}`,
  });
  await publishEvent(ctx.householdId, "pending.changed");
  return { status: "NEEDS_CLARIFICATION", intent: type, replies: [reply], transactionIds: [], detail: description };
}
