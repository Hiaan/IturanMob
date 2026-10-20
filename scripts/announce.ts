/**
 * Aviso de novidades para as famílias cadastradas (uma mensagem por família, no chat autorizado).
 *
 *   tsx scripts/announce.ts --id novidades-2026-10 --title "Novidades" < texto.txt            → prévia (não envia)
 *   tsx scripts/announce.ts --id novidades-2026-10 --title "Novidades" --enviar < texto.txt   → envia
 *
 * O mesmo id nunca é enviado duas vezes para a mesma família.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), ".env");
if (existsSync(file)) {
  try {
    process.loadEnvFile(file);
  } catch {
    // segue com o ambiente atual
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const id = arg("id");
  const title = arg("title") ?? "Novidades no Finance AI";
  const send = process.argv.includes("--enviar");
  const text = readFileSync(0, "utf8");
  if (!id) throw new Error("informe --id");
  const { announceToHouseholds } = await import("../src/server/modules/announcements/service");
  const results = await announceToHouseholds({ id, title, text, dryRun: !send });
  const count = (k: string) => results.filter((r) => r.whatsapp === k).length;
  console.log(send ? "ENVIO" : "PRÉVIA (nada foi enviado; para enviar, repita com --enviar)");
  console.log(`famílias: ${results.length}`);
  for (const k of ["DRY_RUN", "QUEUED", "ALREADY_SENT", "SKIPPED_OPT_OUT", "NO_CHAT", "FAILED"]) if (count(k)) console.log(`  ${k}: ${count(k)}`);
  for (const r of results) if (r.reason) console.log(`  família …${r.householdId.slice(-6)}: ${r.reason}`);
  console.log(`\nTexto (${text.trim().length} caracteres):\n${text.trim()}`);
  const { prisma } = await import("../src/server/db");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(`erro: ${(err as Error).message}`);
  process.exit(1);
});
