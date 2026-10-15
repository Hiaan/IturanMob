import { NextResponse } from "next/server";
import { publicRoute, sessionCookieOptions, clientIp } from "@/server/api/handler";
import { login, loginSchema } from "@/server/auth/service";

export const POST = publicRoute({ body: loginSchema }, async ({ req, body }) => {
  const result = await login(body, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  const res = NextResponse.json({ data: { user: result.user } }, { status: 200 });
  res.cookies.set({ ...sessionCookieOptions(result.expiresAt), value: result.token });
  return res;
});
