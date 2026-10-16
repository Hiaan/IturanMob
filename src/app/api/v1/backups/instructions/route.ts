import { authed } from "@/server/api/handler";
import { restoreInstructions } from "@/server/modules/backups/service";

/** Instruções de restauração exibidas na interface (pg_dump e exportação JSON). */
export const GET = authed({ permission: "settings:manage" }, async () => ({
  databaseDump: restoreInstructions("<arquivo>.dump"),
  jsonExport: restoreInstructions("<arquivo>.json.gz"),
  cli: ["pnpm backup create", "pnpm backup list", "pnpm backup verify <arquivo|id>", "pnpm backup restore-help <arquivo>"],
}));
