import { authed } from "@/server/api/handler";
import { commitImport } from "@/server/modules/imports/service";

export const POST = authed({ permission: "data:import", rateLimit: { key: "imports:commit", limit: 10, windowSeconds: 60 } }, async ({ ctx, params }) => commitImport(ctx, params.id!));
