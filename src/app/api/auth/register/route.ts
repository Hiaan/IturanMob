import { NextResponse } from "next/server";
import { publicRoute, sessionCookieOptions, clientIp } from "@/server/api/handler";
import { registerHousehold, registerSchema } from "@/server/modules/households/service";
import { createSession } from "@/server/auth/session";
import { env } from "@/server/env";

export const POST = publicRoute({ body: registerSchema, rateLimit: { key: "register", limit: () => env().RATE_LIMIT_REGISTER_PER_HOUR, windowSeconds: 3600 } }, async ({ req, body }) => {
  const { user, household } = await registerHousehold(body);
  const session = await createSession({ userId: user.id, householdId: household.id, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  const res = NextResponse.json({ data: { user: { id: user.id, name: user.name, email: user.email } } }, { status: 201 });
  res.cookies.set({ ...sessionCookieOptions(session.expiresAt), value: session.token });
  return res;
});
