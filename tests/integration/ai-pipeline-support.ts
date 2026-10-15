import { randomBytes } from "node:crypto";
import type { AITask } from "@prisma/client";
import { prisma } from "@/server/db";
import { redis } from "@/server/redis";
import { closeQueues, getQueue, QUEUE_NAMES, setQueuePrefix } from "@/server/jobs/queues";
import { ingestMessage } from "@/server/whatsapp/ingest";
import { runProcessingJob } from "@/server/whatsapp/processor";
import { saveCredential, updateTaskConfigs } from "@/server/ai/api";
import { getAccount } from "@/server/modules/accounts/service";
import { createFamily, type TestFamily } from "./helpers";

/**
 * Apoio aos testes do pipeline de IA: famílias com WhatsApp (simulador), envio de mensagens
 * pelo caminho real (ingestão → job → motor de IA → serviço de transações) e limpeza do Redis.
 */

export const TZ = "America/Recife";

export interface WaFamily extends TestFamily {
  connectionId: string;
  groupJid: string;
  /** Telefone do marido (OWNER), remetente autorizado das mensagens. */
  phone: string;
}

let familySeq = 0;
let messageSeq = 0;
const connectionIds = new Set<string>();

/** Família de teste com conexão do simulador, grupo autorizado e o marido como remetente autorizado. */
export async function createWaFamily(name = "Família Teste"): Promise<WaFamily> {
  familySeq++;
  const fam = await createFamily(name);
  await prisma.household.update({ where: { id: fam.householdId }, data: { timezone: TZ } });
  const phone = `+558199${String(1_000_000 + familySeq * 37).slice(-7)}`;
  await prisma.householdMember.update({
    where: { id: fam.husbandId },
    data: { whatsappPhone: phone, whatsappAuthorized: true, whatsappConsentAt: new Date() },
  });
  const conn = await prisma.whatsAppConnection.create({ data: { householdId: fam.householdId, provider: "SIMULATOR", status: "CONNECTED" } });
  connectionIds.add(conn.id);
  const groupJid = `1203630000000${String(familySeq).padStart(5, "0")}@g.us`;
  await prisma.whatsAppGroup.create({ data: { householdId: fam.householdId, connectionId: conn.id, externalId: groupJid, name: "Finanças", isAuthorized: true } });
  return { ...fam, connectionId: conn.id, groupJid, phone };
}

export interface SendInput {
  text?: string;
  type?: "TEXT" | "AUDIO" | "IMAGE";
  media?: { bytes: Buffer; mimeType: string };
  /** Reenvio do mesmo evento do provedor (mesmo id externo). */
  externalId?: string;
}

/** Ingere uma mensagem do grupo e a processa em linha (simulador). */
export async function sendMessage(wa: WaFamily, input: SendInput) {
  const externalId = input.externalId ?? `AIP-${++messageSeq}-${randomBytes(4).toString("hex")}`;
  const type = input.type ?? "TEXT";
  const media = input.media;
  const res = await ingestMessage(
    { id: wa.connectionId, householdId: wa.householdId },
    {
      externalId,
      chatId: wa.groupJid,
      isGroup: true,
      senderIds: { phone: wa.phone },
      fromMe: false,
      sentAt: new Date(),
      type,
      text: type === "TEXT" ? (input.text ?? null) : null,
      caption: type === "TEXT" ? null : (input.text ?? null),
      media: media ? { mimeType: media.mimeType, sizeBytes: media.bytes.length, download: async () => media.bytes } : null,
    },
  );
  if (!res.accepted || !res.messageId) throw new Error(`mensagem não aceita: ${res.reason ?? "?"}`);
  const run = res.jobId ? await runProcessingJob(res.jobId, { inlineSimulator: true }) : null;
  return { messageId: res.messageId, jobId: res.jobId ?? null, duplicate: Boolean(res.duplicate), externalId, run, ...(await messageState(wa, res.messageId)) };
}

/** Estado atual da mensagem e respostas do bot (mensagens OUTBOUND simuladas que a citam). */
export async function messageState(wa: WaFamily, messageId: string) {
  const message = await prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: messageId } });
  const replies = (
    await prisma.whatsAppMessage.findMany({
      where: { householdId: wa.householdId, direction: "OUTBOUND", quotedExternalId: message.externalId },
      orderBy: { createdAt: "asc" },
    })
  ).map((m) => m.text ?? "");
  return { message, replies, reply: replies.join("\n") };
}

/** Transações da família (inclui excluídas), da mais antiga para a mais recente. */
export function txsOf(householdId: string) {
  return prisma.transaction.findMany({
    where: { householdId },
    orderBy: [{ createdAt: "asc" }, { sourceIndex: "asc" }],
    include: { category: true, subcategory: true, ledgerEntries: true },
  });
}

export async function balanceOf(fam: TestFamily, accountId: string) {
  return (await getAccount(fam.ctx, accountId)).balanceCents;
}

/** Autoriza o envio a provedores externos e direciona as tarefas indicadas ao provedor "Anthropic" (falso nos testes). */
export async function enableExternalAI(fam: TestFamily, tasks: AITask[], consent: { audio?: boolean; image?: boolean } = {}) {
  await prisma.householdSettings.update({
    where: { householdId: fam.householdId },
    data: { aiExternalAllowed: true, aiAudioAllowed: consent.audio ?? false, aiImageAllowed: consent.image ?? false },
  });
  await saveCredential(fam.ctx, { provider: "ANTHROPIC", apiKey: "sk-ant-teste-000000000000" });
  await updateTaskConfigs(fam.ctx, { items: tasks.map((task) => ({ task, provider: "ANTHROPIC" as const, model: "modelo-falso", enabled: true })) });
}

/** Contagens das tabelas financeiras (para provar que nada foi alterado). */
export async function financialSnapshot(householdId: string) {
  const where = { householdId };
  const [transactions, ledger, installments, pending, audits, accounts, categories, statements] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { id: "asc" },
      select: { id: true, amountCents: true, status: true, deletedAt: true, version: true, categoryId: true, accountId: true, description: true },
    }),
    prisma.ledgerEntry.findMany({ where, orderBy: { id: "asc" }, select: { id: true, amountCents: true, accountId: true } }),
    prisma.installment.count({ where }),
    prisma.pendingItem.count({ where }),
    prisma.auditLog.count({ where }),
    prisma.account.findMany({ where, orderBy: { id: "asc" }, select: { id: true, initialBalanceCents: true, archivedAt: true } }),
    prisma.category.count({ where }),
    prisma.creditCardStatement.count({ where }),
  ]);
  return { transactions, ledger, installments, pending, audits, accounts, categories, statements };
}

export function initTestQueues(tag: string) {
  setQueuePrefix(`fa-test-${tag}-${randomBytes(4).toString("hex")}`);
}

export async function clearTestQueues() {
  await Promise.allSettled([getQueue(QUEUE_NAMES.inbound).obliterate({ force: true }), getQueue(QUEUE_NAMES.outbound).obliterate({ force: true })]);
}

/** Remove filas e chaves do Redis criadas pelos testes e fecha as conexões. */
export async function teardownTestQueues() {
  await clearTestQueues();
  await closeQueues();
  const r = redis();
  for (const id of connectionIds) {
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", `fa:wa:sent:${id}:*`, "COUNT", 1000);
      cursor = next;
      if (keys.length) await r.del(...keys);
    } while (cursor !== "0");
  }
  await r.quit();
}
