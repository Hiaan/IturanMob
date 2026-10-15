/**
 * CLI de backups do Finance AI.
 *
 *   pnpm backup                 → cria um backup (pg_dump; sem pg_dump, exportação JSON compactada)
 *   pnpm backup create [--json] → idem (--json força a exportação JSON)
 *   pnpm backup verify <arquivo|id>
 *   pnpm backup:verify          → verifica o backup mais recente
 *   pnpm backup list
 *   pnpm backup restore-help [arquivo]
 */
import { existsSync } from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  try {
    // Não sobrescreve variáveis já definidas no ambiente.
    process.loadEnvFile(file);
  } catch {
    // .env inválido: segue apenas com o ambiente atual.
  }
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function usage() {
  console.log(
    [
      "Uso: pnpm backup [comando]",
      "",
      "  create [--json]        cria um backup (padrão)",
      "  verify <arquivo|id>    confere SHA-256 e estrutura (pg_restore --list)",
      "  verify                 verifica o backup mais recente",
      "  list                   lista os backups registrados",
      "  restore-help [arquivo] mostra as instruções de restauração",
    ].join("\n"),
  );
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2).filter((a) => a !== "--");
  let command = args[0] ?? "create";
  let rest = args.slice(1);
  if (command === "--verify") {
    command = "verify";
    rest = args.slice(1);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    usage();
    return 0;
  }

  const { createDatabaseBackup, verifyBackup, listBackups, restoreInstructions, backupDir } = await import("../src/server/modules/backups/service");
  const { prisma } = await import("../src/server/db");
  try {
    switch (command) {
      case "create": {
        console.log(`Criando backup em ${backupDir()} ...`);
        const record = await createDatabaseBackup({ method: rest.includes("--json") ? "json" : "auto" });
        if (record.status !== "SUCCESS") {
          console.error(`Falha no backup: ${record.error ?? "erro desconhecido"}`);
          return 1;
        }
        console.log(`Backup criado: ${record.fileName} (${formatSize(record.sizeBytes)}, ${record.kind === "DATABASE_DUMP" ? "pg_dump" : "exportação JSON"})`);
        console.log(`SHA-256: ${record.sha256}`);
        const verified = await verifyBackup(record.id);
        console.log(`Verificação: ${verified.ok ? "OK" : "FALHOU"} — ${verified.message}`);
        console.log("");
        for (const line of restoreInstructions(path.join(backupDir(), record.fileName))) console.log(line);
        return verified.ok ? 0 : 1;
      }
      case "verify": {
        let target = rest[0];
        if (!target) {
          const [latest] = await listBackups({ limit: 1 });
          if (!latest) {
            console.error("Nenhum backup registrado.");
            return 1;
          }
          target = latest.id;
        }
        const result = await verifyBackup(target);
        console.log(`${result.ok ? "OK" : "CORROMPIDO"}: ${result.filePath}`);
        console.log(`SHA-256 calculado: ${result.sha256 ?? "—"}`);
        console.log(`SHA-256 esperado:  ${result.expectedSha256 ?? "(sem registro)"}`);
        if (result.structure) console.log(`Estrutura: ${result.structure}`);
        console.log(result.message);
        return result.ok ? 0 : 1;
      }
      case "list": {
        const items = await listBackups({ limit: 100 });
        if (!items.length) console.log("Nenhum backup registrado.");
        for (const b of items) {
          console.log(`${b.createdAt}  ${b.status.padEnd(9)}  ${b.kind === "DATABASE_DUMP" ? "pg_dump" : "json   "}  ${formatSize(b.sizeBytes).padStart(9)}  ${b.fileName}  [${b.id}]`);
        }
        return 0;
      }
      case "restore-help": {
        for (const line of restoreInstructions(rest[0])) console.log(line);
        return 0;
      }
      default:
        usage();
        return 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Erro: ${(err as Error).message}`);
    process.exit(1);
  });
