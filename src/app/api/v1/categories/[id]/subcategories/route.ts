import { authed } from "@/server/api/handler";
import { createSubcategory, subcategorySchema } from "@/server/modules/categories/service";

export const POST = authed({ body: subcategorySchema, permission: "categories:write" }, async ({ ctx, params, body }) => createSubcategory(ctx, params.id!, body));
