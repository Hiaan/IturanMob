import { authed } from "@/server/api/handler";
import { bulkCommitImports, bulkCommitSchema } from "@/server/modules/imports/service";

/** Confirma várias prévias de uma vez ({ batchIds: string[] }, até 20), com deduplicação entre os arquivos. */
export const POST = authed(
  { body: bulkCommitSchema, permission: "data:import", rateLimit: { key: "imports:bulk-commit", limit: 5, windowSeconds: 60 } },
  async ({ ctx, body }) => bulkCommitImports(ctx, body),
);
