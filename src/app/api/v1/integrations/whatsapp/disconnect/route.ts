import { authed } from "@/server/api/handler";
import { requestDisconnect } from "@/server/whatsapp/service";

export const POST = authed({ permission: "integrations:manage" }, async ({ ctx }) => requestDisconnect(ctx));
