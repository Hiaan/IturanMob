import { prisma } from "../../db";
import { deleteStoredFile } from "../../storage";
import { logger } from "../../logger";

/**
 * Política de retenção (LGPD — minimização):
 * - Mídias originais (áudios/imagens) são apagadas após `mediaRetentionDays`.
 * - Transcrições são apagadas após `transcriptRetentionDays`.
 * Os metadados (hash, vínculo com a transação, dados extraídos sem informação sensível) são mantidos.
 */
export async function runRetentionJobs(now: Date = new Date()): Promise<{ media: number; transcripts: number }> {
  let media = 0;
  let transcripts = 0;
  const households = await prisma.householdSettings.findMany({ select: { householdId: true, mediaRetentionDays: true, transcriptRetentionDays: true } });
  for (const h of households) {
    const mediaCutoff = new Date(now.getTime() - h.mediaRetentionDays * 86_400_000);
    const expired = await prisma.attachment.findMany({
      where: {
        householdId: h.householdId,
        contentDeletedAt: null,
        storageKey: { not: null },
        kind: { in: ["AUDIO", "IMAGE", "DOCUMENT"] },
        OR: [{ retentionUntil: { lte: now } }, { retentionUntil: null, createdAt: { lte: mediaCutoff } }],
      },
      select: { id: true, storageKey: true },
      take: 500,
    });
    for (const a of expired) {
      try {
        if (a.storageKey) await deleteStoredFile(a.storageKey);
        await prisma.attachment.update({ where: { id: a.id }, data: { contentDeletedAt: now, storageKey: null } });
        media++;
      } catch (err) {
        logger.warn({ attachmentId: a.id, err: (err as Error).message }, "retenção: falha ao apagar mídia");
      }
    }
    const transcriptCutoff = new Date(now.getTime() - h.transcriptRetentionDays * 86_400_000);
    const res = await prisma.attachment.updateMany({
      where: { householdId: h.householdId, transcription: { not: null }, transcriptDeletedAt: null, createdAt: { lte: transcriptCutoff } },
      data: { transcription: null, transcriptDeletedAt: now },
    });
    transcripts += res.count;
  }
  if (media || transcripts) logger.info({ media, transcripts }, "retenção: conteúdo expirado removido");
  return { media, transcripts };
}
