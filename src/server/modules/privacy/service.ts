import { z } from "zod";
import { prisma, withTransaction } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { assertCan } from "../../auth/permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "../../errors";
import { errorInfo, logger } from "../../logger";
import { deleteStoredFile } from "../../storage";
import { audit } from "../audit/service";

/**
 * Privacidade (LGPD): exclusão da família inteira (proprietário) e exclusão da própria conta
 * (demais membros), preservando o histórico financeiro da família de forma anonimizada.
 */

export const deleteHouseholdSchema = z.object({
  /** Nome exato da família, digitado pelo proprietário para confirmar. */
  confirmation: z.string().min(1).max(200),
});

export const deleteMyAccountSchema = z.object({
  /** Digite EXCLUIR para confirmar. */
  confirmation: z.string().min(1).max(50),
});

export const ANONYMIZED_MEMBER_NAME = "Ex-membro";

/** Exclui a família e todos os seus dados (cascade), inclusive arquivos armazenados. Somente o proprietário. */
export async function deleteHousehold(ctx: ServiceContext, rawInput: z.input<typeof deleteHouseholdSchema>) {
  assertCan(ctx, "household:delete");
  if (ctx.role !== "OWNER" || !ctx.memberId) throw new ForbiddenError("Apenas o proprietário pode excluir a família.");
  const input = deleteHouseholdSchema.parse(rawInput);
  const household = await prisma.household.findUnique({ where: { id: ctx.householdId }, select: { id: true, name: true } });
  if (!household) throw new NotFoundError("Família");
  if (input.confirmation.trim() !== household.name.trim()) {
    throw new ValidationError("Para confirmar, digite exatamente o nome da família.", { field: "confirmation" });
  }

  // Arquivos do armazenamento (mídias, comprovantes e arquivos de importação).
  const attachments = await prisma.attachment.findMany({ where: { householdId: household.id, storageKey: { not: null } }, select: { storageKey: true } });
  const keys = [...new Set(attachments.map((a) => a.storageKey!).filter(Boolean))];
  const batches = await prisma.importBatch.findMany({ where: { householdId: household.id }, select: { mapping: true } });
  for (const b of batches) {
    const key = (b.mapping as { storageKey?: unknown } | null)?.storageKey;
    if (typeof key === "string" && !keys.includes(key)) keys.push(key);
  }
  let filesRemoved = 0;
  for (const key of keys) {
    try {
      await deleteStoredFile(key);
      filesRemoved++;
    } catch (err) {
      logger.warn({ householdId: household.id, err: errorInfo(err).name }, "privacy: falha ao remover arquivo");
    }
  }

  const members = await prisma.householdMember.findMany({ where: { householdId: household.id, userId: { not: null } }, select: { userId: true } });
  const userIds = [...new Set(members.map((m) => m.userId!))];

  const removedUsers = await withTransaction(async (db) => {
    await db.household.delete({ where: { id: household.id } });
    // Usuários sem nenhuma outra família são removidos (e-mail, nome e senha).
    const orphans = await db.user.findMany({ where: { id: { in: userIds }, memberships: { none: {} } }, select: { id: true } });
    if (orphans.length) await db.user.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
    // Registro mínimo, sem dados pessoais, de que a exclusão ocorreu.
    await db.auditLog.create({
      data: {
        householdId: null,
        actorType: ctx.actorType,
        actorMemberId: null,
        action: "DELETE",
        entityType: "Household",
        entityId: household.id,
        ip: ctx.ip ?? null,
        metadata: { reason: "LGPD: exclusão da família pelo proprietário", filesRemoved, usersRemoved: orphans.length },
      },
    });
    return orphans.length;
  });

  logger.info({ householdId: household.id, filesRemoved, usersRemoved: removedUsers }, "privacy: família excluída");
  return {
    deleted: true,
    filesRemoved,
    usersRemoved: removedUsers,
    note: "Os dados foram excluídos. Cópias de segurança existentes são descartadas conforme a política de retenção de backups.",
  };
}

/**
 * Exclui a conta do próprio usuário (não proprietário): desvincula o login, anonimiza o membro
 * ("Ex-membro") e preserva o histórico financeiro da família.
 */
export async function deleteMemberAccount(ctx: ServiceContext, rawInput: z.input<typeof deleteMyAccountSchema> = { confirmation: "EXCLUIR" }) {
  const input = deleteMyAccountSchema.parse(rawInput);
  if (input.confirmation.trim().toUpperCase() !== "EXCLUIR") throw new ValidationError('Para confirmar, digite "EXCLUIR".', { field: "confirmation" });
  if (!ctx.memberId || !ctx.userId) throw new ForbiddenError("Apenas usuários autenticados podem excluir a própria conta.");
  const member = await prisma.householdMember.findFirst({ where: { id: ctx.memberId, householdId: ctx.householdId } });
  if (!member || member.userId !== ctx.userId) throw new NotFoundError("Membro");
  if (member.role === "OWNER") {
    throw new ValidationError("O proprietário não pode excluir a própria conta. Transfira a propriedade para outro membro ou exclua a família.");
  }
  const userId = ctx.userId;

  const result = await withTransaction(async (db) => {
    await audit(
      ctx,
      {
        action: "DELETE",
        entityType: "HouseholdMember",
        entityId: member.id,
        before: { role: member.role, isActive: member.isActive },
        after: { anonymized: true },
        source: "LGPD: exclusão da própria conta",
      },
      db,
    );
    await db.householdMember.update({
      where: { id: member.id },
      data: {
        userId: null,
        displayName: ANONYMIZED_MEMBER_NAME,
        relation: null,
        role: "VIEWER",
        isActive: false,
        canViewOthersPrivate: false,
        whatsappPhone: null,
        whatsappJid: null,
        whatsappLid: null,
        whatsappConsentAt: null,
        whatsappAuthorized: false,
      },
    });
    // Dados pessoais que não fazem parte do histórico financeiro.
    await db.notificationPreference.deleteMany({ where: { memberId: member.id } });
    await db.notification.deleteMany({ where: { householdId: ctx.householdId, recipientMemberId: member.id } });
    await db.assistantConversation.deleteMany({ where: { householdId: ctx.householdId, memberId: member.id } });
    await db.session.deleteMany({ where: { userId, householdId: ctx.householdId } });

    const otherMemberships = await db.householdMember.count({ where: { userId } });
    if (!otherMemberships) {
      await db.user.delete({ where: { id: userId } });
      return { userDeleted: true };
    }
    return { userDeleted: false };
  });

  logger.info({ householdId: ctx.householdId, memberId: member.id, userDeleted: result.userDeleted }, "privacy: conta de membro excluída");
  return {
    deleted: true,
    userDeleted: result.userDeleted,
    note: "Seu acesso foi removido. Os lançamentos da família foram mantidos e associados a um membro anonimizado.",
  };
}
