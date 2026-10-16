import { authed } from "@/server/api/handler";
import { setNatureSchema, setTransactionNature } from "@/server/modules/transactions/nature";

/**
 * Natureza de um ou vários lançamentos: Pessoal, Empresa ou Repasse (desconsiderado nos relatórios).
 * { transactionIds, nature, reason?, party?, note? } — saldo, ledger e fatura não mudam.
 */
export const POST = authed(
  { body: setNatureSchema, permission: "transactions:write", rateLimit: { key: "transactions:nature", limit: 60, windowSeconds: 60 } },
  async ({ ctx, body }) => setTransactionNature(ctx, body),
);
