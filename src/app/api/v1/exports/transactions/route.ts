import { authed } from "@/server/api/handler";
import { exportTransactions, exportTransactionsQuerySchema } from "@/server/modules/exports/service";
import { fileResponse } from "@/server/modules/exports/http";

/** Exporta transações (mesmos filtros da listagem, em ?q={...}) como CSV ou XLSX: ?format=csv|xlsx. Máximo 50 mil linhas. */
export const GET = authed(
  { query: exportTransactionsQuerySchema, permission: "data:export", rateLimit: { key: "exports", limit: 20, windowSeconds: 60 } },
  async ({ ctx, query }) => {
    const { format, ...filters } = query;
    const file = await exportTransactions(ctx, filters, format);
    const res = fileResponse(file.content, file.contentType, file.fileName);
    res.headers.set("X-Export-Rows", String(file.rowCount));
    if (file.truncated) res.headers.set("X-Export-Truncated", "true");
    return res;
  },
);
