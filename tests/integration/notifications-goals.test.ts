import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { addDays, addMonths, daysInMonth, formatDayMonthBR, monthKey, todayISO } from "@/lib/dates";
import { createTransaction } from "@/server/modules/transactions/service";
import { createIncomeGoal, listIncomeGoals } from "@/server/modules/income-goals/service";
import { runGoalAlertJobs } from "@/server/modules/goals/alerts";
import { contributeToGoal, createGoal } from "@/server/modules/goals/service";
import { createBill, getBill, markPaid, snoozeBillReminder } from "@/server/modules/bills/service";
import { runBillReminderJobs } from "@/server/modules/bills/jobs";
import { createCard, payStatement } from "@/server/modules/cards/service";
import { updatePreferences } from "@/server/modules/notifications/service";
import { categoryId, createBasicAccounts, createFamily, resetDatabase, type TestFamily } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues } from "./ai-pipeline-support";

/**
 * Notificações e metas com relógio controlado: meta de ganho (faixas, meta batida, ritmo no fim do
 * mês), metas de economia (faixas, prazo, conclusão), conta vencida (repetição a cada 3 dias até 15,
 * "pagar depois", "já paguei") e fatura perto de vencer / vencida. Cada aviso uma vez; preferências
 * respeitadas.
 */

const TZ = "America/Recife";
/** Meio-dia em Recife no dia informado. */
const at = (iso: string) => new Date(`${iso}T15:00:00Z`);
const DAY = 86_400_000;

async function inApp(fam: TestFamily, type: string, memberId = fam.husbandId) {
  return prisma.notification.findMany({ where: { householdId: fam.householdId, type: type as never, channel: "IN_APP", recipientMemberId: memberId }, orderBy: { createdAt: "asc" } });
}

describe("notificações de metas, contas vencidas e faturas", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("meta de ganho: faixas do mês (só a maior nova), 🎉 batida, ritmo no dia 25, repasse fora e preferências", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    // Mês passado inteiro: as datas dos lançamentos já passaram.
    const month = monthKey(addMonths(todayISO(TZ), -1));
    const d = (day: number) => `${month}-${String(day).padStart(2, "0")}`;
    const name = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));

    const empresa = await createIncomeGoal(fam.ctx, { scope: "BUSINESS", targetCents: 1_000_000 });
    const pessoal = await createIncomeGoal(fam.ctx, { scope: "PERSONAL", targetCents: 1_000_000 });
    await expect(createIncomeGoal(fam.ctx, { scope: "BUSINESS", targetCents: 5_000 })).rejects.toThrow(/Já existe uma meta de ganho ativa/);
    const investimentos = await categoryId(fam.householdId, "Investimentos", "INCOME");
    await expect(createIncomeGoal(fam.ctx, { scope: "ALL", targetCents: 5_000, categoryId: await categoryId(fam.householdId, "Alimentação") })).rejects.toThrow(/categoria de receita/);
    const porCategoria = await createIncomeGoal(fam.ctx, { scope: "ALL", targetCents: 100_000, categoryId: investimentos });

    // A esposa desliga a meta de ganho no app e no celular.
    await updatePreferences(fam.wifeCtx, [{ type: "INCOME_GOAL", inApp: false, push: false }]);

    const income = (amountCents: number, date: string, nature: "PERSONAL" | "BUSINESS" | "PASSTHROUGH", description: string, category?: string) =>
      createTransaction(fam.ctx, { type: "INCOME", amountCents, description, date, accountId: itau.id, nature, ...(category ? { categoryId: category } : {}) });
    await income(400_000, d(5), "BUSINESS", "Cliente A");
    await income(200_000, d(6), "PERSONAL", "Salário");
    // Repasse (dinheiro de cliente que só passa pela conta): nunca conta.
    await income(900_000, d(7), "PASSTHROUGH", "Pix cliente X — anúncios");
    await income(360_000, d(8), "BUSINESS", "Cliente B");

    let summary = await runGoalAlertJobs(at(d(10)), { householdId: fam.householdId });
    expect(summary.incomeNotices).toBe(1);
    let notes = await inApp(fam, "INCOME_GOAL");
    // 50% e 75% atingidos de uma vez: avisa só a maior.
    expect(notes.map((n) => n.body)).toEqual([`Meta de ganho de ${name} (Empresa): 75% — R$ 7.600,00 de R$ 10.000,00. Faltam R$ 2.400,00.`]);
    expect(notes[0]!.data).toMatchObject({ incomeGoalId: empresa.id, threshold: 75, url: "/metas" });
    expect(await inApp(fam, "INCOME_GOAL", fam.wifeId)).toHaveLength(0);
    // Mesmo período de novo: nada repetido.
    expect((await runGoalAlertJobs(at(d(10)), { householdId: fam.householdId })).incomeNotices).toBe(0);

    // Depois do dia 10: rendimento na categoria da meta por categoria.
    await income(50_000, d(15), "PERSONAL", "Rendimento CDB", investimentos);

    // Dia 25: Pessoa física abaixo de 75% → um único aviso de ritmo; Empresa (76%) não.
    summary = await runGoalAlertJobs(at(d(26)), { householdId: fam.householdId });
    notes = await inApp(fam, "INCOME_GOAL");
    const [y, m] = month.split("-").map(Number) as [number, number];
    const daysLeft = daysInMonth(y, m) - 26 + 1;
    expect(notes.map((n) => n.body)).toContain(`Faltam R$ 7.500,00 em ${daysLeft} dias para a meta de ganho de ${name} (Pessoa física): R$ 2.500,00 de R$ 10.000,00 (25%).`);
    // A meta por categoria (Investimentos, R$ 1.000): 50% → faixa de 50% e ritmo abaixo de 75%.
    expect(notes.filter((n) => (n.data as { incomeGoalId?: string }).incomeGoalId === porCategoria.id).map((n) => n.title)).toEqual(["Meta de ganho: 50%", "Meta de ganho: reta final"]);
    expect((await runGoalAlertJobs(at(d(27)), { householdId: fam.householdId })).incomeNotices).toBe(0);

    // Bateu a meta da Empresa: 🎉 (90% fica registrado sem aviso).
    await income(250_000, d(20), "BUSINESS", "Cliente C");
    await runGoalAlertJobs(at(d(28)), { householdId: fam.householdId });
    const empresaNotes = (await inApp(fam, "INCOME_GOAL")).filter((n) => (n.data as { incomeGoalId?: string }).incomeGoalId === empresa.id);
    expect(empresaNotes.map((n) => n.body)).toEqual([
      `Meta de ganho de ${name} (Empresa): 75% — R$ 7.600,00 de R$ 10.000,00. Faltam R$ 2.400,00.`,
      `🎉 Meta de ganho de ${name} (Empresa) batida: R$ 10.100,00 de R$ 10.000,00.`,
    ]);
    // WhatsApp ligado por padrão para a meta de ganho (uma mensagem por aviso, para o grupo).
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, type: "INCOME_GOAL", channel: "WHATSAPP" } })).toBe(5);

    const progress = await listIncomeGoals(fam.ctx, { month });
    expect(progress.find((p) => p.id === empresa.id)).toMatchObject({ incomeCents: 1_010_000, percent: 101, reached: true, projectedCents: null, daysLeft: 0 });
    expect(progress.find((p) => p.id === pessoal.id)).toMatchObject({ incomeCents: 250_000, percent: 25, remainingCents: 750_000 });
    expect(progress.find((p) => p.id === porCategoria.id)).toMatchObject({ incomeCents: 50_000, label: "Meta de ganho · Investimentos" });
  });

  it("metas de economia: faixas do valor-alvo, prazo (30 e 7 dias) abaixo do esperado e conclusão", async () => {
    const fam = await createFamily();
    const today = todayISO(TZ);
    const viagem = await createGoal(fam.ctx, { name: "Viagem", targetCents: 100_000 });
    await contributeToGoal(fam.ctx, viagem.id, { amountCents: 55_000 });
    await runGoalAlertJobs(new Date(), { householdId: fam.householdId });
    await contributeToGoal(fam.ctx, viagem.id, { amountCents: 37_000 });
    await runGoalAlertJobs(new Date(), { householdId: fam.householdId });
    await runGoalAlertJobs(new Date(), { householdId: fam.householdId });
    let notes = await inApp(fam, "GOAL_PROGRESS");
    expect(notes.map((n) => n.body)).toEqual([
      'A meta "Viagem" chegou a 50%: R$ 550,00 de R$ 1.000,00. Faltam R$ 450,00.',
      'A meta "Viagem" chegou a 90%: R$ 920,00 de R$ 1.000,00. Faltam R$ 80,00.',
    ]);
    // Concluída: parabéns e a meta fica como concluída.
    await contributeToGoal(fam.ctx, viagem.id, { amountCents: 8_000 });
    await runGoalAlertJobs(new Date(), { householdId: fam.householdId });
    notes = await inApp(fam, "GOAL_PROGRESS");
    expect(notes.at(-1)!.body).toBe('🎉 Parabéns! A meta "Viagem" foi concluída: R$ 1.000,00 de R$ 1.000,00.');
    expect((await prisma.financialGoal.findUniqueOrThrow({ where: { id: viagem.id } })).status).toBe("COMPLETED");
    // Meta concluída há tempo (antes destes avisos): só registra, sem parabéns atrasado.
    const antiga = await createGoal(fam.ctx, { name: "Antiga", targetCents: 10_000 });
    await contributeToGoal(fam.ctx, antiga.id, { amountCents: 10_000 });
    await prisma.financialGoal.update({ where: { id: antiga.id }, data: { updatedAt: new Date(Date.now() - 30 * DAY) } });
    await runGoalAlertJobs(new Date(), { householdId: fam.householdId });
    expect((await inApp(fam, "GOAL_PROGRESS")).some((n) => (n.data as { goalId?: string }).goalId === antiga.id)).toBe(false);
    expect(await prisma.alertMark.count({ where: { householdId: fam.householdId, key: `goal:${antiga.id}:100` } })).toBe(1);

    // Prazo: criada há 10 dias, vence em 40; com 10% guardado está abaixo do ritmo esperado.
    const reserva = await createGoal(fam.ctx, { name: "Reserva", targetCents: 200_000, deadline: addDays(today, 40) });
    await prisma.financialGoal.update({ where: { id: reserva.id }, data: { createdAt: new Date(Date.now() - 10 * DAY) } });
    await contributeToGoal(fam.ctx, reserva.id, { amountCents: 20_000 });
    const now = Date.now();
    expect((await runGoalAlertJobs(new Date(now), { householdId: fam.householdId })).savingsNotices).toBe(0);
    await runGoalAlertJobs(new Date(now + 15 * DAY), { householdId: fam.householdId });
    await runGoalAlertJobs(new Date(now + 16 * DAY), { householdId: fam.householdId });
    await runGoalAlertJobs(new Date(now + 35 * DAY), { householdId: fam.householdId });
    const deadline = (await inApp(fam, "GOAL_PROGRESS")).filter((n) => (n.data as { goalId?: string }).goalId === reserva.id).map((n) => n.body);
    expect(deadline).toEqual([
      'Faltam R$ 1.800,00 e 25 dias para "Reserva"; precisaria guardar R$ 72,00/dia.',
      'Faltam R$ 1.800,00 e 5 dias para "Reserva"; precisaria guardar R$ 360,00/dia.',
    ]);
    // Meta no ritmo esperado não recebe o aviso de prazo.
    const carro = await createGoal(fam.ctx, { name: "Carro", targetCents: 100_000, deadline: addDays(today, 20) });
    await prisma.financialGoal.update({ where: { id: carro.id }, data: { createdAt: new Date(now - 20 * DAY) } });
    await contributeToGoal(fam.ctx, carro.id, { amountCents: 60_000 });
    await runGoalAlertJobs(new Date(now + DAY), { householdId: fam.householdId });
    expect((await inApp(fam, "GOAL_PROGRESS")).filter((n) => (n.data as { goalId?: string }).goalId === carro.id).map((n) => n.title)).toEqual(['Meta "Carro": 50%']);
  });

  it("conta vencida: dia seguinte, a cada 3 dias até 15; 'pagar depois' adia; 'já paguei' para os avisos", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const due = addDays(today, -1);
    const aluguel = await createBill(fam.ctx, { description: "Aluguel Larissa", amountCents: 150_000, dueDate: due, accountId: nubank.id });
    // Vencida há mais de 15 dias: não é mais lembrada.
    await createBill(fam.ctx, { description: "Conta antiga", amountCents: 9_000, dueDate: addDays(today, -16) });
    const now = Date.now();
    const run = (days: number) => runBillReminderJobs(new Date(now + days * DAY), { householdId: fam.householdId });

    expect((await run(0)).overdueReminders).toBe(1);
    expect((await run(0)).overdueReminders).toBe(0);
    expect((await run(1)).overdueReminders).toBe(0);
    let notes = await inApp(fam, "BILL_OVERDUE");
    expect(notes[0]!.body).toBe(
      `⚠️ Aluguel Larissa venceu ontem (${formatDayMonthBR(due)}) e não foi marcada como paga (R$ 1.500,00). Já pagou? Marque como paga em Contas a pagar — ou escolha "pagar depois" para lembrar em 3 dias.`,
    );
    expect(notes[0]!.data).toMatchObject({ scheduledPaymentId: aluguel.id, daysLate: 1, stage: "OVERDUE", url: "/contas-a-pagar" });

    // Dia 4 de atraso: repete.
    expect((await run(3)).overdueReminders).toBe(1);
    // "Pagar depois": adia por 3 dias (o aviso do dia 7 de atraso espera até o fim do adiamento).
    const snoozed = await snoozeBillReminder(fam.ctx, aluguel.id, {});
    expect(snoozed.reminderSnoozedUntil).toBe(addDays(today, 3));
    expect((await run(6 - 3 - 1)).overdueReminders).toBe(0);
    expect((await run(6)).overdueReminders).toBe(1);
    notes = await inApp(fam, "BILL_OVERDUE");
    expect(notes.map((n) => (n.data as { daysLate: number }).daysLate)).toEqual([1, 4, 7]);
    expect(notes[2]!.body).toContain(`venceu há 7 dias (${formatDayMonthBR(due)})`);

    // "Já paguei": a conta paga não é mais lembrada.
    await markPaid(fam.ctx, aluguel.id, { date: today, accountId: nubank.id });
    expect((await getBill(fam.ctx, aluguel.id)).status).toBe("PAID");
    expect((await run(9)).overdueReminders).toBe(0);
    expect((await run(12)).overdueReminders).toBe(0);
    expect(await inApp(fam, "BILL_OVERDUE")).toHaveLength(3);
    await expect(snoozeBillReminder(fam.ctx, aluguel.id, {})).rejects.toThrow(/não está em aberto/);
  });

  it("fatura: N dias antes do vencimento, no dia e vencida sem pagamento (uma vez cada); WhatsApp ligado por padrão", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const card = await createCard(fam.ctx, { name: "Cartão Azul", closingDay: 3, dueDay: 10, dueReminderDays: 3, paymentAccountId: nubank.id });
    const silent = await createCard(fam.ctx, { name: "Cartão Só no Dia", closingDay: 3, dueDay: 10, dueReminderDays: 0 });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 45_000, description: "Mercado", date: today, creditCardId: card.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 10_000, description: "Farmácia", date: today, creditCardId: silent.id });
    const statement = await prisma.creditCardStatement.findFirstOrThrow({ where: { creditCardId: card.id } });
    const dueISO = statement.dueDate.toISOString().slice(0, 10);
    const run = (iso: string) => runBillReminderJobs(at(iso), { householdId: fam.householdId });

    await run(addDays(dueISO, -4));
    await run(addDays(dueISO, -3));
    await run(addDays(dueISO, -2));
    await run(dueISO);
    await run(dueISO);
    await run(addDays(dueISO, 1));
    await run(addDays(dueISO, 2));
    await run(addDays(dueISO, 20));
    const notes = await inApp(fam, "STATEMENT_DUE");
    const of = (cardId: string) => notes.filter((n) => (n.data as { creditCardId: string }).creditCardId === cardId).map((n) => (n.data as { stage: string }).stage);
    expect(of(card.id)).toEqual(["SOON", "TODAY", "OVERDUE"]);
    // Cartão com lembrete "só no dia": sem o aviso antecipado.
    expect(of(silent.id)).toEqual(["TODAY", "OVERDUE"]);
    const azul = notes.filter((n) => (n.data as { creditCardId: string }).creditCardId === card.id);
    expect(azul[0]!.body).toMatch(new RegExp(`do Cartão Azul vence em 3 dias \\(${formatDayMonthBR(dueISO)}\\): R\\$ 450,00 em aberto\\.$`));
    expect(azul[1]!.body).toMatch(/do Cartão Azul vence hoje: R\$ 450,00 em aberto\.$/);
    expect(azul[2]!.body).toMatch(new RegExp(`^⚠️ A fatura de .* do Cartão Azul venceu ontem \\(${formatDayMonthBR(dueISO)}\\) e não foi paga: R\\$ 450,00 em aberto\\.`));
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, type: "STATEMENT_DUE", channel: "WHATSAPP" } })).toBe(5);

    // Fatura paga: sem avisos na fatura seguinte desse ciclo.
    const before = notes.length;
    await payStatement(fam.ctx, statement.id, { accountId: nubank.id, date: today });
    await run(addDays(dueISO, 3));
    expect(await inApp(fam, "STATEMENT_DUE")).toHaveLength(before);
  });
});

describe("WhatsApp: meta de ganho", () => {
  beforeAll(() => initTestQueues("wa-income-goal"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("'meta de ganho da empresa 30 mil' cria/atualiza; 'qual minha meta de ganho?' e 'quanto falta pra meta?' respondem", async () => {
    const fam = await createWaFamily("Família Meta de Ganho");
    const none = await sendMessage(fam, { text: "qual minha meta de ganho?" });
    expect(none.reply).toContain("Ainda não há meta de ganho");

    const created = await sendMessage(fam, { text: "meta de ganho da empresa 30 mil" });
    expect(created.reply).toContain("🎯 Meta de ganho da Empresa criada: R$ 30.000,00 por mês.");
    expect(await prisma.incomeGoal.findMany({ where: { householdId: fam.householdId }, select: { scope: true, targetCents: true } })).toEqual([{ scope: "BUSINESS", targetCents: 3_000_000 }]);

    const updated = await sendMessage(fam, { text: "meta de ganho da empresa 35 mil" });
    expect(updated.reply).toContain("atualizada: R$ 30.000,00 → R$ 35.000,00 por mês");
    expect(await prisma.incomeGoal.count({ where: { householdId: fam.householdId } })).toBe(1);

    const asked = await sendMessage(fam, { text: "quanto falta pra meta?" });
    expect(asked.reply).toMatch(/Meta de ganho · Empresa \(.+\): R\$ 0,00 de R\$ 35\.000,00 \(0%\) — faltam R\$ 35\.000,00/);
    // Nada virou lançamento.
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
  });
});
