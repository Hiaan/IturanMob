import { prisma, type Db } from "../../db";

/**
 * Marca de aviso já disparado (faixa de meta por mês, prazo, etc.). Devolve true só para quem
 * registrou a marca agora: execuções repetidas ou concorrentes não avisam duas vezes.
 */
export async function claimAlertMark(householdId: string, key: string, db: Db = prisma): Promise<boolean> {
  // ON CONFLICT DO NOTHING: a marca existente não gera erro (nem log) a cada execução do job.
  const res = await db.alertMark.createMany({ data: [{ householdId, key }], skipDuplicates: true });
  return res.count === 1;
}
