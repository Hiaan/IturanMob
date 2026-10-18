import { authed } from "@/server/api/handler";
import { quickCategorySchema, quickCreateCategory } from "@/server/modules/categories/service";

/** "+ Nova categoria" nos seletores: cria (ou reaproveita) e devolve o que selecionar. */
export const POST = authed({ body: quickCategorySchema, permission: "categories:write" }, async ({ ctx, body }) => quickCreateCategory(ctx, body));
