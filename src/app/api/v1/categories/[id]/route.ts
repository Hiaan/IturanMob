import { z } from "zod";
import { authed } from "@/server/api/handler";
import { categoryUpdateSchema, deleteCategory, updateCategory } from "@/server/modules/categories/service";

export const PATCH = authed({ body: categoryUpdateSchema, permission: "categories:write" }, async ({ ctx, params, body }) => updateCategory(ctx, params.id!, body));
export const DELETE = authed(
  { query: z.object({ moveToCategoryId: z.string().optional() }), permission: "categories:write" },
  async ({ ctx, params, query }) => {
    await deleteCategory(ctx, params.id!, { moveToCategoryId: query.moveToCategoryId });
    return { ok: true };
  },
);
