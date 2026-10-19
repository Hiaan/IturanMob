import { authed } from "@/server/api/handler";
import { listMigrationTemplates } from "@/server/modules/migration/service";

export const GET = authed({ permission: "transactions:read" }, async ({ ctx }) => listMigrationTemplates(ctx));
