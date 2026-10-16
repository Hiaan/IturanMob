import { z } from "zod";
import { authed } from "@/server/api/handler";
import { listPendingItems } from "@/server/modules/pending/service";

const schema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
  type: z
    .enum(["CONFIRMATION", "UNCATEGORIZED", "MISSING_PAYMENT_METHOD", "POSSIBLE_DUPLICATE", "UNREADABLE_RECEIPT", "PROCESSING_FAILED", "IMPORT_DIVERGENCE", "INSTALLMENT_INCONSISTENT", "CLARIFICATION", "NATURE_REVIEW"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const GET = authed({ query: schema }, async ({ ctx, query }) => listPendingItems(ctx, query));
