import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { ForbiddenError } from "../../errors";
import { env } from "../../env";
import { logger } from "../../logger";
import { audit } from "../audit/service";
import { announceToHouseholds } from "../announcements/service";
import { listBackups } from "../backups/service";
import { notify } from "../notifications/service";
import { claimAlertMark } from "../notifications/marks";
import { isInstanceAdmin } from "./invites";

/**
 * Painel da instalação (só o administrador): versão instalada × disponível, atualização automática,
 * "atualizar agora", saúde e avisos para as famílias. Substitui os scripts rodados do computador.
 *
 * O servidor (script de atualização, fora do app) grava o sinal de vida em PlatformSetting "host" e
 * o resultado de cada atualização em PlatformEvent; o app só lê, registra pedidos e avisa o
 * administrador. Nada aqui mostra dados financeiros ou pessoais das famílias — só contagens.
 */

/** Sinal de vida gravado pelo servidor a cada execução do script de atualização (5 em 5 min). */
const hostSchema = z.object({
  checkedAt: z.string(),
  autoUpdate: z.boolean().default(false),
  channel: z.string().default("producao"),
  installed: z.string().nullish(),
  available: z.string().nullish(),
  diskFreeGb: z.number().nullish(),
  memAvailableMb: z.number().nullish(),
  offsiteBackup: z.boolean().nullish(),
  window: z.string().nullish(),
});
export type HostStatus = z.infer<typeof hostSchema>;

/** Sem sinal do servidor há mais que isso: algo parou (o script roda a cada 5 minutos). */
const HOST_STALE_MS = 30 * 60_000;

async function assertAdmin(ctx: ServiceContext) {
  if (!(await isInstanceAdmin(ctx.userId))) throw new ForbiddenError("Só o administrador desta instalação acessa este painel.");
}

async function readHost(): Promise<HostStatus | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: "host" } });
  if (!row) return null;
  const parsed = hostSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null);

export async function getPlatformStatus(ctx: ServiceContext) {
  await assertAdmin(ctx);
  const [host, households, connections, events, pending, lastBackup] = await Promise.all([
    readHost(),
    prisma.household.count(),
    prisma.whatsAppConnection.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.platformEvent.findMany({ where: { kind: "UPDATE" }, orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.platformEvent.findFirst({ where: { kind: "UPDATE_REQUEST", status: "PENDING" }, orderBy: { createdAt: "desc" } }),
    listBackups({ limit: 1 }),
  ]);
  const e = env();
  const installed = short(e.APP_VERSION) ?? short(host?.installed);
  const lastSeenMs = host ? Date.now() - new Date(host.checkedAt).getTime() : null;
  return {
    version: {
      installed,
      available: short(host?.available),
      upToDate: Boolean(installed && host?.available && host.available.startsWith(installed)),
    },
    autoUpdate: {
      enabled: Boolean(host?.autoUpdate),
      window: host?.window ?? null,
      lastSeenAt: host?.checkedAt ?? null,
      /** O servidor deu sinal recentemente (o script de atualização está rodando). */
      online: lastSeenMs !== null && lastSeenMs < HOST_STALE_MS,
      pendingRequestAt: pending?.createdAt.toISOString() ?? null,
    },
    health: {
      households,
      whatsapp: Object.fromEntries(connections.map((c) => [c.status, c._count._all])) as Record<string, number>,
      aiConfigured: Boolean(e.ANTHROPIC_API_KEY || e.OPENAI_API_KEY),
      lastBackup: lastBackup[0] ? { at: lastBackup[0].createdAt, status: lastBackup[0].status } : null,
      offsiteBackup: host?.offsiteBackup ?? null,
      diskFreeGb: host?.diskFreeGb ?? null,
      memAvailableMb: host?.memAvailableMb ?? null,
    },
    updates: events.map((ev) => ({ id: ev.id, status: ev.status, version: short(ev.version), message: ev.message, at: ev.createdAt.toISOString() })),
  };
}

/** "Atualizar agora": o servidor atende no próximo ciclo (até 5 minutos), fora da janela da madrugada. */
export async function requestUpdate(ctx: ServiceContext) {
  await assertAdmin(ctx);
  const open = await prisma.platformEvent.findFirst({ where: { kind: "UPDATE_REQUEST", status: "PENDING" } });
  if (open) return { requestedAt: open.createdAt.toISOString(), alreadyPending: true };
  const created = await prisma.platformEvent.create({ data: { kind: "UPDATE_REQUEST", status: "PENDING", message: "Pedido feito no painel" } });
  await audit(ctx, { action: "CREATE", entityType: "PlatformEvent", entityId: created.id, metadata: { kind: "UPDATE_REQUEST" } });
  return { requestedAt: created.createdAt.toISOString(), alreadyPending: false };
}

export const announcementSchema = z.object({
  title: z.string().trim().min(3).max(120),
  text: z.string().trim().min(10).max(3500),
  /** false = só a prévia (quantas famílias recebem); true = envia. */
  send: z.boolean().default(false),
});

/**
 * Aviso para as famílias, pelo painel. O id vem do próprio texto: mandar o mesmo aviso de novo
 * (clique duplo, reenvio) não repete para quem já recebeu.
 */
export async function sendAnnouncement(ctx: ServiceContext, input: z.infer<typeof announcementSchema>) {
  await assertAdmin(ctx);
  const hash = createHash("sha256").update(`${input.title}\n${input.text}`).digest("hex").slice(0, 10);
  const id = `painel-${hash}`;
  const results = await announceToHouseholds({ id, title: input.title, text: input.text, dryRun: !input.send });
  const count = (k: string) => results.filter((r) => r.whatsapp === k).length;
  if (input.send) await audit(ctx, { action: "CREATE", entityType: "Announcement", entityId: id, metadata: { title: input.title, queued: count("QUEUED") } });
  return {
    sent: input.send,
    households: results.length,
    willReceive: input.send ? count("QUEUED") : count("DRY_RUN"),
    alreadySent: count("ALREADY_SENT"),
    optedOut: count("SKIPPED_OPT_OUT"),
    noWhatsApp: count("NO_CHAT"),
    failed: count("FAILED"),
  };
}

/** Membros (por família) que recebem os avisos da instalação: o(s) administrador(es). */
async function adminRecipients(): Promise<Array<{ householdId: string; memberId: string }>> {
  const emails = env()
    .INSTANCE_ADMIN_EMAILS.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const members = await prisma.householdMember.findMany({
    where: emails.length
      ? { isActive: true, user: { email: { in: emails, mode: "insensitive" } } }
      : { isActive: true, role: "OWNER", user: { NOT: { email: { endsWith: "@demo.invalid" } } } },
    orderBy: { household: { createdAt: "asc" } },
    select: { id: true, householdId: true, userId: true },
  });
  if (emails.length) return members.map((m) => ({ householdId: m.householdId, memberId: m.id }));
  // Sem a variável: o proprietário da primeira família (mesma regra de isInstanceAdmin).
  const first = members[0];
  return first ? members.filter((m) => m.householdId === first.householdId).map((m) => ({ householdId: m.householdId, memberId: m.id })) : [];
}

async function notifyAdmins(title: string, body: string, dedupeKey: string) {
  for (const r of await adminRecipients()) {
    await notify({ householdId: r.householdId, recipientMemberIds: [r.memberId], type: "SYSTEM", title, body, dedupeKey: `${dedupeKey}:${r.memberId}`, data: { platform: true, inAppOnly: true } });
  }
}

const UPDATE_TITLES: Record<string, string> = {
  OK: "Sistema atualizado",
  ROLLED_BACK: "Atualização desfeita",
  ROLLBACK_FAILED: "Atenção: atualização com problema",
};

/**
 * Tarefa do worker: avisa o administrador (no app e no celular) de cada atualização gravada pelo
 * servidor, e quando o servidor para de dar sinal. Idempotente (notifiedAt / marca por dia).
 */
export async function runPlatformNotifications(now: Date = new Date()): Promise<{ notified: number }> {
  let notified = 0;
  const events = await prisma.platformEvent.findMany({ where: { kind: "UPDATE", notifiedAt: null }, orderBy: { createdAt: "asc" }, take: 20 });
  for (const ev of events) {
    // Marca antes de avisar: em caso de falha no meio, prefere não repetir o aviso.
    const claimed = await prisma.platformEvent.updateMany({ where: { id: ev.id, notifiedAt: null }, data: { notifiedAt: now } });
    if (!claimed.count) continue;
    await notifyAdmins(UPDATE_TITLES[ev.status] ?? "Atualização do sistema", ev.message, `platform:${ev.id}`);
    notified++;
  }

  const host = await readHost();
  if (host?.autoUpdate && now.getTime() - new Date(host.checkedAt).getTime() > HOST_STALE_MS * 4) {
    const day = now.toISOString().slice(0, 10);
    const admins = await adminRecipients();
    if (admins[0] && (await claimAlertMark(admins[0].householdId, `platform:host-silent:${day}`))) {
      await notifyAdmins(
        "Servidor sem sinal",
        "A atualização automática não dá sinal há mais de 2 horas. O app continua no ar, mas as atualizações podem estar paradas. Abra Administração para ver.",
        `platform:host-silent:${day}`,
      );
      notified++;
    }
  }
  if (notified) logger.info({ notified }, "avisos da instalação");
  return { notified };
}
