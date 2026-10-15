import { authed } from "@/server/api/handler";
import { retryAllFailed } from "@/server/whatsapp/processor";

export const POST = authed({ permission: "integrations:manage" }, async ({ ctx }) => retryAllFailed(ctx));
