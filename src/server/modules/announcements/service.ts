import { prisma } from "../../db";
import { logger } from "../../logger";
import { enqueueOutboundMessage } from "../../whatsapp/outbound";
import { OUTBOUND_MAX_TEXT } from "../../whatsapp/outbound-impl";
import { notify } from "../notifications/service";
import { claimAlertMark } from "../notifications/marks";

/**
 * Aviso de novidades do produto para as famílias cadastradas (rodado por quem administra o
 * servidor). Uma mensagem por família, só no chat que ela mesma autorizou (o grupo da família, ou
 * os membros autorizados na Cloud API), pela conexão dela — nenhum número ou contato de terceiros.
 * Cada aviso (id) sai uma única vez por família, mesmo rodando de novo. Família em que todos
 * desligaram os avisos "Sistema" não recebe no WhatsApp (só no app).
 */

export interface AnnounceResult {
  householdId: string;
  whatsapp: "QUEUED" | "SKIPPED_OPT_OUT" | "NO_CHAT" | "ALREADY_SENT" | "DRY_RUN" | "FAILED";
  reason?: string;
}

export async function announceToHouseholds(input: { id: string; title: string; text: string; dryRun: boolean }): Promise<AnnounceResult[]> {
  if (!/^[a-z0-9-]{3,60}$/.test(input.id)) throw new Error("id do aviso inválido (use letras minúsculas, números e hífen)");
  const text = input.text.trim();
  if (!text) throw new Error("texto vazio");
  if (text.length > OUTBOUND_MAX_TEXT - 10) throw new Error(`texto longo demais (máximo ${OUTBOUND_MAX_TEXT - 10} caracteres)`);
  const households = await prisma.household.findMany({ select: { id: true, whatsappConnection: { select: { status: true } } }, orderBy: { createdAt: "asc" } });
  const results: AnnounceResult[] = [];
  for (const h of households) {
    const key = `announce:${input.id}`;
    const members = await prisma.householdMember.findMany({ where: { householdId: h.id, isActive: true, userId: { not: null } }, select: { id: true } });
    const prefs = await prisma.notificationPreference.findMany({ where: { memberId: { in: members.map((m) => m.id) }, type: "SYSTEM" } });
    const optedOut = members.length > 0 && members.every((m) => prefs.find((p) => p.memberId === m.id)?.frequency === "OFF");
    const already = (await prisma.alertMark.count({ where: { householdId: h.id, key } })) > 0;
    if (input.dryRun) {
      results.push({
        householdId: h.id,
        whatsapp: already ? "ALREADY_SENT" : optedOut ? "SKIPPED_OPT_OUT" : !h.whatsappConnection ? "NO_CHAT" : "DRY_RUN",
        reason: h.whatsappConnection && h.whatsappConnection.status !== "CONNECTED" ? `WhatsApp ${h.whatsappConnection.status}` : undefined,
      });
      continue;
    }
    if (!(await claimAlertMark(h.id, key))) {
      results.push({ householdId: h.id, whatsapp: "ALREADY_SENT" });
      continue;
    }
    // No app sempre (caixa de notificações); no WhatsApp conforme acima.
    await notify({ householdId: h.id, type: "SYSTEM", title: input.title, body: text, dedupeKey: key, data: { announcement: input.id, inAppOnly: true } });
    if (optedOut) {
      results.push({ householdId: h.id, whatsapp: "SKIPPED_OPT_OUT" });
      continue;
    }
    const res = await enqueueOutboundMessage({ householdId: h.id, text, kind: "notification", dedupeKey: key });
    results.push(res.queued ? { householdId: h.id, whatsapp: "QUEUED" } : { householdId: h.id, whatsapp: res.reason?.includes("configurado") || res.reason?.includes("Nenhum") ? "NO_CHAT" : "FAILED", reason: res.reason });
  }
  logger.info({ announcement: input.id, dryRun: input.dryRun, total: results.length, queued: results.filter((r) => r.whatsapp === "QUEUED").length }, "aviso de novidades");
  return results;
}
