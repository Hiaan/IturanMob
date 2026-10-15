import { authed } from "@/server/api/handler";
import { payStatement, payStatementSchema } from "@/server/modules/cards/service";

export const POST = authed({ body: payStatementSchema, permission: "transactions:write" }, async ({ ctx, params, body }) => payStatement(ctx, params.id!, body));
