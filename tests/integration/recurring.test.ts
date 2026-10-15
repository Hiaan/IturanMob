import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { addDays, addMonths, dateToISO, isoToDate, todayISO } from "@/lib/dates";
import { getAccount } from "@/server/modules/accounts/service";
import { markPaid } from "@/server/modules/bills/service";
import { occurrencesBetween } from "@/server/modules/recurring/schedule";
import { createRecurring, deleteRecurring, getRecurring, listRecurring, setRecurringActive, updateRecurring } from "@/server/modules/recurring/service";
import { runRecurringJobs } from "@/server/modules/recurring/jobs";
import { categoryId, createBasicAccounts, createFamily, resetDatabase, subcategory } from "./helpers";

const TZ = "America/Recife";

function dayOf(iso: string) {
  return Number(iso.slice(8, 10));
}

async function occurrences(recurringTransactionId: string) {
  return prisma.scheduledPayment.findMany({ where: { recurringTransactionId }, orderBy: { dueDate: "asc" } });
}

describe("recorrências", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("gera as ocorrências dos próximos 60 dias de forma idempotente", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const internet = await subcategory(fam.householdId, "Internet");
    const rec = await createRecurring(fam.ctx, {
      description: "Internet Vivo Fibra",
      amountCents: 12_000,
      subcategoryId: internet.id,
      frequency: "MONTHLY",
      dayOfMonth: 20,
      startDate: today,
      accountId: nubank.id,
    });
    expect(rec.category?.name).toBe("Moradia");
    const expected = occurrencesBetween({ frequency: "MONTHLY", dayOfMonth: 20, startDate: today }, today, addDays(today, 60));
    let occ = await occurrences(rec.id);
    expect(occ.map((o) => dateToISO(o.dueDate))).toEqual(expected);
    expect(occ.every((o) => o.status === "PENDING" && o.amountCents === 12_000 && !o.isEstimate && o.accountId === nubank.id)).toBe(true);

    const first = await runRecurringJobs(new Date(), { householdId: fam.householdId });
    const second = await runRecurringJobs();
    expect(first).toMatchObject({ generated: 0, posted: 0 });
    expect(second).toMatchObject({ households: 1, generated: 0, posted: 0 });
    occ = await occurrences(rec.id);
    expect(occ).toHaveLength(expected.length);

    // Em uma data futura, o job estende o horizonte sem duplicar.
    const later = new Date(Date.now() + 40 * 86_400_000);
    const ext = await runRecurringJobs(later);
    const expectedLater = occurrencesBetween({ frequency: "MONTHLY", dayOfMonth: 20, startDate: today }, today, addDays(todayISO(TZ, later), 60));
    expect(ext.generated).toBe(expectedLater.length - expected.length);
    expect(await occurrences(rec.id)).toHaveLength(expectedLater.length);
    expect((await runRecurringJobs(later)).generated).toBe(0);
  });

  it("valida categoria, conta e lançamento automático", async () => {
    const fam = await createFamily();
    const { nubank, card } = await createBasicAccounts(fam.ctx);
    const work = await categoryId(fam.householdId, "Trabalho", "INCOME");
    await expect(createRecurring(fam.ctx, { description: "Aluguel", amountCents: 1, categoryId: work })).rejects.toThrow(/categoria de despesa/);
    await expect(createRecurring(fam.ctx, { description: "Netflix", amountCents: 1, autoPost: true })).rejects.toThrow(/informe a conta ou o cartão/);
    await expect(createRecurring(fam.ctx, { type: "INCOME", description: "Salário", amountCents: 1, creditCardId: card.id })).rejects.toThrow(/cartão/);
    await expect(createRecurring(fam.ctx, { description: "X", amountCents: 1, startDate: "2026-10-10", endDate: "2026-10-01" })).rejects.toThrow(/data final/);
    const viaCard = await createRecurring(fam.ctx, { description: "Spotify", amountCents: 2_190, creditCardId: card.id, accountId: nubank.id });
    expect(viaCard.creditCard?.id).toBe(card.id);
    expect(viaCard.account).toBeNull();
    expect(viaCard.paymentMethod).toBe("CREDIT_CARD");
  });

  it("lançamento automático cria uma única transação vinculada à ocorrência", async () => {
    const fam = await createFamily();
    const { nubank, card } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const streaming = await subcategory(fam.householdId, "Streaming");
    const rec = await createRecurring(fam.ctx, {
      description: "Netflix",
      amountCents: 5_990,
      subcategoryId: streaming.id,
      merchantName: "Netflix",
      paymentMethod: "AUTO_DEBIT",
      accountId: nubank.id,
      dayOfMonth: dayOf(today),
      startDate: today,
      autoPost: true,
    });
    const res1 = await runRecurringJobs(new Date(), { householdId: fam.householdId });
    expect(res1.posted).toBe(1);
    const res2 = await runRecurringJobs(new Date(), { householdId: fam.householdId });
    expect(res2.posted).toBe(0);

    const txs = await prisma.transaction.findMany({ where: { householdId: fam.householdId } });
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ source: "RECURRING", recurringTransactionId: rec.id, amountCents: 5_990, status: "CONFIRMED", subcategoryId: streaming.id, paymentMethod: "AUTO_DEBIT" });
    const sp = await prisma.scheduledPayment.findFirstOrThrow({ where: { recurringTransactionId: rec.id, dueDate: isoToDate(today) } });
    expect(sp).toMatchObject({ status: "PAID", transactionId: txs[0]!.id });
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(100_000 - 5_990);

    // Assinatura no cartão: ocorrência fica "Lançada" (POSTED) e entra na fatura.
    const onCard = await createRecurring(fam.ctx, { description: "Spotify", amountCents: 2_190, creditCardId: card.id, dayOfMonth: dayOf(today), startDate: today, autoPost: true });
    expect((await runRecurringJobs(new Date(), { householdId: fam.householdId })).posted).toBe(1);
    const cardOcc = await prisma.scheduledPayment.findFirstOrThrow({ where: { recurringTransactionId: onCard.id, dueDate: isoToDate(today) } });
    expect(cardOcc.status).toBe("POSTED");
    expect(await prisma.installment.count({ where: { transactionId: cardOcc.transactionId! } })).toBe(1);

    // Valor variável: lançado como "aguardando confirmação" (não altera o saldo até confirmar).
    const energy = await subcategory(fam.householdId, "Energia");
    await createRecurring(fam.ctx, { description: "Energia", amountCents: 18_000, isVariableAmount: true, subcategoryId: energy.id, accountId: nubank.id, dayOfMonth: dayOf(today), startDate: today, autoPost: true });
    expect((await runRecurringJobs(new Date(), { householdId: fam.householdId })).posted).toBe(1);
    const pendingTx = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, description: "Energia" } });
    expect(pendingTx.status).toBe("PENDING");
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(100_000 - 5_990);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(3);
  });

  it("falha no lançamento automático vira pendência (sem perder a conta prevista)", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const rec = await createRecurring(fam.ctx, { description: "Academia", amountCents: 9_900, accountId: nubank.id, dayOfMonth: dayOf(today), startDate: today, autoPost: true });
    // Força uma falha de validação no lançamento: categoria de receita na ocorrência de despesa.
    const income = await categoryId(fam.householdId, "Trabalho", "INCOME");
    await prisma.scheduledPayment.updateMany({ where: { recurringTransactionId: rec.id }, data: { categoryId: income } });
    const res = await runRecurringJobs(new Date(), { householdId: fam.householdId });
    expect(res).toMatchObject({ posted: 0, failed: 1 });
    const pending = await prisma.pendingItem.findMany({ where: { householdId: fam.householdId, type: "PROCESSING_FAILED" } });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.description).toMatch(/categoria de despesa/);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    const sp = await prisma.scheduledPayment.findFirstOrThrow({ where: { recurringTransactionId: rec.id, dueDate: isoToDate(today) } });
    expect(sp.status).toBe("PENDING");
    // Nova execução não duplica a pendência.
    await runRecurringJobs(new Date(), { householdId: fam.householdId });
    expect(await prisma.pendingItem.count({ where: { householdId: fam.householdId, type: "PROCESSING_FAILED" } })).toBe(1);
  });

  it("editar regenera somente ocorrências futuras pendentes (as pagas não mudam)", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const rec = await createRecurring(fam.ctx, { description: "Internet", amountCents: 12_000, accountId: nubank.id, dayOfMonth: dayOf(today), startDate: today });
    const before = await occurrences(rec.id);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const paid = before[0]!;
    expect(dateToISO(paid.dueDate)).toBe(today);
    await markPaid(fam.ctx, paid.id, { accountId: nubank.id, date: today });

    // Ocorrência futura editada individualmente (ex.: valor real informado) e outra ignorada.
    const second = before[1]!;
    await prisma.scheduledPayment.update({ where: { id: second.id }, data: { notes: "Plano promocional" } });

    const updated = await updateRecurring(fam.ctx, rec.id, { amountCents: 15_000, description: "Internet Vivo" });
    expect(updated.amountCents).toBe(15_000);
    expect(updated.occurrences.removed).toBe(0);
    let after = await occurrences(rec.id);
    const paidAfter = after.find((o) => o.id === paid.id)!;
    expect(paidAfter).toMatchObject({ status: "PAID", amountCents: 12_000, description: "Internet" });
    const future = after.filter((o) => o.status === "PENDING");
    expect(future.every((o) => o.amountCents === 15_000 && o.description === "Internet Vivo")).toBe(true);
    expect(future.find((o) => o.id === second.id)?.notes).toBe("Plano promocional");

    // Mudança de agenda: datas antigas pendentes são removidas e as novas criadas; a paga permanece.
    const newDay = dayOf(today) === 28 ? 27 : 28;
    const moved = await updateRecurring(fam.ctx, rec.id, { dayOfMonth: newDay });
    expect(moved.occurrences.removed).toBeGreaterThan(0);
    after = await occurrences(rec.id);
    expect(after.find((o) => o.id === paid.id)?.status).toBe("PAID");
    const pendingDates = after.filter((o) => o.status === "PENDING").map((o) => dateToISO(o.dueDate));
    expect(pendingDates).toEqual(
      occurrencesBetween({ frequency: "MONTHLY", dayOfMonth: newDay, startDate: today }, today, addDays(today, 60)).filter((d) => d !== today),
    );
    const audit = await prisma.auditLog.findMany({ where: { entityType: "RecurringTransaction", entityId: rec.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["CREATE", "UPDATE", "UPDATE"]);
  });

  it("desativar cancela ocorrências futuras; reativar restaura", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const rec = await createRecurring(fam.ctx, { description: "Academia", amountCents: 9_900, accountId: nubank.id, frequency: "WEEKLY", startDate: addDays(today, 1) });
    const total = (await occurrences(rec.id)).length;
    expect(total).toBeGreaterThanOrEqual(8);

    const off = await setRecurringActive(fam.ctx, rec.id, false);
    expect(off.active).toBe(false);
    expect(off.affectedOccurrences).toBe(total);
    expect((await occurrences(rec.id)).every((o) => o.status === "CANCELLED")).toBe(true);
    expect((await runRecurringJobs(new Date(), { householdId: fam.householdId })).generated).toBe(0);
    expect(off.nextOccurrence).toBeNull();

    const on = await setRecurringActive(fam.ctx, rec.id);
    expect(on.active).toBe(true);
    expect((await occurrences(rec.id)).every((o) => o.status === "PENDING")).toBe(true);
    expect(on.nextOccurrence).toBe(addDays(today, 1));
  });

  it("lista com próxima ocorrência e total mensal equivalente; exclusão preserva o histórico pago", async () => {
    const fam = await createFamily();
    const { nubank, itau } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const internet = await createRecurring(fam.ctx, { description: "Internet", amountCents: 12_000, accountId: nubank.id, dayOfMonth: dayOf(today), startDate: today });
    await createRecurring(fam.ctx, { description: "IPVA", amountCents: 120_000, frequency: "YEARLY", startDate: addMonths(today, 3) });
    await createRecurring(fam.ctx, { type: "INCOME", description: "Salário", amountCents: 800_000, categoryId: await categoryId(fam.householdId, "Trabalho", "INCOME"), accountId: itau.id, dayOfMonth: 5, startDate: today });
    const inactive = await createRecurring(fam.ctx, { description: "Antiga", amountCents: 50_000, active: false });
    expect(await prisma.scheduledPayment.count({ where: { recurringTransactionId: inactive.id } })).toBe(0);

    const list = await listRecurring(fam.ctx);
    expect(list.items).toHaveLength(4);
    expect(list.totals).toMatchObject({ activeCount: 3, monthlyExpenseCents: 22_000, monthlyIncomeCents: 800_000, monthlyNetCents: 778_000 });
    const item = list.items.find((i) => i.id === internet.id)!;
    expect(item.nextOccurrence).toBe(today);
    expect(item.scheduleLabel).toBe(`Mensal, todo dia ${dayOf(today)}`);
    expect((await listRecurring(fam.ctx, { type: "INCOME" })).items).toHaveLength(1);
    expect((await listRecurring(fam.ctx, { active: false })).items).toHaveLength(1);

    const occ = await occurrences(internet.id);
    await markPaid(fam.ctx, occ[0]!.id, { date: today });
    const detail = await getRecurring(fam.ctx, internet.id);
    expect(detail.occurrences.some((o) => o.status === "PAID")).toBe(true);

    const removed = await deleteRecurring(fam.ctx, internet.id);
    expect(removed.removedOccurrences).toBe(occ.length - 1);
    const kept = await prisma.scheduledPayment.findUniqueOrThrow({ where: { id: occ[0]!.id } });
    expect(kept).toMatchObject({ status: "PAID", recurringTransactionId: null });
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId, deletedAt: null } })).toBe(1);
    await expect(getRecurring(fam.ctx, internet.id)).rejects.toThrow(/não encontrad/);
  });
});
