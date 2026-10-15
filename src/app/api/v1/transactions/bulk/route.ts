import { z } from "zod";
import { authed } from "@/server/api/handler";
import { bulkReclassify, confirmTransaction, deleteTransaction, restoreTransaction } from "@/server/modules/transactions/service";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reclassify"), ids: z.array(z.string()).min(1).max(500), categoryId: z.string(), subcategoryId: z.string().nullish() }),
  z.object({ action: z.literal("delete"), ids: z.array(z.string()).min(1).max(200) }),
  z.object({ action: z.literal("restore"), ids: z.array(z.string()).min(1).max(200) }),
  z.object({ action: z.literal("confirm"), ids: z.array(z.string()).min(1).max(200) }),
]);

export const POST = authed({ body: schema, permission: "transactions:write" }, async ({ ctx, body }) => {
  switch (body.action) {
    case "reclassify":
      return bulkReclassify(ctx, body.ids, body.categoryId, body.subcategoryId ?? null);
    case "delete":
      for (const id of body.ids) await deleteTransaction(ctx, id);
      return { updated: body.ids.length };
    case "restore":
      for (const id of body.ids) await restoreTransaction(ctx, id);
      return { updated: body.ids.length };
    case "confirm":
      for (const id of body.ids) await confirmTransaction(ctx, id);
      return { updated: body.ids.length };
  }
});
