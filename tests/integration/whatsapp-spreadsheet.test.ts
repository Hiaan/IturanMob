import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues } from "./ai-pipeline-support";
import { messySheet, simpleList } from "../fixtures/migration/build";
import { processSpreadsheet } from "@/server/ai/engine/spreadsheet-import";

/**
 * Planilha enviada no grupo → assistente "Migrar de planilha" (o mesmo do site): o bot responde
 * com o link; nada é importado pela conversa.
 */

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("WhatsApp: planilha vai para o assistente de migração", () => {
  beforeAll(() => initTestQueues("wa-spreadsheet"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("xlsx no grupo → migração criada e link na resposta, sem importar nada", async () => {
    const fam = await createWaFamily();
    const sent = await sendMessage(fam, { type: "DOCUMENT", media: { bytes: await messySheet(), mimeType: XLSX, fileName: "controle 2025.xlsx" } });
    const migration = await prisma.spreadsheetMigration.findFirstOrThrow({ where: { householdId: fam.householdId } });
    expect(migration.status).toBe("READY");
    expect(migration.origin).toMatchObject({ channel: "WHATSAPP" });
    expect(sent.reply).toContain("📊 Recebi a planilha *controle 2025.xlsx*");
    expect(sent.reply).toContain("1 aba(s) com lançamentos (19 linhas) e 3 ignorada(s)");
    expect(sent.reply).toContain(`/importacao/migrar?id=${migration.id}`);
    expect(sent.reply).toContain("nada é importado antes disso");
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    expect(await prisma.importBatch.count({ where: { householdId: fam.householdId } })).toBe(0);
  });

  it("CSV também vale; a mesma mensagem reprocessada não cria outra migração", async () => {
    const fam = await createWaFamily();
    const csv = Buffer.from("Data;Descrição;Valor\n05/01/2025;Padaria;-12,50\n06/01/2025;Salário;3.000,00\n", "utf8");
    const first = await sendMessage(fam, { type: "DOCUMENT", media: { bytes: csv, mimeType: "text/csv", fileName: "extrato.csv" } });
    expect(first.reply).toContain("📊 Recebi a planilha *extrato.csv*");
    expect(await prisma.spreadsheetMigration.count({ where: { householdId: fam.householdId } })).toBe(1);
    // Reprocessar a mesma mensagem devolve o link da migração existente.
    const att = await prisma.attachment.findFirstOrThrow({ where: { householdId: fam.householdId, originalName: "extrato.csv" } });
    const again = await processSpreadsheet(fam.ctx, { id: first.messageId, chatId: first.message.chatId }, att);
    expect(again.replies[0]).toContain("já está no assistente de migração");
    expect(await prisma.spreadsheetMigration.count({ where: { householdId: fam.householdId } })).toBe(1);
    const xlsx = await sendMessage(fam, { type: "DOCUMENT", media: { bytes: await simpleList(), mimeType: XLSX, fileName: "lista.xlsx" } });
    expect(xlsx.reply).toContain("/importacao/migrar?id=");
    expect(await prisma.spreadsheetMigration.count({ where: { householdId: fam.householdId } })).toBe(2);
  });
});
