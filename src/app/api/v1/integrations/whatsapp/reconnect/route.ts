import { authed } from "@/server/api/handler";
import { requestReconnect } from "@/server/whatsapp/service";

export const POST = authed({ permission: "integrations:manage" }, async ({ ctx }) => requestReconnect(ctx));
