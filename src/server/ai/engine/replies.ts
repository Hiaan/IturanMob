import { formatBRL, splitEvenly } from "@/lib/money";
import { addDays, formatDateBR } from "@/lib/dates";
import { PAYMENT_METHOD_LABELS, labelOf } from "@/lib/labels";
import type { ResolvedDraft } from "./resolve";

/** Formatação das respostas do bot (português, curtas, estilo WhatsApp). */
export function relativeDate(iso: string, today: string): string {
  if (iso === today) return "hoje";
  if (iso === addDays(today, -1)) return "ontem";
  return formatDateBR(iso);
}

/** "em 3x de R$ 10,00" ou, quando sobra centavo, "em 3x (1ª de R$ 94,64 e 2 de R$ 94,63)". */
export function installmentsText(totalCents: number, count: number): string {
  if (totalCents <= 0 || count < 2) return `em ${count}x`;
  const parts = splitEvenly(totalCents, count);
  const first = parts[0]!;
  const rest = parts[1]!;
  if (first === rest) return `em ${count}x de ${formatBRL(rest)}`;
  return `em ${count}x (1ª de ${formatBRL(first)} e ${count - 1} de ${formatBRL(rest)})`;
}

export function draftSummary(d: ResolvedDraft, today: string): string {
  const parts: string[] = [];
  if (d.labels.category) parts.push(d.labels.subcategory ? `${d.labels.category} › ${d.labels.subcategory}` : d.labels.category);
  if (d.kind === "TRANSFER") parts.push(`${d.labels.account ?? "?"} → ${d.labels.destinationAccount ?? "?"}`);
  else if (d.labels.card) parts.push(`${d.labels.card}${d.installmentCount > 1 ? ` ${installmentsText(d.amountCents ?? 0, d.installmentCount)}` : ""}`);
  else if (d.labels.account) parts.push(d.labels.account);
  else if (d.paymentMethod) parts.push(labelOf(PAYMENT_METHOD_LABELS, d.paymentMethod));
  if (d.labels.goal) parts.push(`meta ${d.labels.goal}`);
  if (d.labels.payer) parts.push(`por ${d.labels.payer}`);
  if (d.labels.responsible && d.ownership === "INDIVIDUAL") parts.push(`despesa de ${d.labels.responsible}`);
  parts.push(relativeDate(d.date, today));
  return parts.join(" · ");
}

export function kindVerb(kind: string): string {
  switch (kind) {
    case "INCOME":
      return "Receita registrada";
    case "TRANSFER":
      return "Transferência registrada";
    case "CARD_PAYMENT":
      return "Pagamento de fatura registrado";
    case "GOAL_CONTRIBUTION":
      return "Contribuição registrada";
    default:
      return "Registrado";
  }
}

export function createdLine(d: ResolvedDraft, today: string): string {
  return `*${d.description}* — ${formatBRL(d.amountCents ?? 0)}\n${draftSummary(d, today)}`;
}

export function missingQuestion(d: ResolvedDraft, opts: { cards: string[]; accounts: string[]; goals: string[] }): string {
  const label = d.description ? `*${d.description}*` : "o lançamento";
  const missing = d.missing;
  if (missing.includes("valor")) return `Não identifiquei o valor de ${label}. Quanto foi?`;
  if (missing.includes("cartão")) {
    return `Em qual cartão foi ${label}${d.amountCents ? ` (${formatBRL(d.amountCents)}${d.installmentCount > 1 ? ` em ${d.installmentCount}x` : ""})` : ""}? Opções: ${opts.cards.join(", ")}.`;
  }
  if (missing.some((m) => m.startsWith("conta"))) return `De qual conta para qual conta foi a transferência de ${formatBRL(d.amountCents ?? 0)}? Contas: ${opts.accounts.join(", ")}.`;
  if (missing.some((m) => m.startsWith("meta"))) {
    return opts.goals.length ? `Para qual meta é a contribuição de ${formatBRL(d.amountCents ?? 0)}? Metas: ${opts.goals.join(", ")}.` : "Não há metas cadastradas. Crie a meta no painel (Metas) e envie novamente.";
  }
  return `Preciso de mais informações sobre ${label}: ${missing.join(", ")}.`;
}

export const CONFIRM_HINT = "Responda *sim* para confirmar ou *não* para descartar.";
