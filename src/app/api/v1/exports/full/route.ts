import { authed } from "@/server/api/handler";
import { exportFullHouseholdFile } from "@/server/modules/exports/service";
import { fileResponse } from "@/server/modules/exports/http";

/** Portabilidade (LGPD): todos os dados da família em JSON, sem senhas, tokens, chaves ou mídias. */
export const GET = authed({ permission: "data:export", rateLimit: { key: "exports:full", limit: 5, windowSeconds: 3600 } }, async ({ ctx }) => {
  const file = await exportFullHouseholdFile(ctx);
  return fileResponse(file.content, file.contentType, file.fileName);
});
