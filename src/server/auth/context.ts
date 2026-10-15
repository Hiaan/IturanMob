import type { ActorType, MemberRole } from "@prisma/client";

/**
 * Contexto de execução de qualquer serviço de domínio.
 * TODA operação recebe o contexto e filtra pelo householdId — é a base do isolamento entre famílias.
 */
export interface ServiceContext {
  householdId: string;
  /** Membro que executa a ação (nulo para processos do sistema). */
  memberId: string | null;
  userId: string | null;
  role: MemberRole;
  actorType: ActorType;
  timezone: string;
  canViewOthersPrivate: boolean;
  ip?: string | null;
}

/** Contexto para tarefas do sistema (worker, agendadores). Vê todos os dados da família. */
export function systemContext(householdId: string, timezone = "America/Recife", actorType: ActorType = "SYSTEM"): ServiceContext {
  return {
    householdId,
    memberId: null,
    userId: null,
    role: "OWNER",
    actorType,
    timezone,
    canViewOthersPrivate: true,
  };
}
