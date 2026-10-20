import { z } from "zod";
import { authed } from "@/server/api/handler";
import { ValidationError } from "@/server/errors";
import { BOLETO_FILE_MAX_MB, readBoletoFile } from "@/server/modules/bills/boleto-file";

/**
 * Lê um boleto em PDF ou foto: multipart/form-data no campo "file". Devolve o código conferido e
 * os dados impressos como sugestão (nada é gravado). Foto usa a IA só se a família permitir.
 */
export const POST = authed(
  { body: z.unknown(), permission: "bills:write", rateLimit: { key: "bills:boleto-read", limit: 20, windowSeconds: 60 } },
  async ({ ctx, req }) => {
    const type = req.headers.get("content-type") ?? "";
    if (!type.includes("multipart/form-data")) throw new ValidationError('Envie o arquivo como multipart/form-data no campo "file".');
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ValidationError('Envie o arquivo no campo "file".');
    if (file.size > BOLETO_FILE_MAX_MB * 1024 * 1024) throw new ValidationError(`O arquivo excede o limite de ${BOLETO_FILE_MAX_MB} MB.`);
    return readBoletoFile(ctx, { fileName: file.name || "boleto", mimeType: file.type || "application/octet-stream", content: Buffer.from(await file.arrayBuffer()) });
  },
);
