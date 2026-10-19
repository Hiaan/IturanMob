import { authed } from "@/server/api/handler";
import { getMigration } from "@/server/modules/migration/service";

export const GET = authed({ permission: "transactions:read" }, async ({ ctx, params }) => getMigration(ctx, params.id!));
