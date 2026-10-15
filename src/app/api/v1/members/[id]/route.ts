import { authed } from "@/server/api/handler";
import { memberUpdateSchema, updateMember } from "@/server/modules/households/service";

export const PATCH = authed({ body: memberUpdateSchema }, async ({ ctx, params, body }) => updateMember(ctx, params.id!, body));
