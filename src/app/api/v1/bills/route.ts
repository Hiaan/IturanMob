import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { BILL_STATUSES, billCreateSchema, createBill, listBills } from "@/server/modules/bills/service";
import { isoDateSchema } from "@/server/modules/transactions/schemas";

const query = z.object({
  start: isoDateSchema.optional(),
  end: isoDateSchema.optional(),
  month: z.string().optional(),
  status: qs.list(z.enum(BILL_STATUSES)),
  type: z.enum(["EXPENSE", "INCOME"]).optional(),
  includeStatements: qs.bool(),
  includeOverdue: qs.bool(),
  search: z.string().trim().max(120).optional(),
});

/** GET ?start&end|month&status=PENDING&status=OVERDUE&type&includeStatements&includeOverdue&search */
export const GET = authed({ query }, async ({ ctx, query }) =>
  listBills(ctx, {
    start: query.start,
    end: query.end,
    month: query.month,
    statuses: query.status,
    type: query.type,
    includeStatements: query.includeStatements,
    includeOverdue: query.includeOverdue,
    search: query.search,
  }),
);

/** POST { type?, description, amountCents, isEstimate?, dueDate, categoryId?, accountId?, creditCardId?, notes? } */
export const POST = authed({ body: billCreateSchema, permission: "bills:write" }, async ({ ctx, body }) => createBill(ctx, body));
