import { z } from "zod";
import { authed } from "@/server/api/handler";
import { setRecurringActive } from "@/server/modules/recurring/service";

/** POST { active? } — sem `active`, inverte o estado atual. */
export const POST = authed({ body: z.object({ active: z.boolean().optional() }), permission: "bills:write" }, async ({ ctx, params, body }) =>
  setRecurringActive(ctx, params.id!, body.active),
);
