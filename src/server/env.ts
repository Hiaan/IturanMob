import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET deve ter ao menos 32 caracteres"),
  /** Chave AES-256 em base64 (32 bytes). Gere com: openssl rand -base64 32 */
  ENCRYPTION_KEY: z.string().min(40, "ENCRYPTION_KEY deve ser 32 bytes em base64"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ALLOW_REGISTRATION: bool(false),
  /**
   * E-mails (separados por vírgula) do administrador da instância: quem pode gerar convites de uso
   * único para criar uma NOVA família. Vazio = o proprietário da primeira família criada.
   */
  INSTANCE_ADMIN_EMAILS: z.string().default(""),
  SECURE_COOKIES: bool(false),
  DEFAULT_TIMEZONE: z.string().default("America/Recife"),
  STORAGE_DIR: z.string().default("./storage"),
  BACKUP_DIR: z.string().default("./backups"),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(0).default(24),
  BACKUP_KEEP: z.coerce.number().int().min(1).default(14),
  /** Caminhos dos binários do PostgreSQL usados pelos backups (versão >= servidor). */
  PG_DUMP_PATH: z.string().default("pg_dump"),
  PG_RESTORE_PATH: z.string().default("pg_restore"),

  // IA
  /** Teto mensal de pedidos ao assistente conversacional (WhatsApp + app) por família. 0 desliga o assistente. */
  AGENT_MONTHLY_LIMIT: z.coerce.number().int().min(0).default(300),
  AI_DEFAULT_PROVIDER: z.enum(["LOCAL", "ANTHROPIC", "OPENAI", "OPENAI_COMPATIBLE"]).default("LOCAL"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_FAST_MODEL: z.string().default("claude-haiku-5-5"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
  OPENAI_COMPATIBLE_MODEL: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().default(45000),

  // Transcrição
  TRANSCRIPTION_PROVIDER: z.enum(["none", "openai", "openai_compatible"]).default("none"),
  TRANSCRIPTION_API_KEY: z.string().optional(),
  TRANSCRIPTION_BASE_URL: z.string().optional(),
  TRANSCRIPTION_MODEL: z.string().default("whisper-1"),
  /** Modelo do Whisper próprio (serviço "whisper" do docker-compose): tiny, base, small, medium… */
  WHISPER_MODEL: z.string().regex(/^[a-z0-9.-]+$/).default("base"),
  /** Tempo máximo de uma transcrição (áudio de 1–2 min em CPU leva até ~1 min no modelo base). */
  TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(900_000).default(120_000),
  /** Áudio mais longo que isto não é transcrito (o bot pede para mandar em partes). 0 = sem limite. */
  TRANSCRIPTION_MAX_SECONDS: z.coerce.number().int().min(0).max(7_200).default(300),
  /** Transcrições ao mesmo tempo neste processo (1 = fila: uma por vez). */
  TRANSCRIPTION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  FFMPEG_PATH: z.string().default("ffmpeg"),

  // Open Finance (Meu Pluggy). O simulador traz dados de exemplo, nunca de um banco real.
  PLUGGY_API_URL: z.string().url().default("https://api.pluggy.ai"),
  OPEN_FINANCE_SIMULATOR: bool(false),
  // Google Agenda: o simulador traz eventos de exemplo (nenhuma conta Google real).
  GOOGLE_CALENDAR_SIMULATOR: bool(false),
  // Site de vendas (página pública em "/" para quem não está logado).
  /** WhatsApp de vendas, só números com DDI (ex.: 5581999999999). Sem ele, o site não mostra "Quero contratar". */
  SITE_CONTACT_WHATSAPP: z.string().regex(/^\d{12,13}$/, "Use só números com DDI e DDD").optional(),
  // WhatsApp
  WHATSAPP_DEFAULT_PROVIDER: z.enum(["SIMULATOR", "BAILEYS", "CLOUD_API"]).default("SIMULATOR"),
  WHATSAPP_ENABLE_SIMULATOR: bool(true),
  WHATSAPP_BOT_PREFIX: z.string().default("🤖"),
  WHATSAPP_CLOUD_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_CLOUD_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_APP_SECRET: z.string().optional(),
  WHATSAPP_CLOUD_API_VERSION: z.string().default("v21.0"),
  WHATSAPP_CLOUD_HOUSEHOLD_ID: z.string().optional(),

  // Notificações push (Web Push). Gere as chaves no servidor com `pnpm vapid:generate`.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Contato do responsável pelo envio (mailto: ou https:), exigido pelos serviços de push. */
  VAPID_SUBJECT: z.string().optional(),

  // Rendimento automático de investimentos (taxas públicas do Banco Central, sem credencial)
  INVESTMENT_YIELD_ENABLED: bool(true),
  BCB_SGS_URL: z.string().url().default("https://api.bcb.gov.br/dados/serie/bcdata.sgs"),

  // Worker
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  RATE_LIMIT_LOGIN_PER_15MIN: z.coerce.number().int().default(10),
  RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().default(300),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/** Lê e valida as variáveis de ambiente (memoizado). Nunca registrar o resultado em logs. */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache() {
  cached = null;
}

export const isProduction = () => env().NODE_ENV === "production";
export const isTest = () => env().NODE_ENV === "test";
