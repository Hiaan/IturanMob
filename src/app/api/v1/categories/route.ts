import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { categorySchema, createCategory, listCategories } from "@/server/modules/categories/service";

export const GET = authed({ query: z.object({ includeArchived: qs.bool(), kind: z.enum(["EXPENSE", "INCOME"]).optional() }) }, async ({ ctx, query }) =>
  listCategories(ctx, query),
);
export const POST = authed({ body: categorySchema, permission: "categories:write" }, async ({ ctx, body }) => createCategory(ctx, body));
