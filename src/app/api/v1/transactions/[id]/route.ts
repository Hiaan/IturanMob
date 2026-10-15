import { authed } from "@/server/api/handler";
import { deleteTransaction, getTransaction, updateTransaction } from "@/server/modules/transactions/service";
import { transactionUpdateSchema } from "@/server/modules/transactions/schemas";

export const GET = authed({}, async ({ ctx, params }) => getTransaction(ctx, params.id!));
export const PATCH = authed({ body: transactionUpdateSchema, permission: "transactions:write" }, async ({ ctx, params, body }) =>
  updateTransaction(ctx, params.id!, body),
);
export const DELETE = authed({ permission: "transactions:delete" }, async ({ ctx, params }) => {
  await deleteTransaction(ctx, params.id!);
  return { ok: true };
});
