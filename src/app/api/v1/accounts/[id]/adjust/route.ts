import { z } from "zod";
import { authed } from "@/server/api/handler";
import { adjustBalance } from "@/server/modules/accounts/service";
import { isoDateSchema } from "@/server/modules/transactions/schemas";

const schema = z.object({
  targetBalanceCents: z.number().int().min(-10_000_000_000).max(10_000_000_000),
  date: isoDateSchema.optional(),
  note: z.string().max(200).optional(),
});

export const POST = authed({ body: schema, permission: "accounts:write" }, async ({ ctx, params, body }) => adjustBalance(ctx, params.id!, body));
