import { authed } from "@/server/api/handler";
import { createTransaction, listTransactions } from "@/server/modules/transactions/service";
import { transactionCreateSchema, transactionListSchema } from "@/server/modules/transactions/schemas";
import { z } from "zod";

export const GET = authed({ query: transactionListSchema.extend({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) }) }, async ({ ctx, query }) =>
  listTransactions(ctx, query),
);

export const POST = authed(
  { body: transactionCreateSchema.extend({ scheduledPaymentId: z.string().optional(), source: z.enum(["MANUAL", "DASHBOARD_CHAT"]).default("MANUAL") }), permission: "transactions:write" },
  async ({ ctx, body }) => {
    const { scheduledPaymentId, source, ...input } = body;
    return createTransaction(ctx, input, { source, scheduledPaymentId, checkDuplicates: source !== "MANUAL" });
  },
);
