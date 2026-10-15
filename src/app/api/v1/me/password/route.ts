import { authed } from "@/server/api/handler";
import { changePassword, changePasswordSchema } from "@/server/auth/service";

export const POST = authed(
  { body: changePasswordSchema, rateLimit: { key: "password", limit: 10, windowSeconds: 900 } },
  async ({ ctx, session, body }) => changePassword(ctx, session.sessionId, body),
);
