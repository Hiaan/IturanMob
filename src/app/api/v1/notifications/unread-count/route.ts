import { authed } from "@/server/api/handler";
import { unreadCount } from "@/server/modules/notifications/service";

/** GET → { count } */
export const GET = authed({}, async ({ ctx }) => ({ count: await unreadCount(ctx) }));
