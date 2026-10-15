import { authed } from "@/server/api/handler";
import { markRead } from "@/server/modules/notifications/service";

export const POST = authed({}, async ({ ctx, params }) => markRead(ctx, params.id!));
