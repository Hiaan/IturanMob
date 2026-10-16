import { authed } from "@/server/api/handler";
import { passthroughQuerySchema, passthroughSummary } from "@/server/modules/transactions/report-exclusion";

/** Saldo dos repasses de cliente (recebido × gasto por cliente). ?start=&end= opcionais. */
export const GET = authed({ query: passthroughQuerySchema, permission: "transactions:read" }, async ({ ctx, query }) => passthroughSummary(ctx, query));
