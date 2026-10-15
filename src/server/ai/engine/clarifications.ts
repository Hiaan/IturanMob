import type { ClarificationKind, Prisma } from "@prisma/client";
import { prisma } from "../../db";

/** Perguntas de esclarecimento ficam abertas por 30 minutos por remetente e conversa. */
export const CLARIFICATION_TTL_MS = 30 * 60 * 1000;

export async function openClarification(params: {
  householdId: string;
  memberId: string | null;
  channel: "WHATSAPP" | "DASHBOARD";
  chatId: string;
  messageId?: string | null;
  kind: ClarificationKind;
  question: string;
  payload: Prisma.InputJsonValue;
}) {
  // Uma pergunta aberta por remetente/conversa: a nova substitui a anterior.
  await prisma.clarification.updateMany({
    where: { householdId: params.householdId, chatId: params.chatId, memberId: params.memberId, status: "OPEN" },
    data: { status: "CANCELLED" },
  });
  return prisma.clarification.create({
    data: {
      householdId: params.householdId,
      memberId: params.memberId,
      channel: params.channel,
      chatId: params.chatId,
      messageId: params.messageId ?? null,
      kind: params.kind,
      question: params.question.slice(0, 1000),
      payload: params.payload,
      expiresAt: new Date(Date.now() + CLARIFICATION_TTL_MS),
    },
  });
}

export async function findOpenClarification(householdId: string, chatId: string, memberId: string | null) {
  return prisma.clarification.findFirst({
    where: { householdId, chatId, memberId, status: "OPEN", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}

export async function closeClarification(id: string, status: "ANSWERED" | "CANCELLED" | "EXPIRED" = "ANSWERED") {
  await prisma.clarification.update({ where: { id }, data: { status, answeredAt: new Date() } });
}
