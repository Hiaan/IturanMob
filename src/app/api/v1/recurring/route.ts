import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { createRecurring, listRecurring, recurringCreateSchema } from "@/server/modules/recurring/service";

const query = z.object({ active: qs.bool(), type: z.enum(["EXPENSE", "INCOME"]).optional() });

/** GET ?active=&type= → recorrências com próxima ocorrência e total mensal equivalente. */
export const GET = authed({ query }, async ({ ctx, query }) => listRecurring(ctx, query));

/** POST → cria a recorrência e gera as ocorrências previstas dos próximos 60 dias. */
export const POST = authed({ body: recurringCreateSchema, permission: "bills:write" }, async ({ ctx, body }) => createRecurring(ctx, body));
