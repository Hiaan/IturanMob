import { NextResponse } from "next/server";
import { publicRoute, sessionCookieOptions, clientIp } from "@/server/api/handler";
import { acceptInvitation, acceptInviteSchema } from "@/server/modules/households/service";
import { createSession } from "@/server/auth/session";

export const POST = publicRoute({ body: acceptInviteSchema, rateLimit: { key: "invite-accept", limit: 10, windowSeconds: 600 } }, async ({ req, body }) => {
  const { user, householdId } = await acceptInvitation(body);
  const session = await createSession({ userId: user.id, householdId, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  const res = NextResponse.json({ data: { user: { id: user.id, name: user.name } } }, { status: 201 });
  res.cookies.set({ ...sessionCookieOptions(session.expiresAt), value: session.token });
  return res;
});
