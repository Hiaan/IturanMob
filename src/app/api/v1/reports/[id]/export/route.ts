import { z } from "zod";
import { authed } from "@/server/api/handler";
import { exportReport } from "@/server/modules/reports/service";
import { fileResponse } from "@/server/modules/exports/http";

/** Download do relatório: ?format=pdf|xlsx|csv (CSV = transações do período). */
export const GET = authed(
  { query: z.object({ format: z.enum(["pdf", "xlsx", "csv"]).default("pdf") }), permission: "reports:read", rateLimit: { key: "reports:export", limit: 30, windowSeconds: 60 } },
  async ({ ctx, params, query }) => {
    const file = await exportReport(ctx, params.id!, query.format);
    return fileResponse(file.content, file.contentType, file.fileName);
  },
);
