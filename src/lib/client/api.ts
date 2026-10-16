"use client";

/** Cliente HTTP da API interna. Respostas no formato { data } / { error }. */
export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  issues?: Array<{ path: string; message: string }>;
  constructor(status: number, code: string, message: string, details?: unknown, issues?: Array<{ path: string; message: string }>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.issues = issues;
  }
}

type Params = Record<string, unknown> | undefined;

function buildUrl(path: string, params?: Params): string {
  if (!params) return path;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    clean[k] = v;
  }
  if (!Object.keys(clean).length) return path;
  return `${path}${path.includes("?") ? "&" : "?"}q=${encodeURIComponent(JSON.stringify(clean))}`;
}

async function request<T>(method: string, path: string, opts: { params?: Params; body?: unknown } = {}): Promise<T> {
  const res = await fetch(buildUrl(path, opts.params), {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "fetch",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
    throw new ApiError(401, "UNAUTHORIZED", "Sessão expirada.");
  }
  let payload: { data?: T; error?: { code: string; message: string; details?: unknown; issues?: Array<{ path: string; message: string }> } } = {};
  try {
    payload = await res.json();
  } catch {
    if (!res.ok) throw new ApiError(res.status, "HTTP_ERROR", "Falha de comunicação com o servidor.");
  }
  if (!res.ok || payload.error) {
    const e = payload.error;
    throw new ApiError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? "Erro inesperado.", e?.details, e?.issues);
  }
  return payload.data as T;
}

export const api = {
  get: <T>(path: string, params?: Params) => request<T>("GET", path, { params }),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body: body ?? {} }),
  delete: <T>(path: string, params?: Params) => request<T>("DELETE", path, { params }),
  /** DELETE com corpo JSON (rotas que identificam o recurso no corpo, ex.: inscrição de push). */
  deleteJson: <T>(path: string, body: unknown) => request<T>("DELETE", path, { body }),
  url: buildUrl,
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Erro inesperado.";
}

/** Baixa um arquivo gerado pela API (relatórios/exportações). */
export async function downloadFile(path: string, params?: Params, fallbackName = "arquivo") {
  const res = await fetch(buildUrl(path, params), { credentials: "same-origin" });
  if (!res.ok) {
    let message = "Não foi possível gerar o arquivo.";
    try {
      message = (await res.json()).error?.message ?? message;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, "DOWNLOAD_FAILED", message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match?.[1] ? decodeURIComponent(match[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
