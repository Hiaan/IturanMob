import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount, getAccount } from "@/server/modules/accounts/service";
import { createCard, listCards } from "@/server/modules/cards/service";
import { dashboardSummary } from "@/server/modules/analytics/service";
import { todayISO } from "@/lib/dates";
import { resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues, TZ } from "./ai-pipeline-support";

/** "Desconsiderar" pelo WhatsApp: repasse de cliente sai dos relatórios; saldo e fatura não mudam. */

async function family() {
  const fam = await createWaFamily("Família Repasse");
  const itau = await createAccount(fam.ctx, { name: "Itaú", institution: "Itaú", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-01-01" });
  const card = await createCard(fam.ctx, { name: "Nubank", issuer: "Nubank", closingDay: 3, dueDay: 10, limitCents: 500_000, paymentAccountId: itau.id });
  return { fam, itau, card };
}

async function botReplyTo(householdId: string, inboundExternalId: string) {
  return prisma.whatsAppMessage.findFirstOrThrow({ where: { householdId, direction: "OUTBOUND", quotedExternalId: inboundExternalId }, orderBy: { createdAt: "asc" } });
}

describe("WhatsApp: desconsiderar nos relatórios", () => {
  beforeAll(() => initTestQueues("wa-report-exclusion"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("'o pix do fulano é repasse' e 'desconsidera esse' (citando a confirmação); 'considerar de novo' desfaz", async () => {
    const { fam, itau } = await family();
    const today = todayISO(TZ);
    const month = { start: `${today.slice(0, 7)}-01`, end: today };

    const pix = await sendMessage(fam, { text: "recebi 500 de pix do Fulano" });
    expect(pix.reply).toContain("Receita registrada");
    const balanceAfterPix = (await getAccount(fam.ctx, itau.id)).balanceCents;
    expect(balanceAfterPix).toBe(150_000);

    const rep = await sendMessage(fam, { text: "o pix do fulano é repasse" });
    expect(rep.reply).toContain("Desconsiderado nos relatórios (repasse de cliente · Fulano)");
    expect(rep.reply).toContain("O saldo da conta e a fatura do cartão não mudam.");
    const income = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, type: "INCOME" } });
    expect(income).toMatchObject({ excludedFromReports: true, exclusionReason: "CLIENT_PASSTHROUGH", exclusionParty: "Fulano" });
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(balanceAfterPix);

    // Gasto no cartão; responde citando a confirmação do robô.
    const ads = await sendMessage(fam, { text: "gastei 300 no facebook ads no cartão nubank" });
    expect(ads.reply).toMatch(/Despesa registrada|registrad/i);
    const outstandingBefore = (await listCards(fam.ctx))[0]!.outstandingCents;
    const confirmation = await botReplyTo(fam.householdId, ads.externalId);
    const quoted = await sendMessage(fam, { text: "desconsidera esse, é repasse do Fulano", quotedExternalId: confirmation.externalId });
    expect(quoted.reply).toContain("Desconsiderado nos relatórios (repasse de cliente · Fulano)");
    expect(quoted.reply).toContain("Repasse com Fulano: recebido R$ 500,00, gasto R$ 300,00 → recebido a mais R$ 200,00.");
    const expense = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, type: "EXPENSE" } });
    expect(expense).toMatchObject({ excludedFromReports: true, exclusionParty: "Fulano" });
    // Fatura e saldo iguais; relatório do mês sem receita nem despesa.
    expect((await listCards(fam.ctx))[0]!.outstandingCents).toBe(outstandingBefore);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(balanceAfterPix);
    const summary = await dashboardSummary(fam.ctx, { period: month, regime: "ACCRUAL" });
    expect([summary.incomeCents, summary.expenseCents]).toEqual([0, 0]);

    // Desfazer: o último desconsiderado por quem escreveu volta a contar.
    const undo = await sendMessage(fam, { text: "considerar de novo" });
    expect(undo.reply).toContain("Voltou a contar nos relatórios");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: expense.id } })).excludedFromReports).toBe(false);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: income.id } })).excludedFromReports).toBe(true);
  });

  it("'recebi 200 do Beltrano, é repasse' registra e já desconsidera; vários candidatos → pergunta e aceita 'todos'", async () => {
    const { fam } = await family();
    const both = await sendMessage(fam, { text: "recebi 200 do Beltrano, é repasse" });
    expect(both.reply).toContain("Receita registrada");
    expect(both.reply).toContain("Desconsiderado nos relatórios (repasse de cliente · Beltrano)");
    const first = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, type: "INCOME" } });
    expect(first).toMatchObject({ excludedFromReports: true, exclusionParty: "Beltrano", amountCents: 20_000 });
    // O marcador não vira descrição; o aviso vem logo depois da confirmação do registro.
    expect(first.description.toLowerCase()).not.toContain("repasse");
    expect(both.replies[1]).toContain("Desconsiderado nos relatórios");

    await sendMessage(fam, { text: "recebi 150 de pix do Sicrano" });
    await sendMessage(fam, { text: "recebi 90 de pix do Sicrano" });
    const ask = await sendMessage(fam, { text: "o pix do sicrano é repasse" });
    expect(ask.reply).toContain("Encontrei 2 lançamentos de Sicrano");
    expect(ask.reply).toContain("Responda com o número ou *todos*");
    const all = await sendMessage(fam, { text: "todos" });
    expect(all.reply).toContain("Desconsiderado nos relatórios (repasse de cliente · Sicrano)");
    const sicrano = await prisma.transaction.findMany({ where: { householdId: fam.householdId, exclusionParty: "Sicrano" } });
    expect(sicrano).toHaveLength(2);
  });

  it("'desconsidera a mensagem anterior' continua sendo excluir o último lançamento, não desconsiderar", async () => {
    const { fam } = await family();
    await sendMessage(fam, { text: "gastei 40 de padaria no itaú" });
    const res = await sendMessage(fam, { text: "desconsidera a mensagem anterior" });
    expect(res.reply).not.toContain("Desconsiderado nos relatórios");
    const tx = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId } });
    expect(tx.excludedFromReports).toBe(false);
  });
});
