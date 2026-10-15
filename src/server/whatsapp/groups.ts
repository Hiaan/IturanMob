import { prisma } from "../db";
import { errorInfo, logger } from "../logger";
import { phoneFromJid, phonesMatch } from "./phone";
import type { ProviderGroup, ProviderGroupParticipant } from "./types";

/**
 * Sincroniza os grupos listados pelo provedor para WhatsAppGroup (nome e nº de participantes).
 * Preserva a autorização. Participantes NÃO são armazenados; apenas os do grupo autorizado são
 * usados para aprender o mapeamento LID ↔ telefone dos membros cadastrados.
 */
export async function upsertSyncedGroups(conn: { id: string; householdId: string }, groups: ProviderGroup[]): Promise<number> {
  const now = new Date();
  for (const g of groups) {
    const name = (g.name || "Grupo sem nome").slice(0, 120);
    await prisma.whatsAppGroup.upsert({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: g.externalId } },
      create: { householdId: conn.householdId, connectionId: conn.id, externalId: g.externalId, name, participantsCount: g.participantsCount, lastSyncedAt: now },
      update: { name, participantsCount: g.participantsCount, lastSyncedAt: now },
    });
  }
  const authorized = await prisma.whatsAppGroup.findFirst({ where: { connectionId: conn.id, isAuthorized: true }, select: { externalId: true } });
  const authorizedGroup = authorized ? groups.find((g) => g.externalId === authorized.externalId) : undefined;
  if (authorizedGroup) await learnMembersFromParticipants(conn.householdId, authorizedGroup.participants);
  return groups.length;
}

/** Preenche whatsappJid/whatsappLid dos membros cujo telefone cadastrado aparece entre os participantes. */
export async function learnMembersFromParticipants(householdId: string, participants: ProviderGroupParticipant[]): Promise<number> {
  const members = await prisma.householdMember.findMany({
    where: { householdId, isActive: true, whatsappPhone: { not: null } },
    select: { id: true, whatsappPhone: true, whatsappJid: true, whatsappLid: true },
  });
  let updated = 0;
  for (const m of members) {
    const p = participants.find((x) => phonesMatch(m.whatsappPhone, x.phone ?? phoneFromJid(x.jid)));
    if (!p) continue;
    const data: { whatsappJid?: string; whatsappLid?: string } = {};
    if (p.jid && p.jid !== m.whatsappJid) data.whatsappJid = p.jid;
    if (p.lid && p.lid !== m.whatsappLid) data.whatsappLid = p.lid;
    if (!Object.keys(data).length) continue;
    try {
      await prisma.householdMember.update({ where: { id: m.id }, data });
      updated++;
    } catch (err) {
      logger.warn({ err: errorInfo(err).message }, "whatsapp: falha ao atualizar identificadores do membro");
    }
  }
  return updated;
}
