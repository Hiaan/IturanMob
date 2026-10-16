import { authed } from "@/server/api/handler";
import { convertToTransfers, convertTransferSchema } from "@/server/modules/transactions/convert-transfer";

/**
 * Converte receitas/despesas em transferência com outra conta própria (aplicação/resgate).
 * { transactionIds, counterpartAccountId, dryRun? } — com dryRun, só devolve o plano.
 */
export const POST = authed(
  { body: convertTransferSchema, permission: "transactions:write", rateLimit: { key: "transactions:convert-transfer", limit: 20, windowSeconds: 60 } },
  async ({ ctx, body }) => convertToTransfers(ctx, body),
);
