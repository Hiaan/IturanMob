import { authed } from "@/server/api/handler";
import { deleteRecurring, getRecurring, recurringUpdateSchema, updateRecurring } from "@/server/modules/recurring/service";

export const GET = authed({}, async ({ ctx, params }) => getRecurring(ctx, params.id!));

/** PATCH → edita o modelo; somente ocorrências futuras pendentes são regeneradas. */
export const PATCH = authed({ body: recurringUpdateSchema, permission: "bills:write" }, async ({ ctx, params, body }) => updateRecurring(ctx, params.id!, body));

export const DELETE = authed({ permission: "bills:write" }, async ({ ctx, params }) => deleteRecurring(ctx, params.id!));
