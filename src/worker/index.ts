/**
 * WORKER — processo separado do Next.js:
 * - gerenciador de conexões do WhatsApp (provedores, QR, status, grupos);
 * - consumidores das filas "whatsapp-inbound" (processamento) e "whatsapp-outbound" (envio);
 * - tarefas periódicas (fila "periodic", jobs repetíveis);
 * - heartbeat em Redis (fa:worker:heartbeat) e encerramento gracioso.
 *
 * Executar: npx tsx --tsconfig tsconfig.json src/worker/index.ts   (ou: pnpm worker)
 */
import { existsSync } from "node:fs";
import path from "node:path";

// Carrega o .env (sem sobrescrever variáveis já definidas) antes de ler a configuração.
const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // segue com o ambiente atual
  }
}
process.env.SERVICE_NAME ??= "finance-ai-worker";

const { startWorker } = await import("./runtime");

const runtime = await startWorker();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => {
    console.error(`[worker] encerramento forçado após ${signal}`);
    process.exit(1);
  }, 30_000);
  force.unref();
  try {
    await runtime.stop(signal);
    process.exit(0);
  } catch (err) {
    console.error("[worker] erro no encerramento", (err as Error).message);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
