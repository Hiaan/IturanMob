import { authed } from "@/server/api/handler";
import { requestLogout } from "@/server/whatsapp/service";

export const POST = authed({ permission: "integrations:manage" }, async ({ ctx }) => requestLogout(ctx));
