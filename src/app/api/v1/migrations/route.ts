import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { ValidationError } from "@/server/errors";
import { listMigrations, MIGRATION_MAX_MB, startMigration } from "@/server/modules/migration/service";

export const GET = authed({ query: z.object({ limit: qs.int(20) }), permission: "transactions:read" }, async ({ ctx, query }) => listMigrations(ctx, query.limit));

/**
 * Inicia a migração de planilha: multipart/form-data com o campo "file" (.xlsx, .xls, .ods ou .csv,
 * até 15 MB). A leitura das abas acontece em segundo plano: acompanhe por GET /api/v1/migrations/:id.
 */
export const POST = authed(
  { body: z.unknown(), permission: "data:import", rateLimit: { key: "migrations:start", limit: 10, windowSeconds: 60 } },
  async ({ ctx, req }) => {
    const type = req.headers.get("content-type") ?? "";
    if (!type.includes("multipart/form-data")) throw new ValidationError('Envie a planilha como multipart/form-data no campo "file".');
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ValidationError('Envie a planilha no campo "file".');
    if (file.size > MIGRATION_MAX_MB * 1024 * 1024) throw new ValidationError(`O arquivo excede o limite de ${MIGRATION_MAX_MB} MB.`);
    return startMigration(ctx, { fileName: file.name || "planilha.xlsx", content: Buffer.from(await file.arrayBuffer()) });
  },
);
