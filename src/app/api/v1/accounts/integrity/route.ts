import { authed } from "@/server/api/handler";
import { verifyLedgerIntegrity } from "@/server/modules/accounts/service";
import { rebuildHouseholdLedger } from "@/server/modules/transactions/service";
import { audit } from "@/server/modules/audit/service";
import { publishEvent } from "@/server/events";

/** GET → confere a consistência do ledger (transferências soma zero, parcelas = total, crédito sem caixa…). */
export const GET = authed({}, async ({ ctx }) => verifyLedgerIntegrity(ctx.householdId));

/**
 * POST → recalcula movimentos de caixa e parcelas de todas as transações da família (idempotente)
 * e confere novamente. Não altera transações; só os registros derivados.
 */
export const POST = authed({ permission: "settings:manage", rateLimit: { key: "ledger-rebuild", limit: 5, windowSeconds: 3600 } }, async ({ ctx }) => {
  const before = await verifyLedgerIntegrity(ctx.householdId);
  const { transactions } = await rebuildHouseholdLedger(ctx.householdId);
  const after = await verifyLedgerIntegrity(ctx.householdId);
  await audit(ctx, { action: "UPDATE", entityType: "Ledger", entityId: ctx.householdId, source: "DASHBOARD", metadata: { rebuilt: transactions, issuesBefore: before.issues.length, issuesAfter: after.issues.length } });
  await publishEvent(ctx.householdId, "account.changed");
  await publishEvent(ctx.householdId, "transaction.changed");
  return { rebuiltTransactions: transactions, before, after };
});
