import { authed } from "@/server/api/handler";
import { prisma } from "@/server/db";
import { NotFoundError, AppError } from "@/server/errors";
import { readStoredFile } from "@/server/storage";
import { getVisibilityScope, visibleTransactionWhere } from "@/server/modules/visibility/scope";
import { audit } from "@/server/modules/audit/service";

/**
 * Conteúdo original de um anexo (comprovante/áudio), conforme permissões e retenção.
 * Anexos vinculados a transações de contas privadas seguem a mesma regra de visibilidade.
 */
export const GET = authed({ permission: "transactions:read" }, async ({ ctx, params }) => {
  const att = await prisma.attachment.findFirst({ where: { id: params.id!, householdId: ctx.householdId } });
  if (!att) throw new NotFoundError("Anexo");
  if (att.transactionId) {
    const scope = await getVisibilityScope(ctx);
    const visible = await prisma.transaction.count({ where: { id: att.transactionId, householdId: ctx.householdId, ...visibleTransactionWhere(scope) } });
    if (!visible) throw new NotFoundError("Anexo");
  }
  if (!att.storageKey || att.contentDeletedAt) {
    throw new AppError("O conteúdo original foi removido pela política de retenção.", { status: 410, code: "GONE" });
  }
  const content = await readStoredFile(att.storageKey);
  await audit(ctx, { action: "EXPORT", entityType: "Attachment", entityId: att.id, metadata: { view: true } });
  const type = att.mimeType.split(";")[0] || "application/octet-stream";
  const safeType = /^(image\/(jpeg|png|webp|gif)|audio\/[a-z0-9.+-]+|application\/pdf)$/.test(type) ? type : "application/octet-stream";
  return new Response(new Uint8Array(content), {
    headers: {
      "Content-Type": safeType,
      "Content-Length": String(content.length),
      "Content-Disposition": `inline; filename="anexo-${att.id}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    },
  });
});
