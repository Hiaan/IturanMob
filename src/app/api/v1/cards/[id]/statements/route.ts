import { authed } from "@/server/api/handler";
import { listStatements } from "@/server/modules/cards/service";

export const GET = authed({}, async ({ ctx, params }) => listStatements(ctx, params.id!));
