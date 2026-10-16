import { errorInfo, logger } from "../../logger";
import { runBackupIfDue } from "./service";

/** Executa backup periódico conforme BACKUP_INTERVAL_HOURS. Idempotente por janela. */
export async function runBackupJob(): Promise<void> {
  try {
    const result = await runBackupIfDue();
    if (result) logger.info({ backupId: result.id, status: result.status, kind: result.kind }, "backups: backup periódico executado");
  } catch (err) {
    logger.error({ err: errorInfo(err) }, "backups: falha no backup periódico");
    throw err;
  }
}
