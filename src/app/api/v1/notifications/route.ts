import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { listForMember } from "@/server/modules/notifications/service";

const query = z.object({
  unreadOnly: qs.bool(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(64).optional(),
});

/** GET ?unreadOnly=&limit=&cursor= → { items, nextCursor, unreadCount } */
export const GET = authed({ query }, async ({ ctx, query }) => listForMember(ctx, query));
