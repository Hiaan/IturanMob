import { execSync } from "node:child_process";

/** Aplica as migrations no banco de testes antes da suíte de integração. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://finance:finance@localhost:5432/finance_ai_test?schema=public";
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
