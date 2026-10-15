import { authed } from "@/server/api/handler";
import { revokeUserSession } from "@/server/auth/service";

export const DELETE = authed({}, async ({ ctx, params }) => {
  await revokeUserSession(ctx, params.id!);
  return { ok: true };
});
