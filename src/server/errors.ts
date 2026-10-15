/** Erros de domínio mapeados para respostas HTTP pela camada de API. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, opts?: { status?: number; code?: string; details?: unknown }) {
    super(message);
    this.name = "AppError";
    this.status = opts?.status ?? 400;
    this.code = opts?.code ?? "BAD_REQUEST";
    this.details = opts?.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 422, code: "VALIDATION_ERROR", details });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Registro") {
    super(`${what} não encontrado(a).`, { status: 404, code: "NOT_FOUND" });
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Sessão expirada ou inválida. Faça login novamente.") {
    super(message, { status: 401, code: "UNAUTHORIZED" });
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Você não tem permissão para esta ação.") {
    super(message, { status: 403, code: "FORBIDDEN" });
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 409, code: "CONFLICT", details });
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds: number) {
    super("Muitas tentativas. Aguarde um pouco e tente novamente.", {
      status: 429,
      code: "RATE_LIMITED",
      details: { retryAfterSeconds },
    });
    this.name = "RateLimitError";
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
