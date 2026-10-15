import { z } from "zod";
import { authed } from "@/server/api/handler";
import { setPendingStatus } from "@/server/modules/pending/service";

export const PATCH = authed(
  { body: z.object({ status: z.enum(["RESOLVED", "DISMISSED"]), resolution: z.string().max(300).optional() }), permission: "transactions:write" },
  async ({ ctx, params, body }) => setPendingStatus(ctx, params.id!, body.status, body.resolution),
);
