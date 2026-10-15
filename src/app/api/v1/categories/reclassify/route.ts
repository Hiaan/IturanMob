import { z } from "zod";
import { authed } from "@/server/api/handler";
import { reclassifyCategory } from "@/server/modules/categories/service";

const schema = z.object({
  fromCategoryId: z.string(),
  fromSubcategoryId: z.string().nullish(),
  toCategoryId: z.string(),
  toSubcategoryId: z.string().nullish(),
});

export const POST = authed({ body: schema, permission: "transactions:write" }, async ({ ctx, body }) =>
  reclassifyCategory(ctx, body.fromCategoryId, body.toCategoryId, body.toSubcategoryId ?? null, body.fromSubcategoryId ?? null),
);
