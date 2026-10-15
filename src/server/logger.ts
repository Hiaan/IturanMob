import pino from "pino";

/**
 * Logs estruturados. Nunca registrar tokens, senhas, chaves de API, sessões do WhatsApp,
 * transcrições ou conteúdo de mensagens. A redação abaixo é uma rede de segurança adicional.
 */
const REDACT = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "apiKey",
  "authorization",
  "cookie",
  "secret",
  "text",
  "transcription",
  "content",
  "creds",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.apiKey",
  "*.authorization",
  "*.cookie",
  "*.secret",
  "*.text",
  "*.transcription",
  "*.content",
  "*.creds",
  "req.headers.cookie",
  "req.headers.authorization",
];

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");
const pretty = process.env.NODE_ENV === "development" && process.env.LOG_PRETTY !== "0" && typeof window === "undefined";

export const logger = pino({
  level,
  base: { service: process.env.SERVICE_NAME ?? "finance-ai" },
  redact: { paths: REDACT, censor: "[REDACTED]" },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,service" },
        },
      }
    : {}),
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

/** Serializa erros sem vazar dados sensíveis. */
export function errorInfo(err: unknown): { name: string; message: string; code?: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message.slice(0, 500),
      code: (err as { code?: string }).code,
      stack: process.env.NODE_ENV === "production" ? undefined : err.stack?.split("\n").slice(0, 6).join("\n"),
    };
  }
  return { name: "Unknown", message: String(err).slice(0, 500) };
}
