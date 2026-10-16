import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PREFIXES = [
  "/login",
  "/cadastro",
  "/convite",
  "/api/auth",
  "/api/health",
  "/api/webhooks",
  "/_next",
  "/favicon",
  // App instalável: manifest, service worker, ícones e a página offline (sem dados).
  "/manifest.webmanifest",
  "/sw.js",
  "/icons/",
  "/apple-icon",
  "/offline",
];

/**
 * Redireciona para o login quando não há cookie de sessão (verificação rápida).
 * A validação real da sessão acontece no servidor (layout e rotas de API).
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.next();
  if (!req.cookies.get("fa_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
