import { authed } from "@/server/api/handler";
import { deleteSubcategory, subcategoryUpdateSchema, updateSubcategory } from "@/server/modules/categories/service";

export const PATCH = authed({ body: subcategoryUpdateSchema, permission: "categories:write" }, async ({ ctx, params, body }) => updateSubcategory(ctx, params.id!, body));
export const DELETE = authed({ permission: "categories:write" }, async ({ ctx, params }) => {
  await deleteSubcategory(ctx, params.id!);
  return { ok: true };
});
