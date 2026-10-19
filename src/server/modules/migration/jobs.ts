import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { errorInfo, logger } from "../../logger";
import { addJob, QUEUE_NAMES, type MigrationJobData } from "../../jobs/queues";
import { workerStatus } from "../../whatsapp/commands";

/**
 * Etapas pesadas da migração (ler 20 mil linhas, montar a prévia, importar) rodam em segundo
 * plano: no worker quando ele está no ar; senão, no próprio servidor, sem bloquear a requisição.
 * O progresso fica no banco (SpreadsheetMigration.progress) — a tela acompanha por consulta.
 */

type Runner = (ctx: ServiceContext, migrationId: string) => Promise<void>;
const runners = new Map<MigrationJobData["kind"], Runner>();

export function registerMigrationRunner(kind: MigrationJobData["kind"], run: Runner) {
  runners.set(kind, run);
}

/** Em testes (ou MIGRATION_INLINE=1) a etapa roda e termina antes de responder. */
function inlineMode(): "await" | "background" | null {
  if (process.env.MIGRATION_INLINE === "1" || process.env.VITEST) return "await";
  return null;
}

async function memberContext(householdId: string, memberId: string | null): Promise<ServiceContext> {
  const member = memberId ? await prisma.householdMember.findFirst({ where: { id: memberId, householdId, isActive: true }, include: { household: { select: { timezone: true } } } }) : null;
  if (!member) throw new Error("Membro da migração não encontrado ou inativo.");
  return {
    householdId,
    memberId: member.id,
    userId: member.userId,
    role: member.role,
    actorType: "USER",
    timezone: member.household.timezone,
    canViewOthersPrivate: member.canViewOthersPrivate,
  };
}

export async function runMigrationJob(data: MigrationJobData): Promise<void> {
  // O worker carrega o serviço sob demanda (é ele quem registra as etapas).
  if (!runners.has(data.kind)) await import("./service");
  const runner = runners.get(data.kind);
  if (!runner) throw new Error(`Etapa de migração desconhecida: ${data.kind}`);
  const ctx = await memberContext(data.householdId, data.memberId);
  await runner(ctx, data.migrationId);
}

export async function dispatchMigrationJob(ctx: ServiceContext, migrationId: string, kind: MigrationJobData["kind"]): Promise<void> {
  const data: MigrationJobData = { migrationId, householdId: ctx.householdId, memberId: ctx.memberId, kind };
  const runInline = async () => {
    const runner = runners.get(kind);
    if (!runner) throw new Error(`Etapa de migração desconhecida: ${kind}`);
    await runner(ctx, migrationId);
  };
  const mode = inlineMode();
  if (mode === "await") return runInline();
  const worker = await workerStatus();
  if (worker.online) {
    const res = await addJob(QUEUE_NAMES.imports, kind, data, { jobId: `migration-${migrationId}-${kind}-${Date.now()}`, removeOnComplete: 200, removeOnFail: 200, attempts: 1 });
    if (res.ok) return;
    logger.warn({ migrationId, kind, reason: res.reason }, "migração: fila indisponível — processando no servidor");
  }
  void runInline().catch((err) => logger.error({ migrationId, kind, err: errorInfo(err) }, "migração: etapa falhou"));
}
