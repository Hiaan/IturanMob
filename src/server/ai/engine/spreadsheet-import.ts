import type { Attachment } from "@prisma/client";
import { prisma } from "../../db";
import type { ServiceContext } from "../../auth/context";
import { can } from "../../auth/permissions";
import { env } from "../../env";
import { AppError } from "../../errors";
import { readStoredFile } from "../../storage";
import { findMigrationByOriginMessage, getMigration, startMigration } from "../../modules/migration/service";
import type { ActionOutcome } from "./actions";

/**
 * Planilha (.xlsx, .xls, .ods, .csv) enviada no grupo → assistente "Migrar de planilha" (o mesmo do
 * site). A conversa só devolve o link: abas, colunas e correspondências se conferem na tela, e
 * nada é importado sem confirmação.
 */

const SHEET_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
  "text/comma-separated-values",
  "application/csv",
]);

export function isSpreadsheetAttachment(att: Pick<Attachment, "mimeType" | "originalName">): boolean {
  return SHEET_MIME.has(att.mimeType.split(";")[0]!.trim().toLowerCase()) || /\.(xlsx|xlsm|xls|ods|csv)$/i.test(att.originalName ?? "");
}

function migrationLink(id: string) {
  return `${env().APP_URL.replace(/\/$/, "")}/importacao/migrar?id=${id}`;
}

export async function processSpreadsheet(ctx: ServiceContext, message: { id: string; chatId: string }, att: Attachment): Promise<ActionOutcome> {
  if (!can(ctx.role, "data:import")) {
    return { status: "IGNORED", intent: "SPREADSHEET", replies: ["Seu perfil não pode importar planilhas. Peça a um administrador da família."], transactionIds: [], detail: "sem permissão de importação" };
  }
  const fileName = att.originalName?.trim() || "planilha.xlsx";
  const existing = await findMigrationByOriginMessage(ctx, message.id);
  if (existing) {
    return { status: "PROCESSED", intent: "SPREADSHEET", replies: [`📊 Esta planilha já está no assistente de migração: ${migrationLink(existing.id)}`], transactionIds: [] };
  }
  if (!att.storageKey) {
    return { status: "PROCESSED", intent: "SPREADSHEET", replies: ["Não consegui acessar a planilha. Envie novamente."], transactionIds: [], detail: "planilha sem arquivo" };
  }
  try {
    const m = await startMigration(ctx, { fileName, content: await readStoredFile(att.storageKey), origin: { channel: "WHATSAPP", chatId: message.chatId, messageId: message.id } });
    await prisma.attachment.update({ where: { id: att.id }, data: { processingStatus: "EXTRACTED", extractedData: { migrationId: m.id } } });
    const fresh = m.status === "READY" ? await getMigration(ctx, m.id) : m;
    const lines = [`📊 Recebi a planilha *${fileName.slice(0, 80)}*.`];
    if (fresh.status === "READY") {
      const used = fresh.sheets.filter((s) => s.selected);
      const ignored = fresh.sheets.length - used.length;
      const rows = used.reduce((n, s) => n + s.dataRows, 0);
      lines.push(`• ${used.length} aba(s) com lançamentos (${rows.toLocaleString("pt-BR")} linhas)${ignored ? ` e ${ignored} ignorada(s) (resumo/gráfico)` : ""}`);
      const pending = Object.values(fresh.pending).reduce((a, b) => a + b, 0);
      if (pending) lines.push(`• ${pending} nome(s) de categoria/conta/pessoa para conferir no De → Para`);
      if (fresh.template) lines.push(`• Formato reconhecido: *${fresh.template.name}* (só pergunto o que for novo)`);
    } else if (fresh.status === "FAILED") {
      return { status: "PROCESSED", intent: "SPREADSHEET", replies: [`📊 Não consegui ler a planilha: ${fresh.error ?? "formato não reconhecido"}.`], transactionIds: [] };
    } else {
      lines.push("Estou lendo as abas e as colunas.");
    }
    lines.push(`Abra o assistente para conferir as correspondências e confirmar a migração (nada é importado antes disso): ${migrationLink(m.id)}`);
    return { status: "PROCESSED", intent: "SPREADSHEET", replies: [lines.join("\n")], transactionIds: [], detail: "planilha enviada ao assistente de migração" };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return { status: "PROCESSED", intent: "SPREADSHEET", replies: [`📊 ${err.message}`], transactionIds: [] };
  }
}
