import type { Clarification, Prisma } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { logger, errorInfo } from "../../logger";
import { ForbiddenError } from "../../errors";
import { formatBRL } from "@/lib/money";
import { updateTransaction } from "../../modules/transactions/service";
import { createCategory, createRule, createSubcategory } from "../../modules/categories/service";
import { extractAmounts } from "../nlu/numbers";
import { normalizeForNlu } from "../nlu/text";
import { findMentions, matchCategory, parseLocally } from "../nlu/local-parser";
import { closeClarification, openClarification } from "./clarifications";
import type { HouseholdContext } from "./context";

/**
 * Perguntas de complemento depois de registrar um lançamento pelo WhatsApp.
 *
 * O lançamento já existe (o gasto não se perde); a pergunta só completa o que faltou:
 * - categoria, quando nem as palavras-chave nem as regras da família a identificaram;
 * - conta (ou cartão), quando a família tem mais de uma e a mensagem não disse qual.
 * Uma pergunta por vez, para quem enviou a mensagem, válida pela janela dos esclarecimentos.
 * A categoria respondida vira uma regra da família ("feijoada" → Almoço), visível em Categorias → Regras.
 */

export type FollowUpField = "category" | "account";

interface FollowUp {
  transactionId: string;
  field: FollowUpField;
}

interface FollowUpPayload {
  current: FollowUp;
  queue: FollowUp[];
  attempts: number;
}

export interface FollowUpOptions {
  channel: "WHATSAPP" | "DASHBOARD";
  chatId: string;
  messageId?: string | null;
}

export interface FollowUpAnswer {
  status: "PROCESSED" | "NEEDS_CLARIFICATION";
  intent: string;
  replies: string[];
  transactionIds: string[];
}

type TxRow = { id: string; type: string; description: string; amountCents: number; categoryId: string | null; accountId: string | null; creditCardId: string | null; status: string; deletedAt: Date | null };

const TX_SELECT = { id: true, type: true, description: true, amountCents: true, categoryId: true, accountId: true, creditCardId: true, status: true, deletedAt: true } as const;

function stillMissing(tx: TxRow | null, field: FollowUpField, hc: HouseholdContext): boolean {
  if (!tx || tx.deletedAt || tx.status !== "CONFIRMED") return false;
  if (tx.type !== "EXPENSE" && tx.type !== "INCOME") return false;
  if (field === "category") return !tx.categoryId;
  if (hc.accounts.length < 2) return false;
  return tx.type === "EXPENSE" ? !tx.accountId && !tx.creditCardId : !tx.accountId;
}

/** O que falta nos lançamentos informados, na ordem: categoria e depois conta de cada um. */
export async function planFollowUps(householdId: string, transactionIds: string[], hc: HouseholdContext): Promise<FollowUp[]> {
  if (!transactionIds.length) return [];
  const rows = await prisma.transaction.findMany({ where: { householdId, id: { in: transactionIds } }, select: TX_SELECT });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: FollowUp[] = [];
  for (const id of transactionIds) {
    const tx = byId.get(id) ?? null;
    for (const field of ["category", "account"] as const) if (stillMissing(tx, field, hc)) out.push({ transactionId: id, field });
  }
  return out;
}

/** Categorias sugeridas na pergunta: as mais usadas pela família nos últimos 6 meses, completadas pelas padrão. */
async function suggestedCategories(householdId: string, hc: HouseholdContext, kind: "EXPENSE" | "INCOME"): Promise<string[]> {
  const since = new Date(Date.now() - 180 * 24 * 3600 * 1000);
  const used = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: { householdId, type: kind, deletedAt: null, categoryId: { not: null }, createdAt: { gte: since } },
    _count: { _all: true },
    orderBy: { _count: { categoryId: "desc" } },
    take: 6,
  });
  const ofKind = hc.categories.filter((c) => c.kind === kind);
  const names = used.map((u) => ofKind.find((c) => c.id === u.categoryId)?.name).filter(Boolean) as string[];
  for (const c of ofKind) {
    if (names.length >= 6) break;
    if (!names.includes(c.name)) names.push(c.name);
  }
  return names.slice(0, 6);
}

async function questionFor(ctx: ServiceContext, hc: HouseholdContext, tx: TxRow, field: FollowUpField): Promise<string> {
  const label = `*${tx.description}* (${formatBRL(tx.amountCents)})`;
  if (field === "category") {
    const examples = await suggestedCategories(ctx.householdId, hc, tx.type === "INCOME" ? "INCOME" : "EXPENSE");
    return `🏷️ Qual a categoria de ${label}?${examples.length ? `\nEx.: ${examples.join(", ")}.` : ""}\nPode ser uma categoria nova. Para deixar sem, responda *pular*.`;
  }
  const accounts = hc.accounts.map((a) => a.name).join(", ");
  if (tx.type === "INCOME") return `🏦 Em qual conta entrou ${label}?\nContas: ${accounts}.\nPara deixar sem, responda *pular*.`;
  const cards = hc.cards.map((c) => c.name).join(", ");
  return `🏦 De onde saiu ${label}?\nContas: ${accounts}.${cards ? `\nCartões: ${cards}.` : ""}\nPara deixar sem, responda *pular*.`;
}

/**
 * Abre a próxima pergunta da fila (pulando o que já foi completado por outro caminho).
 * Retorna o texto da pergunta, ou null quando não há mais nada a perguntar.
 */
export async function askNextFollowUp(ctx: ServiceContext, hc: HouseholdContext, opts: FollowUpOptions, queue: FollowUp[]): Promise<string | null> {
  if (opts.channel !== "WHATSAPP") return null;
  const pending = [...queue];
  while (pending.length) {
    const current = pending.shift()!;
    const tx = await prisma.transaction.findFirst({ where: { id: current.transactionId, householdId: ctx.householdId }, select: TX_SELECT });
    if (!stillMissing(tx, current.field, hc)) continue;
    const question = await questionFor(ctx, hc, tx!, current.field);
    const payload: FollowUpPayload = { current, queue: pending, attempts: 1 };
    await openClarification({
      householdId: ctx.householdId,
      memberId: hc.sender?.memberId ?? null,
      channel: opts.channel,
      chatId: opts.chatId,
      messageId: opts.messageId ?? null,
      kind: "COMPLETE_TRANSACTION",
      question,
      payload: payload as unknown as Prisma.InputJsonValue,
    });
    return question;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Respostas
// -----------------------------------------------------------------------------

const SKIP = /^(pular|pula|pule|deixa|deixe|deixa pra la|nao sei|sei la|depois|nenhuma|nenhum|tanto faz|sem categoria|ignora|ignorar|nao|n)\b/;
/** Palavras de ligação no início da resposta ("é almoço", "coloca em lazer", "categoria saúde"). */
const LEADING = new Set(["e", "eh", "foi", "seria", "acho", "que", "categoria", "subcategoria", "coloca", "coloque", "poe", "ponha", "bota", "em", "na", "no", "de", "da", "do", "pra", "para", "a", "o", "como", "isso", "ai", "pode", "ser"]);
/** Palavras que não identificam um gasto (não viram regra). */
const GENERIC = new Set(["despesa", "gasto", "gastei", "compra", "comprei", "pagamento", "paguei", "pix", "debito", "credito", "cartao", "dinheiro", "conta", "valor", "reais", "real", "hoje", "ontem", "coisa", "coisas", "outro", "outros", "outra", "outras", "diversos", "item", "itens", "receita", "recebi", "de", "do", "da", "no", "na", "em", "com", "o", "a", "os", "as", "um", "uma"]);
const NEW_CATEGORY_COLORS = ["#0ea5e9", "#f97316", "#a855f7", "#14b8a6", "#ec4899", "#84cc16", "#eab308", "#6366f1"];

/** Mensagem que claramente não é resposta: tem valor ou é pergunta/correção/exclusão. */
function looksLikeNewMessage(text: string, hc: HouseholdContext): boolean {
  if (extractAmounts(text).length) return true;
  const parsed = parseLocally(text, hc);
  return parsed.intent === "QUERY" || parsed.intent === "CORRECTION" || parsed.intent === "DELETE" || parsed.intent === "RESTORE";
}

/** Palavras da resposta sem as de ligação do início, preservando acentos (para o nome exibido). */
function answerWords(text: string): Array<{ raw: string; norm: string }> {
  const words = text
    .replace(/[?!.,;:*_"“”()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, norm: normalizeForNlu(raw).trim() }))
    .filter((w) => w.norm);
  while (words.length && LEADING.has(words[0]!.norm)) words.shift();
  return words;
}

const singular = (s: string) => (s.length > 3 && s.endsWith("s") ? s.slice(0, -1) : s);
const sameName = (a: string, b: string) => a === b || singular(a) === singular(b);

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Nome parecido: um contém o outro ("mercado" ↔ "supermercado") ou erro de digitação pequeno. */
function similarName(term: string, name: string): boolean {
  if (term.length >= 5 && name.length >= 5 && (name.includes(term) || term.includes(name))) return true;
  const max = term.length >= 8 ? 2 : term.length >= 5 ? 1 : 0;
  return max > 0 && distance(term, name) <= max;
}

export interface CategoryChoice {
  categoryId: string;
  subcategoryId: string | null;
  label: string;
  created: boolean;
}

/**
 * Interpreta a resposta "qual a categoria?": casa com categoria/subcategoria existente (sem acento, singular/plural,
 * nome parecido); "Categoria > Sub" escolhe ou cria a subcategoria; sem correspondência, cria com o nome informado,
 * dentro da categoria sugerida pelas palavras-chave (ex.: "almoço" → Alimentação › Almoço) ou como categoria nova.
 */
export async function resolveCategoryAnswer(ctx: ServiceContext, hc: HouseholdContext, text: string, kind: "EXPENSE" | "INCOME"): Promise<CategoryChoice | null> {
  const ofKind = hc.categories.filter((c) => c.kind === kind);
  const parts = text.split(/\s*(?:>|›|\/)\s*/).filter((p) => p.trim());
  const display = (words: Array<{ raw: string }>) => {
    const s = words.map((w) => w.raw).join(" ").slice(0, 50);
    return s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1);
  };

  // "Alimentação > Almoço"
  if (parts.length === 2) {
    const parentWords = answerWords(parts[0]!);
    const childWords = answerWords(parts[1]!);
    const parent = ofKind.find((c) => sameName(c.normalized, parentWords.map((w) => w.norm).join(" ")));
    if (parent && childWords.length && childWords.length <= 4) {
      const childTerm = childWords.map((w) => w.norm).join(" ");
      const sub = parent.subcategories.find((s) => sameName(s.normalized, childTerm)) ?? parent.subcategories.find((s) => similarName(childTerm, s.normalized));
      if (sub) return { categoryId: parent.id, subcategoryId: sub.id, label: `${parent.name} › ${sub.name}`, created: false };
      const created = await createSubcategory(ctx, parent.id, { name: display(childWords), keywords: [childTerm] });
      return { categoryId: parent.id, subcategoryId: created.id, label: `${parent.name} › ${created.name}`, created: true };
    }
  }

  const words = answerWords(text);
  if (!words.length || words.length > 4) return null;
  const term = words.map((w) => w.norm).join(" ");

  for (const c of ofKind) for (const s of c.subcategories) if (sameName(s.normalized, term)) return { categoryId: c.id, subcategoryId: s.id, label: `${c.name} › ${s.name}`, created: false };
  for (const c of ofKind) if (sameName(c.normalized, term)) return { categoryId: c.id, subcategoryId: null, label: c.name, created: false };
  for (const c of ofKind) for (const s of c.subcategories) if (similarName(term, s.normalized)) return { categoryId: c.id, subcategoryId: s.id, label: `${c.name} › ${s.name}`, created: false };
  for (const c of ofKind) if (similarName(term, c.normalized)) return { categoryId: c.id, subcategoryId: null, label: c.name, created: false };

  // Nova: dentro da categoria indicada pelas palavras-chave, ou como categoria própria.
  const name = display(words);
  const hint = matchCategory(term, hc, kind);
  if (hint) {
    const parent = ofKind.find((c) => c.id === hint.categoryId)!;
    const created = await createSubcategory(ctx, parent.id, { name, keywords: [term] });
    return { categoryId: parent.id, subcategoryId: created.id, label: `${parent.name} › ${created.name}`, created: true };
  }
  const color = NEW_CATEGORY_COLORS[ofKind.length % NEW_CATEGORY_COLORS.length]!;
  const created = await createCategory(ctx, { name, kind, icon: "tag", color });
  return { categoryId: created.id, subcategoryId: null, label: created.name, created: true };
}

/** Termo da descrição que identifica o gasto, para a regra aprendida (null se for genérico demais). */
export function learnablePattern(description: string): string | null {
  const words = normalizeForNlu(description)
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !GENERIC.has(w));
  if (!words.length || words.length > 3) return null;
  const pattern = words.join(" ");
  return pattern.length >= 3 ? pattern : null;
}

/** Registra a preferência explícita como regra da família (não sobrescreve regras criadas por pessoas no painel). */
async function learnCategory(ctx: ServiceContext, description: string, kind: "EXPENSE" | "INCOME", choice: CategoryChoice): Promise<string | null> {
  const pattern = learnablePattern(description);
  if (!pattern) return null;
  try {
    const existing = await prisma.financialRule.findFirst({ where: { householdId: ctx.householdId, pattern: { equals: pattern, mode: "insensitive" }, transactionType: kind } });
    if (existing) {
      if (existing.source !== "WHATSAPP") return null;
      await prisma.financialRule.update({ where: { id: existing.id }, data: { setCategoryId: choice.categoryId, setSubcategoryId: choice.subcategoryId, active: true } });
      return pattern;
    }
    await createRule(
      ctx,
      {
        name: `“${pattern}” → ${choice.label}`.slice(0, 80),
        matchField: "DESCRIPTION",
        matchType: "CONTAINS",
        pattern,
        transactionType: kind,
        setCategoryId: choice.categoryId,
        setSubcategoryId: choice.subcategoryId,
        priority: 200,
      },
      "WHATSAPP",
    );
    return pattern;
  } catch (err) {
    logger.debug({ err: errorInfo(err), householdId: ctx.householdId }, "follow-ups: regra não aprendida");
    return null;
  }
}

/** Trata a resposta a uma pergunta de complemento. Retorna null quando a mensagem não é uma resposta. */
export async function answerFollowUp(ctx: ServiceContext, hc: HouseholdContext, opts: FollowUpOptions & { text: string }, open: Clarification): Promise<FollowUpAnswer | null> {
  const payload = open.payload as unknown as FollowUpPayload;
  const { current, queue } = payload;
  const norm = normalizeForNlu(opts.text).trim();
  const tx = await prisma.transaction.findFirst({ where: { id: current.transactionId, householdId: ctx.householdId }, select: TX_SELECT });
  const next = async (replies: string[]) => {
    const question = await askNextFollowUp(ctx, hc, opts, queue);
    if (question) replies.push(question);
    return { status: question ? ("NEEDS_CLARIFICATION" as const) : ("PROCESSED" as const), intent: "CLARIFICATION", replies, transactionIds: tx ? [tx.id] : [] };
  };

  // Já foi completado por outro caminho (painel, correção): segue para a próxima.
  if (!stillMissing(tx, current.field, hc)) {
    await closeClarification(open.id, "CANCELLED");
    return looksLikeNewMessage(opts.text, hc) ? null : next([]);
  }
  if (SKIP.test(norm) && norm.split(" ").length <= 4) {
    await closeClarification(open.id);
    return next([`Ok, *${tx!.description}* ficou sem ${current.field === "category" ? "categoria" : "conta"}. Dá para ajustar depois no painel.`]);
  }
  if (looksLikeNewMessage(opts.text, hc)) {
    await closeClarification(open.id, "CANCELLED");
    return null;
  }

  const kind = tx!.type === "INCOME" ? "INCOME" : "EXPENSE";
  const label = `*${tx!.description}* (${formatBRL(tx!.amountCents)})`;

  if (current.field === "category") {
    let choice: CategoryChoice | null = null;
    try {
      choice = await resolveCategoryAnswer(ctx, hc, opts.text, kind);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return { status: "NEEDS_CLARIFICATION", intent: "CLARIFICATION", replies: ["Seu perfil não pode criar categorias. Responda com uma categoria que já existe ou *pular*."], transactionIds: [tx!.id] };
      }
      throw err;
    }
    if (!choice) return retry(open, payload);
    await updateTransaction(ctx, tx!.id, { categoryId: choice.categoryId, subcategoryId: choice.subcategoryId });
    await closeClarification(open.id);
    const learned = await learnCategory(ctx, tx!.description, kind, choice);
    const lines = [`✅ ${label} ficou em *${choice.label}*${choice.created ? " (categoria criada agora)" : ""}.`];
    if (learned) lines.push(`Da próxima vez, “${learned}” já entra nessa categoria.`);
    return next([lines.join("\n")]);
  }

  // Conta ou cartão
  const accounts = findMentions(norm, hc.accounts);
  const cards = tx!.type === "EXPENSE" ? findMentions(norm, hc.cards) : [];
  const wantsCard = /\b(cartao|credito)\b/.test(norm);
  const wallet = /\b(dinheiro|especie|carteira)\b/.test(norm) ? hc.accounts.filter((a) => a.type === "WALLET") : [];
  if (cards.length && (wantsCard || !accounts.length)) {
    const card = hc.cards.find((c) => c.id === cards[0]!.id)!;
    await updateTransaction(ctx, tx!.id, { creditCardId: card.id, accountId: null, paymentMethod: "CREDIT_CARD" });
    await closeClarification(open.id);
    return next([`✅ ${label} foi no cartão *${card.name}*.`]);
  }
  const accountId = accounts[0]?.id ?? (wallet.length === 1 ? wallet[0]!.id : null);
  if (!accountId) return retry(open, payload);
  const account = hc.accounts.find((a) => a.id === accountId)!;
  await updateTransaction(ctx, tx!.id, { accountId: account.id, creditCardId: null });
  await closeClarification(open.id);
  return next([`✅ ${label} ${tx!.type === "INCOME" ? "entrou em" : "saiu de"} *${account.name}*.`]);
}

/** Resposta não entendida: repete a pergunta uma vez; na segunda, desiste (o lançamento continua em Pendências). */
async function retry(open: Clarification, payload: FollowUpPayload): Promise<FollowUpAnswer> {
  if (payload.attempts >= 2) {
    await closeClarification(open.id, "CANCELLED");
    return { status: "PROCESSED", intent: "CLARIFICATION", replies: ["Não entendi. Deixei como estava; dá para completar em Pendências, no painel."], transactionIds: [payload.current.transactionId] };
  }
  await prisma.clarification.update({ where: { id: open.id }, data: { payload: { ...payload, attempts: payload.attempts + 1 } as unknown as Prisma.InputJsonValue } });
  return { status: "NEEDS_CLARIFICATION", intent: "CLARIFICATION", replies: [`Não entendi. ${open.question}`], transactionIds: [payload.current.transactionId] };
}
