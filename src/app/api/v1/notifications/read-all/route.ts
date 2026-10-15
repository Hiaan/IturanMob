import { authed } from "@/server/api/handler";
import { markAllRead } from "@/server/modules/notifications/service";

/** POST → { updated } */
export const POST = authed({}, async ({ ctx }) => markAllRead(ctx));
