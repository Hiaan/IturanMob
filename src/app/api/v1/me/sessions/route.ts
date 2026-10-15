import { authed } from "@/server/api/handler";
import { listUserSessions } from "@/server/auth/service";

export const GET = authed({}, async ({ ctx, session }) => listUserSessions(ctx, session.sessionId));
