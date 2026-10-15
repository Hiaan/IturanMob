import { authed } from "@/server/api/handler";
import { requestGroupSync } from "@/server/whatsapp/service";

export const POST = authed({ permission: "integrations:manage" }, async ({ ctx }) => requestGroupSync(ctx));
