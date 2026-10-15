import { NextResponse, type NextRequest } from "next/server";
import { login } from "@/server/auth/service";
import { clientIp, sessionCookieOptions } from "@/server/api/handler";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";

/**
 * Fallback sem JavaScript do formulário de login (POST application/x-www-form-urlencoded).
 * Garante que credenciais nunca trafeguem na URL, mesmo antes da hidratação da página.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const appOrigin = new URL(env().APP_URL).origin;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && new URL(origin).host !== host && origin !== appOrigin) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Origem não permitida." } }, { status: 403 });
  }
  const form = await req.formData();
  const next = String(form.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  try {
    const result = await login(
      { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") },
      { ip: clientIp(req), userAgent: req.headers.get("user-agent") },
    );
    const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
    res.cookies.set({ ...sessionCookieOptions(result.expiresAt), value: result.token });
    return res;
  } catch (err) {
    const message = err instanceof AppError ? err.message : "Não foi possível entrar.";
    const url = new URL("/login", req.url);
    url.searchParams.set("erro", message);
    return NextResponse.redirect(url, 303);
  }
}
