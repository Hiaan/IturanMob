import { prisma } from "../db";

export { recoverStuckJobs } from "../whatsapp/recovery";

/** Expira perguntas de esclarecimento sem resposta (a pendência correspondente permanece aberta). */
export async function expireClarifications(now: Date = new Date()): Promise<number> {
  const res = await prisma.clarification.updateMany({ where: { status: "OPEN", expiresAt: { lt: now } }, data: { status: "EXPIRED" } });
  return res.count;
}
