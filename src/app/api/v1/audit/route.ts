import { z } from "zod";
import { authed } from "@/server/api/handler";
import { listAuditLogs } from "@/server/modules/audit/service";

export const GET = authed(
  { query: z.object({ entityType: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().optional(), cursor: z.string().optional() }) },
  async ({ ctx, query }) => {
    // Histórico de uma entidade específica é visível a todos; o log completo exige permissão.
    if (!query.entityId) {
      const { assertCan } = await import("@/server/auth/permissions");
      assertCan(ctx, "audit:read");
    }
    return listAuditLogs(ctx, query);
  },
);
