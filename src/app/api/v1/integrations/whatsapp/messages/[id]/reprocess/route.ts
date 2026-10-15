import { authed } from "@/server/api/handler";
import { reprocessMessage } from "@/server/whatsapp/processor";

export const POST = authed({ permission: "integrations:manage" }, async ({ ctx, params }) => reprocessMessage(ctx, params.id!));
