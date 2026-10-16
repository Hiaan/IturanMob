import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { ForbiddenError } from "@/server/errors";
import { audit } from "@/server/modules/audit/service";
import { createDatabaseBackup, listBackupsForHousehold, verifyBackup } from "@/server/modules/backups/service";

export const GET = authed({ query: z.object({ limit: qs.int(50) }), permission: "settings:manage" }, async ({ ctx, query }) => listBackupsForHousehold(ctx, query.limit));

/** Cria um backup imediato (somente o proprietário) e o verifica em seguida. */
export const POST = authed({ permission: "settings:manage", rateLimit: { key: "backups:create", limit: 5, windowSeconds: 3600 } }, async ({ ctx }) => {
  if (ctx.role !== "OWNER") throw new ForbiddenError("Apenas o proprietário pode iniciar um backup.");
  const created = await createDatabaseBackup();
  const result = created.status === "SUCCESS" ? ((await verifyBackup(created.id)).record ?? created) : created;
  await audit(ctx, { action: "CREATE", entityType: "BackupRecord", entityId: result.id, metadata: { kind: result.kind, status: result.status } });
  return result;
});
