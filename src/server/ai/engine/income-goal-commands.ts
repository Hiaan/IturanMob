import type { ReportScope } from "@prisma/client";
import type { ServiceContext } from "../../auth/context";
import { ForbiddenError } from "../../errors";
import { formatBRL } from "@/lib/money";
import { prisma } from "../../db";
import { listIncomeGoals, progressLine, setIncomeGoal } from "../../modules/income-goals/service";
import { extractAmounts } from "../nlu/numbers";
import { normalizeForNlu } from "../nlu/text";
import type { ActionOutcome } from "./actions";

/**
 * Meta de ganho pelo WhatsApp, sem IA:
 * - "meta de ganho da empresa 30 mil", "minha meta de faturamento é 30k" → cria/atualiza;
 * - "qual minha meta de ganho?", "quanto falta pra meta?", "como está a meta de faturamento?" → responde.
 * Recorte: o dito na mensagem (empresa/PJ, pessoal/PF), senão o do grupo, senão Tudo.
 */

export type IncomeGoalCommand = { kind: "SET"; scope: ReportScope | null; targetCents: number } | { kind: "QUERY"; scope: ReportScope | null; generic: boolean };

const GOAL_WORDS = "(?:ganho|ganhos|faturamento|faturar|receita|receitas|renda|entrada|entradas)";
const NAMED = new RegExp(`\\bmeta(?:s)?\\s+(?:mensal\\s+)?(?:de|do|da)\\s+${GOAL_WORDS}\\b`);
/** "quanto falta pra meta", "quanto falta para bater a meta", "falta quanto pra meta" (sem dizer qual). */
const GENERIC = /^(?:e\s+)?(?:quanto\s+falta|falta\s+quanto)\s+(?:pra|para|p)\s+(?:bater\s+|atingir\s+|chegar\s+(?:na|a)\s+)?(?:a\s+|minha\s+)?meta\b\s*(?:do\s+mes|deste\s+mes|desse\s+mes)?\s*\??$/;
const QUESTION = /\?\s*$|^(?:qual|quais|quanto|como|e\s+a|e\s+minha|ja\s+bati|bati|falta)\b/;

/** Recorte dito na mensagem: empresa/PJ, pessoal/PF, ou os dois / "da família" (Tudo). */
function scopeOf(norm: string): ReportScope | null {
  const pj = /\b(?:empresa|empresarial|pj|cnpj|negocio)\b/.test(norm);
  const pf = /\b(?:pessoal|pessoa fisica|pf|cpf)\b/.test(norm);
  if (pj && pf) return "ALL";
  if (pj) return "BUSINESS";
  if (pf) return "PERSONAL";
  return /\b(?:da familia|de tudo|total|geral)\b/.test(norm) ? "ALL" : null;
}

export function parseIncomeGoalCommand(text: string): IncomeGoalCommand | null {
  if (text.length > 160) return null;
  const norm = normalizeForNlu(text).trim();
  if (GENERIC.test(norm)) return { kind: "QUERY", scope: null, generic: true };
  if (!NAMED.test(norm)) return null;
  const scope = scopeOf(norm);
  const amounts = extractAmounts(text).filter((a) => !a.isInstallmentValue && a.cents > 0);
  const question = QUESTION.test(norm);
  if (!question && amounts.length === 1) return { kind: "SET", scope, targetCents: amounts[0]!.cents };
  if (question || !amounts.length) return { kind: "QUERY", scope, generic: false };
  return null;
}

const scopeName = (scope: ReportScope) => (scope === "ALL" ? "da família (Tudo)" : scope === "BUSINESS" ? "da Empresa" : "de Pessoa física");

export async function handleIncomeGoalCommand(ctx: ServiceContext, cmd: IncomeGoalCommand, opts: { groupScope?: ReportScope | null } = {}): Promise<ActionOutcome | null> {
  if (cmd.kind === "SET") {
    const scope = cmd.scope ?? opts.groupScope ?? "ALL";
    try {
      const res = await setIncomeGoal(ctx, scope, cmd.targetCents);
      const [progress] = (await listIncomeGoals(ctx)).filter((g) => g.id === res.goal.id);
      const head = res.created
        ? `🎯 Meta de ganho ${scopeName(scope)} criada: ${formatBRL(cmd.targetCents)} por mês.`
        : `🎯 Meta de ganho ${scopeName(scope)} atualizada: ${formatBRL(res.previousCents ?? 0)} → ${formatBRL(cmd.targetCents)} por mês.`;
      const lines = [head];
      if (progress) lines.push(progressLine(progress));
      lines.push("Aviso quando chegar a 50%, 75%, 90% e 100% (as faixas do orçamento). Repasses não contam.");
      return { status: "PROCESSED", intent: "INCOME_GOAL_SET", replies: [lines.join("\n")], transactionIds: [] };
    } catch (err) {
      if (err instanceof ForbiddenError) return { status: "PROCESSED", intent: "INCOME_GOAL_SET", replies: ["Você não tem permissão para definir metas. Peça a quem administra a família."], transactionIds: [] };
      throw err;
    }
  }

  const goals = await listIncomeGoals(ctx);
  // "quanto falta pra meta?" sem metas de ganho: segue o fluxo normal (metas de economia).
  if (cmd.generic && !goals.length) return null;
  if (!goals.length) {
    return {
      status: "PROCESSED",
      intent: "INCOME_GOAL_QUERY",
      replies: ['Ainda não há meta de ganho. Para criar, mande por exemplo: *meta de ganho da empresa 30 mil* ou *meta de ganho pessoal 12 mil*.'],
      transactionIds: [],
    };
  }
  const wanted = cmd.scope ?? opts.groupScope ?? null;
  const scoped = wanted ? goals.filter((g) => g.scope === wanted) : [];
  const shown = scoped.length ? scoped : goals;
  const lines = shown.map(progressLine);
  if (wanted && !scoped.length) lines.unshift(`Não há meta de ganho ${scopeName(wanted)}; estas são as metas da família:`);
  if (cmd.generic && (await prisma.financialGoal.count({ where: { householdId: ctx.householdId, status: "ACTIVE" } }))) {
    lines.push("Para as metas de economia, pergunte: *como estão minhas metas?*");
  }
  return { status: "PROCESSED", intent: "INCOME_GOAL_QUERY", replies: [lines.join("\n")], transactionIds: [] };
}
