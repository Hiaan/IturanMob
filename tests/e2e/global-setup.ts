import { execSync } from "node:child_process";
import { E2E_DATABASE_URL } from "../../playwright.config";

/**
 * Prepara o banco de e2e: aplica as migrations e apaga todos os dados (o banco é exclusivo dos testes).
 * Com E2E_BASE_URL (servidor externo), não mexe em banco nenhum.
 */
export default async function globalSetup() {
  if (process.env.E2E_BASE_URL) return;
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL };
  if (!/e2e|test/i.test(new URL(E2E_DATABASE_URL).pathname)) {
    throw new Error("E2E_DATABASE_URL precisa apontar para um banco de testes (nome contendo 'e2e' ou 'test').");
  }
  execSync("pnpm exec prisma migrate deploy", { env, stdio: "pipe" });
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: E2E_DATABASE_URL });
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.$disconnect();
}
