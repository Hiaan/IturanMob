import { z } from "zod";
import { authed, qs } from "@/server/api/handler";
import { ValidationError } from "@/server/errors";
import { columnMappingSchema } from "@/server/modules/imports/mapping";
import { createImportPreview, createImportPreviewFromBuffer, IMPORT_MAX_BYTES, listImports } from "@/server/modules/imports/service";

export const GET = authed({ query: z.object({ limit: qs.int(50) }), permission: "transactions:read" }, async ({ ctx, query }) => listImports(ctx, { limit: query.limit }));

/**
 * Cria a prévia de importação (CSV, OFX ou XLSX).
 * - JSON: { fileName, contentBase64, format?, accountId?, creditCardId?, mapping?, headerRowIndex?, invertSigns? }
 *   (requisições JSON são limitadas a ~2 MB, ou seja, arquivos de até ~1,4 MB);
 * - multipart/form-data: campo "file" (até 5 MB) e os mesmos campos opcionais (mapping como JSON).
 */
export const POST = authed(
  { body: z.unknown(), permission: "data:import", rateLimit: { key: "imports:preview", limit: 30, windowSeconds: 60 } },
  async ({ ctx, req, body }) => {
    const type = req.headers.get("content-type") ?? "";
    if (!type.includes("multipart/form-data")) return createImportPreview(ctx, (body ?? {}) as Parameters<typeof createImportPreview>[1]);

    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ValidationError('Envie o arquivo no campo "file".');
    if (file.size > IMPORT_MAX_BYTES) throw new ValidationError("O arquivo excede o limite de 5 MB.");
    const field = (name: string) => {
      const v = form.get(name);
      return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
    };
    let mapping: z.input<typeof columnMappingSchema> | undefined;
    const mappingRaw = field("mapping");
    if (mappingRaw) {
      try {
        mapping = JSON.parse(mappingRaw) as z.input<typeof columnMappingSchema>;
      } catch {
        throw new ValidationError("Mapeamento de colunas inválido.");
      }
    }
    const format = field("format")?.toUpperCase();
    if (format && format !== "CSV" && format !== "OFX" && format !== "XLSX") throw new ValidationError("Formato inválido (use CSV, OFX ou XLSX).");
    const headerRow = field("headerRowIndex");
    return createImportPreviewFromBuffer(ctx, {
      fileName: field("fileName") ?? file.name ?? "extrato",
      content: Buffer.from(await file.arrayBuffer()),
      format: format as "CSV" | "OFX" | "XLSX" | undefined,
      accountId: field("accountId"),
      creditCardId: field("creditCardId"),
      mapping,
      headerRowIndex: headerRow === undefined ? undefined : Number(headerRow),
      invertSigns: field("invertSigns") === "true" || field("invertSigns") === "1",
    });
  },
);
