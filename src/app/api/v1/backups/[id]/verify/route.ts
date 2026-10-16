import { authed } from "@/server/api/handler";
import { getBackupForHousehold, verifyBackup } from "@/server/modules/backups/service";

export const POST = authed({ permission: "settings:manage", rateLimit: { key: "backups:verify", limit: 20, windowSeconds: 3600 } }, async ({ ctx, params }) => {
  const record = await getBackupForHousehold(ctx, params.id!);
  const result = await verifyBackup(record.id);
  return { ok: result.ok, status: result.status, message: result.message, structure: result.structure, record: result.record };
});
