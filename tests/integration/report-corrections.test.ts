import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as Array<{ householdId: string; text: string; dedupeKey?: string }>);
vi.mock("@/server/whatsapp/outbound", () => ({
  enqueueOutboundMessage: async (m: { householdId: string; text: string; dedupeKey?: string }) => {
    sent.push(m);
    return { queued: true };
  },
}));

import { prisma } from "@/server/db";
import { createTransaction } from "@/server/modules/transactions/service";
import { processScheduledReports } from "@/server/modules/reports/jobs";
import { updateReportSchedule } from "@/server/modules/reports/service";
import { MONTHLY_CORRECTIONS, resendCorrectedMonthlyReport } from "@/server/modules/reports/corrections";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";

/** Reenvio do resumo de outubro corrigido: só quem recebeu, só se mudou, uma vez. */
const PLAN = MONTHLY_CORRECTIONS.find((p) => p.month === "2026-10")!;

async function familyWithOctoberReport(withInstallments: boolean, sendWhatsApp = true) {
  const fam = await createFamily();
  const { nubank, card } = await createBasicAccounts(fam.ctx);
  await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 20_000, description: "Mercado", date: "2026-10-10", accountId: nubank.id });
  if (withInstallments) await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 300_000, description: "TV", date: "2026-10-15", creditCardId: card.id, installmentCount: 10 });
  await updateReportSchedule(fam.ctx, "MONTHLY", { sendWhatsApp, dayOfMonth: 1, hour: 8 });
  await prisma.reportSchedule.update({ where: { householdId_type: { householdId: fam.householdId, type: "MONTHLY" } }, data: { nextRunAt: new Date("2026-11-01T11:00:00Z") } });
  return fam;
}

describe("reenvio do resumo mensal corrigido", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
  });

  it("recalcula o resumo de outubro, reenvia só para quem teve diferença, uma vez, com a explicação", async () => {
    // Resumo automático só no app (o padrão): o reenvio corrigido vai também ao WhatsApp.
    const withTv = await familyWithOctoberReport(true, false);
    const plain = await familyWithOctoberReport(false);
    // Parcelado comprado em agosto: antes não contava nada em outubro; agora conta a 3ª parcela.
    const older = await familyWithOctoberReport(false, false);
    const { card: olderCard } = await prisma.creditCard.findFirstOrThrow({ where: { householdId: older.householdId } }).then((card) => ({ card }));
    await createTransaction(older.ctx, { type: "EXPENSE", amountCents: 120_000, description: "Geladeira", date: "2026-08-20", creditCardId: olderCard.id, installmentCount: 6 });
    const noReport = await createFamily(); // sem resumo automático de outubro: não recebe nada
    await processScheduledReports(new Date("2026-11-01T12:00:00Z"));
    expect(sent).toHaveLength(1); // só a família com WhatsApp no agendamento
    // Simula o resumo enviado antes da correção: TV inteira (R$ 3.000) no mês da compra.
    const old = await prisma.report.findFirstOrThrow({ where: { householdId: withTv.householdId, type: "MONTHLY" } });
    const data = old.data as { totals: { expenseCents: number; incomeCents: number; resultCents: number } };
    expect(data.totals.expenseCents).toBe(20_000 + 30_000);
    data.totals = { incomeCents: 0, expenseCents: 320_000, resultCents: -320_000 };
    await prisma.report.update({ where: { id: old.id }, data: { data: data as object } });
    sent.length = 0;

    const results = await resendCorrectedMonthlyReport(PLAN, new Date("2026-11-02T12:00:00Z"));
    expect(results.map((r) => [r.householdId, r.status]).sort()).toEqual(
      [
        [withTv.householdId, "resent"],
        [plain.householdId, "unchanged"],
        [older.householdId, "resent"],
      ].sort(),
    );
    expect(sent.map((m) => m.householdId).sort()).toEqual([withTv.householdId, older.householdId].sort());
    sent.sort((a) => (a.householdId === withTv.householdId ? -1 : 1));
    expect(sent[0]!.text).toContain("Por um erro interno");
    expect(sent[0]!.text).toMatch(/Gasto: R\$\s500,00/);
    expect(sent.some((m) => m.householdId === noReport.householdId)).toBe(false);
    // O relatório guardado ficou certo, sem criar outro.
    const fixed = await prisma.report.findMany({ where: { householdId: withTv.householdId, type: "MONTHLY" } });
    expect(fixed).toHaveLength(1);
    expect((fixed[0]!.data as typeof data).totals.expenseCents).toBe(50_000);

    // Rodar de novo não repete; depois do prazo não faz nada.
    expect((await resendCorrectedMonthlyReport(PLAN, new Date("2026-11-02T13:00:00Z"))).every((r) => r.status === "already_done")).toBe(true);
    expect(await resendCorrectedMonthlyReport(PLAN, new Date("2026-11-21T12:00:00Z"))).toEqual([]);
    expect(sent).toHaveLength(2);
  });
});
