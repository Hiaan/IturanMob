import type { ServiceContext } from "../../auth/context";
import { can } from "../../auth/permissions";
import { storeFile } from "../../storage";
import { addDays, addMonthsToKey, formatDateBR, formatMonthBR, monthKey, monthRange, startOfWeek, todayISO, type ISODate } from "@/lib/dates";
import { buildMonthlyReport, buildWeeklyReport, familyScopeContext, reportFileBaseName, reportTransactions } from "../../modules/reports/service";
import { renderReportPdf } from "../../modules/reports/pdf";
import { renderReportXlsx } from "../../modules/reports/xlsx";
import type { ReportView } from "../../modules/reports/types";
import { normalizeForNlu } from "../nlu/text";
import { detectNatureTokens } from "../nlu/nature";
import type { ActionOutcome } from "./actions";

/**
 * "manda o relatório do mês", "me envia a planilha de setembro", "relatório da semana em pdf":
 * gera o arquivo e envia no chat. Sempre no recorte da família (contas e cartões privados ficam de
 * fora, porque o arquivo vai para o grupo). Comando determinístico, sem IA.
 */

export interface ReportCommand {
  kind: "WEEKLY" | "MONTHLY";
  /** Mês AAAA-MM (mensal) ou início da semana (semanal). */
  ref: string;
  format: "pdf" | "xlsx";
  nature: "PERSONAL" | "BUSINESS" | "ALL" | null;
}

const REQUEST = /\b(manda|mande|mandar|me manda|envia|envie|enviar|me envia|gera|gere|gerar|quero|queria|preciso|pode mandar|pode enviar|tem como mandar|baixar|exporta|exportar)\b/;
const OBJECT = /\b(relatorio|planilha|excel|xlsx|pdf)\b/;
const MONTHS = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function parseReportCommand(text: string, today: ISODate): ReportCommand | null {
  const norm = normalizeForNlu(text);
  if (norm.length > 160 || !OBJECT.test(norm)) return null;
  // "relatório do mês" sem verbo também vale numa frase curta que começa pelo objeto.
  if (!REQUEST.test(norm) && !(norm.length <= 40 && /^(o |a )?(relatorio|planilha)\b/.test(norm))) return null;
  // Importar/migrar uma planilha é outro fluxo (o arquivo vem anexado).
  if (/\b(importa\w*|migra\w*)\b/.test(norm)) return null;
  const format: ReportCommand["format"] = /\b(planilha|excel|xlsx)\b/.test(norm) ? "xlsx" : "pdf";
  const tokens = detectNatureTokens(text);
  const nature = tokens.nature ?? (tokens.both ? "ALL" : null);

  if (/\bsemana\b/.test(norm)) {
    const past = /\bsemana (passada|anterior)\b/.test(norm);
    return { kind: "WEEKLY", ref: startOfWeek(past ? addDays(today, -7) : today), format, nature };
  }
  const current = monthKey(today);
  if (/\bmes (passado|anterior)\b/.test(norm)) return { kind: "MONTHLY", ref: addMonthsToKey(current, -1), format, nature };
  const named = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(norm));
  if (named >= 0) {
    const yearMatch = /\b(20\d{2})\b/.exec(norm);
    let year = yearMatch ? Number(yearMatch[1]) : Number(today.slice(0, 4));
    const month = `${year}-${String(named + 1).padStart(2, "0")}`;
    // Mês ainda por vir neste ano, sem ano dito → o do ano passado.
    if (!yearMatch && month > current) year -= 1;
    return { kind: "MONTHLY", ref: `${year}-${String(named + 1).padStart(2, "0")}`, format, nature };
  }
  return { kind: "MONTHLY", ref: current, format, nature };
}

export async function handleReportCommand(ctx: ServiceContext, cmd: ReportCommand): Promise<ActionOutcome> {
  if (!can(ctx.role, "reports:read")) {
    return { status: "IGNORED", intent: "REPORT_FILE", replies: ["Seu perfil não pode ver relatórios."], transactionIds: [] };
  }
  const today = todayISO(ctx.timezone);
  // Recorte da família: o arquivo vai para o chat, então contas e cartões privados ficam de fora.
  const familyCtx: ServiceContext = { ...familyScopeContext(ctx.householdId, ctx.timezone), reportScope: ctx.reportScope };
  const natureScope = cmd.nature ?? ctx.reportScope ?? undefined;
  const data =
    cmd.kind === "WEEKLY"
      ? await buildWeeklyReport(familyCtx, cmd.ref, { scope: "FAMILY", natureScope })
      : await buildMonthlyReport(familyCtx, cmd.ref, { scope: "FAMILY", natureScope });
  const period = cmd.kind === "WEEKLY" ? { start: cmd.ref, end: addDays(cmd.ref, 6) } : monthRange(cmd.ref);
  if (period.start > today) {
    return { status: "PROCESSED", intent: "REPORT_FILE", replies: ["Esse período ainda não começou. Peça o relatório de um mês ou semana que já começou."], transactionIds: [] };
  }
  const view: ReportView = {
    id: "whatsapp",
    type: cmd.kind,
    periodStart: period.start,
    periodEnd: period.end,
    createdAt: new Date().toISOString(),
    scheduled: false,
    generatedById: null,
    data,
  };
  const content = cmd.format === "pdf" ? await renderReportPdf(view) : await renderReportXlsx(view, await reportTransactions(familyCtx, view));
  const stored = await storeFile("reports", content);
  const label = cmd.kind === "WEEKLY" ? `semana de ${formatDateBR(period.start)} a ${formatDateBR(period.end)}` : formatMonthBR(cmd.ref);
  const partial = period.end > today ? " (parcial, até hoje)" : "";
  const natureLabel = data.natureScope === "BUSINESS" ? " · Empresa" : data.natureScope === "PERSONAL" ? " · Pessoa física" : "";
  const what = cmd.format === "pdf" ? "Relatório" : "Planilha";
  return {
    status: "PROCESSED",
    intent: "REPORT_FILE",
    replies: [],
    documents: [
      {
        storageKey: stored.storageKey,
        mimeType: cmd.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: `${reportFileBaseName(view)}.${cmd.format}`,
        caption: `📊 ${what} — ${label}${partial}${natureLabel}. Contas e cartões privados não entram.`,
      },
    ],
    transactionIds: [],
    detail: `${what.toLowerCase()} ${cmd.kind === "WEEKLY" ? "semanal" : "mensal"} ${cmd.ref}`,
  };
}
