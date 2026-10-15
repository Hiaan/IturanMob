/**
 * Preparação do ambiente: pnpm run setup
 *
 * 1. Cria o .env a partir do .env.example (se ainda não existir).
 * 2. Gera segredos aleatórios para SESSION_SECRET, ENCRYPTION_KEY e POSTGRES_PASSWORD
 *    — apenas quando estão vazios. Nunca sobrescreve um valor já definido.
 * 3. Valida a configuração e testa a conexão com PostgreSQL e Redis (sem falhar se estiverem fora).
 *
 * Nada aqui imprime segredos.
 */
import { existsSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

function log(msg: string) {
  console.log(`[setup] ${msg}`);
}

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    console.error("[setup] .env.example não encontrado. Execute na raiz do projeto.");
    process.exit(1);
  }
  copyFileSync(examplePath, envPath);
  log(".env criado a partir do .env.example");
}

const generators: Record<string, () => string> = {
  SESSION_SECRET: () => randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
  POSTGRES_PASSWORD: () => randomBytes(24).toString("hex"),
};

let content = readFileSync(envPath, "utf8");
const generated: string[] = [];
for (const [key, gen] of Object.entries(generators)) {
  const re = new RegExp(`^${key}=(.*)$`, "m");
  const match = content.match(re);
  if (!match) {
    content += `\n${key}=${gen()}\n`;
    generated.push(key);
  } else if (!match[1]!.trim()) {
    content = content.replace(re, `${key}=${gen()}`);
    generated.push(key);
  }
}
if (generated.length) {
  writeFileSync(envPath, content, { mode: 0o600 });
  log(`segredos gerados: ${generated.join(", ")}`);
}
try {
  chmodSync(envPath, 0o600);
} catch {
  // sistemas sem permissões POSIX
}

// Carrega o .env no processo para validar.
if (typeof process.loadEnvFile === "function") process.loadEnvFile(envPath);

const { env } = await import("../src/server/env");
let ok = true;
try {
  const e = env();
  log(`configuração válida (NODE_ENV=${e.NODE_ENV}, IA padrão=${e.AI_DEFAULT_PROVIDER}, WhatsApp=${e.WHATSAPP_DEFAULT_PROVIDER})`);
  if (e.NODE_ENV === "production") {
    if (e.WHATSAPP_ENABLE_SIMULATOR) log("AVISO: desative WHATSAPP_ENABLE_SIMULATOR em produção.");
    if (e.ALLOW_REGISTRATION) log("AVISO: ALLOW_REGISTRATION=true permite que qualquer pessoa crie uma família.");
    if (!e.APP_URL.startsWith("https://")) log("AVISO: em produção use APP_URL com https:// (cookies seguros).");
  }
} catch (err) {
  ok = false;
  console.error(`[setup] ${(err as Error).message}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("tempo esgotado")), ms))]);
}

if (ok) {
  try {
    const { prisma } = await import("../src/server/db");
    await withTimeout(prisma.$queryRaw`SELECT 1`, 5000);
    const migrations = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`.catch(() => null);
    log(`PostgreSQL: conectado${migrations ? ` (${migrations[0]?.count ?? 0} migrations aplicadas)` : " (migrations ainda não aplicadas: pnpm db:deploy)"}`);
    await prisma.$disconnect();
  } catch (err) {
    log(`PostgreSQL: indisponível (${(err as Error).message.split("\n")[0]}). Suba com: docker compose up -d postgres`);
  }
  try {
    const { default: IORedis } = await import("ioredis");
    const client = new IORedis(env().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, retryStrategy: () => null });
    await withTimeout(client.connect(), 4000);
    await withTimeout(client.ping(), 2000);
    log("Redis: conectado");
    client.disconnect();
  } catch (err) {
    log(`Redis: indisponível (${(err as Error).message}). Suba com: docker compose up -d redis`);
  }
}

console.log(`
Próximos passos
  Docker (tudo):   docker compose up -d --build   → http://localhost:3000 (ou a porta de WEB_PORT)
  Local:           pnpm db:deploy && pnpm dev    (e em outro terminal: pnpm dev:worker)
  O primeiro cadastro em /cadastro cria a família e o usuário proprietário.
`);
process.exit(ok ? 0 : 1);
