import { authed } from "@/server/api/handler";
import { reportExclusionSchema, setReportExclusion } from "@/server/modules/transactions/report-exclusion";

/**
 * Desconsidera (ou volta a considerar) lançamentos nos relatórios. Não muda saldo, ledger nem fatura.
 * { transactionIds, excluded, reason?, party?, note? }
 */
export const POST = authed(
  { body: reportExclusionSchema, permission: "transactions:write", rateLimit: { key: "transactions:report-exclusion", limit: 60, windowSeconds: 60 } },
  async ({ ctx, body }) => setReportExclusion(ctx, body),
);
