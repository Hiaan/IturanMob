import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { resolveSession, SESSION_COOKIE, type SessionInfo } from "../auth/session";
import { assertCan, type Permission } from "../auth/permissions";
import type { ServiceContext } from "../auth/context";
import { AppError, ForbiddenError, UnauthorizedError } from "../errors";
import { enforceRateLimit } from "../rate-limit";
import { env } from "../env";
import { errorInfo, logger } from "../logger";

type RouteParams = Record<string, string>;

interface HandlerArgs<Q, B> {
  req: NextRequest;
  query: Q;
  body: B;
  params: RouteParams;
}

interface AuthedArgs<Q, B> extends HandlerArgs<Q, B> {
  ctx: ServiceContext;
  session: SessionInfo;
}

interface RouteOptions<QS extends z.ZodType | undefined, BS extends z.ZodType | undefined> {
  query?: QS;
  body?: BS;
  permission?: Permission;
  /** Limite de requisições por minuto por usuário/IP (padrão: RATE_LIMIT_API_PER_MIN). */
  /** `limit` pode ser uma função para ler a configuração só na requisição (não no build). */
  rateLimit?: { key: string; limit: number | (() => number); windowSeconds: number };
}

type Infer<S> = S extends z.ZodType ? z.output<S> : undefined;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip");
}

const resolveLimit = (limit: number | (() => number)) => (typeof limit === "function" ? limit() : limit);

/** Proteção CSRF: requisições que alteram dados precisam vir da mesma origem. */
function assertSameOrigin(req: NextRequest) {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin) {
    // Navegadores modernos sempre enviam Origin em requisições fetch que alteram dados.
    if (req.headers.get("sec-fetch-site") && req.headers.get("sec-fetch-site") !== "same-origin") throw new ForbiddenError("Origem não permitida.");
    if (env().NODE_ENV === "production" && !req.headers.get("x-requested-with")) throw new ForbiddenError("Origem não permitida.");
    return;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError("Origem não permitida.");
  }
  const appHost = new URL(env().APP_URL).host;
  if (originHost !== host && originHost !== appHost) throw new ForbiddenError("Origem não permitida.");
}

function parseQueryParams(req: NextRequest): Record<string, unknown> {
  const sp = req.nextUrl.searchParams;
  const result: Record<string, unknown> = {};
  const q = sp.get("q");
  if (q) {
    try {
      Object.assign(result, JSON.parse(q));
    } catch {
      throw new AppError("Parâmetro de consulta inválido.", { status: 400, code: "BAD_QUERY" });
    }
  }
  for (const key of new Set(sp.keys())) {
    if (key === "q") continue;
    const values = sp.getAll(key);
    result[key] = values.length > 1 ? values : values[0];
  }
  return result;
}

async function readBody(req: NextRequest): Promise<unknown> {
  if (!MUTATING.has(req.method)) return undefined;
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return undefined;
  const text = await req.text();
  if (!text) return undefined;
  if (text.length > 2_000_000) throw new AppError("Requisição muito grande.", { status: 413, code: "PAYLOAD_TOO_LARGE" });
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("JSON inválido.", { status: 400, code: "BAD_JSON" });
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: issues[0]?.message ?? "Dados inválidos.", issues } }, { status: 422 });
  }
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (err.status === 429) headers["Retry-After"] = String((err.details as { retryAfterSeconds?: number })?.retryAfterSeconds ?? 60);
    return NextResponse.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, { status: err.status, headers });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return NextResponse.json({ error: { code: "CONFLICT", message: "Registro duplicado." } }, { status: 409 });
    if (err.code === "P2025") return NextResponse.json({ error: { code: "NOT_FOUND", message: "Registro não encontrado." } }, { status: 404 });
    if (err.code === "P2003") return NextResponse.json({ error: { code: "CONFLICT", message: "Registro vinculado a outros dados." } }, { status: 409 });
  }
  logger.error({ err: errorInfo(err) }, "api: erro inesperado");
  return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Ocorreu um erro inesperado. Tente novamente." } }, { status: 500 });
}

function json(data: unknown, status = 200): NextResponse {
  if (data instanceof Response) return data as NextResponse;
  return NextResponse.json({ data: data ?? null }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Rota autenticada: valida sessão, permissão, CSRF, rate limit e entradas (Zod). */
export function authed<QS extends z.ZodType | undefined = undefined, BS extends z.ZodType | undefined = undefined>(
  opts: RouteOptions<QS, BS>,
  handler: (args: AuthedArgs<Infer<QS>, Infer<BS>>) => Promise<unknown>,
) {
  return async (req: NextRequest, routeCtx: { params: Promise<RouteParams> }) => {
    try {
      assertSameOrigin(req);
      const session = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
      if (!session) throw new UnauthorizedError();
      const ctx: ServiceContext = { ...session.ctx, ip: clientIp(req) };
      if (opts.permission) assertCan(ctx, opts.permission);
      const rl = opts.rateLimit ?? { key: "api", limit: env().RATE_LIMIT_API_PER_MIN, windowSeconds: 60 };
      await enforceRateLimit(`${rl.key}:${session.user.id}`, resolveLimit(rl.limit), rl.windowSeconds);
      const params = (await routeCtx.params) ?? {};
      const query = opts.query ? opts.query.parse(parseQueryParams(req)) : undefined;
      const rawBody = await readBody(req);
      const body = opts.body ? opts.body.parse(rawBody ?? {}) : undefined;
      const result = await handler({ req, ctx, session, params, query: query as Infer<QS>, body: body as Infer<BS> });
      return json(result, req.method === "POST" ? 201 : 200);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Rota pública (login, cadastro, webhooks): ainda aplica CSRF, rate limit e validação. */
export function publicRoute<QS extends z.ZodType | undefined = undefined, BS extends z.ZodType | undefined = undefined>(
  opts: RouteOptions<QS, BS> & { skipOriginCheck?: boolean },
  handler: (args: HandlerArgs<Infer<QS>, Infer<BS>>) => Promise<unknown>,
) {
  return async (req: NextRequest, routeCtx: { params: Promise<RouteParams> }) => {
    try {
      if (!opts.skipOriginCheck) assertSameOrigin(req);
      if (opts.rateLimit) await enforceRateLimit(`${opts.rateLimit.key}:${clientIp(req) ?? "unknown"}`, resolveLimit(opts.rateLimit.limit), opts.rateLimit.windowSeconds);
      const params = (await routeCtx.params) ?? {};
      const query = opts.query ? opts.query.parse(parseQueryParams(req)) : undefined;
      const rawBody = await readBody(req);
      const body = opts.body ? opts.body.parse(rawBody ?? {}) : undefined;
      const result = await handler({ req, params, query: query as Infer<QS>, body: body as Infer<BS> });
      return json(result, req.method === "POST" ? 201 : 200);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function sessionCookieOptions(expiresAt: Date) {
  const secure = env().SECURE_COOKIES || env().APP_URL.startsWith("https://");
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/** Helpers de schema para parâmetros de consulta (strings → tipos). */
export const qs = {
  int: (def: number) => z.coerce.number().int().default(def),
  optInt: () => z.coerce.number().int().optional(),
  bool: () =>
    z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === true || v === "true" || v === "1")),
  list: <T extends z.ZodType>(item: T) =>
    z
      .union([z.array(item), item])
      .optional()
      .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
};
