import { NextResponse, type NextRequest } from "next/server";
import { revokeSession, SESSION_COOKIE } from "@/server/auth/session";
import { errorResponse } from "@/server/api/handler";

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (token) await revokeSession(token);
    const res = NextResponse.json({ data: { ok: true } });
    res.cookies.set({ name: SESSION_COOKIE, value: "", path: "/", expires: new Date(0) });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
