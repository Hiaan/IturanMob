import { z } from "zod";
import { authed } from "@/server/api/handler";
import { purgeTransaction } from "@/server/modules/transactions/service";

export const POST = authed({ body: z.object({ confirmation: z.string() }), permission: "transactions:delete" }, async ({ ctx, params, body }) => {
  await purgeTransaction(ctx, params.id!, body.confirmation);
  return { ok: true };
});
