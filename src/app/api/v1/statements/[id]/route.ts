import { authed } from "@/server/api/handler";
import { getStatement } from "@/server/modules/cards/service";

export const GET = authed({}, async ({ ctx, params }) => getStatement(ctx, params.id!));
