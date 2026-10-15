import { authed } from "@/server/api/handler";
import { requestConnect } from "@/server/whatsapp/service";

export const POST = authed({ permission: "integrations:manage" }, async ({ ctx }) => requestConnect(ctx));
