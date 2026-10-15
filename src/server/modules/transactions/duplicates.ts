import type { TransactionType } from "@prisma/client";
import type { Db } from "../../db";
import { addDays, dateToISO, isoToDate, type ISODate } from "@/lib/dates";
import { normalizeText, tokenSimilarity } from "@/lib/utils";
import { sha256Hex } from "../../crypto";

export interface DuplicateSubject {
  householdId: string;
  type: TransactionType;
  amountCents: number;
  date: ISODate;
  description: string;
  merchantName?: string | null;
  excludeTransactionId?: string | null;
  sourceMessageId?: string | null;
}

export interface DuplicateCandidate {
  id: string;
  description: string;
  amountCents: number;
  date: ISODate;
  source: string;
  score: number;
  reasons: string[];
}

/** Impressão digital estável: tipo + valor + data + primeira palavra relevante. */
export function transactionFingerprint(s: Pick<DuplicateSubject, "type" | "amountCents" | "date" | "description" | "merchantName">): string {
  const words = normalizeText(s.merchantName || s.description).split(" ").filter((w) => w.length > 2);
  return sha256Hex(`${s.type}|${s.amountCents}|${s.date}|${words[0] ?? ""}`).slice(0, 32);
}

/**
 * Procura lançamentos semelhantes já existentes. Nunca descarta automaticamente:
 * o chamador decide marcar o novo lançamento como pendente de confirmação.
 * Mensagens diferentes com despesas parecidas são apenas "suspeitas".
 */
export async function findPossibleDuplicates(db: Db, subject: DuplicateSubject, windowHours: number): Promise<DuplicateCandidate[]> {
  const windowDays = Math.max(0, Math.ceil(windowHours / 24));
  const candidates = await db.transaction.findMany({
    where: {
      householdId: subject.householdId,
      type: subject.type,
      amountCents: subject.amountCents,
      deletedAt: null,
      date: { gte: isoToDate(addDays(subject.date, -windowDays)), lte: isoToDate(addDays(subject.date, windowDays)) },
      ...(subject.excludeTransactionId ? { id: { not: subject.excludeTransactionId } } : {}),
    },
    include: { merchant: { select: { name: true } } },
    take: 20,
    orderBy: { createdAt: "desc" },
  });
  const result: DuplicateCandidate[] = [];
  for (const c of candidates) {
    if (subject.sourceMessageId && c.sourceMessageId === subject.sourceMessageId) continue;
    const reasons: string[] = ["mesmo valor"];
    let score = 0.45;
    const cDate = dateToISO(c.date);
    if (cDate === subject.date) {
      score += 0.2;
      reasons.push("mesma data");
    } else {
      reasons.push("data próxima");
    }
    const sim = Math.max(
      tokenSimilarity(subject.description, c.description),
      subject.merchantName && c.merchant?.name ? tokenSimilarity(subject.merchantName, c.merchant.name) : 0,
      subject.merchantName ? tokenSimilarity(subject.merchantName, c.description) : 0,
    );
    if (sim >= 0.5) {
      score += 0.3;
      reasons.push("descrição semelhante");
    } else if (sim > 0) {
      score += 0.1;
    }
    result.push({ id: c.id, description: c.description, amountCents: c.amountCents, date: cDate, source: c.source, score: Math.min(1, score), reasons });
  }
  return result.sort((a, b) => b.score - a.score);
}

/** Pontuação mínima para tratar como suspeita de duplicidade. */
export const DUPLICATE_SUSPICION_SCORE = 0.75;
