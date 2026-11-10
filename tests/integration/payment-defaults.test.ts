import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount, updateAccount } from "@/server/modules/accounts/service";
import { createCard } from "@/server/modules/cards/service";
import { getPaymentDefaults, setPaymentDefaults } from "@/server/modules/members/payment-defaults";
import { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues } from "./ai-pipeline-support";
import { resetDatabase } from "./helpers";

/** Conta e forma de pagamento padrão por pessoa: gasto sem conta dita sai dela (motor local). */
describe("conta padrão de pagamento", () => {
  beforeAll(() => initTestQueues("paydefaults"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("gasto sem conta sai da conta padrão (Pix C6); conta ou cartão ditos vencem; sem padrão, nada é presumido", async () => {
    const wa = await createWaFamily();
    const c6 = await createAccount(wa.ctx, { name: "C6 Bank", institution: "C6", type: "CHECKING", initialBalanceCents: 100_000 });
    const nubank = await createAccount(wa.ctx, { name: "Nubank", institution: "Nubank", type: "DIGITAL", initialBalanceCents: 100_000 });
    await createCard(wa.ctx, { name: "Inter Black", closingDay: 3, dueDay: 10, limitCents: 500_000 });

    // Sem padrão: com várias contas, a conta não é presumida.
    await sendMessage(wa, { text: "gastei 20 na farmácia" });
    const before = await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, amountCents: 2_000 } });
    expect(before.accountId).toBeNull();

    const saved = await setPaymentDefaults(wa.ctx, { accountId: c6.id, paymentMethod: "PIX" });
    expect(saved).toEqual({ accountId: c6.id, accountName: "C6 Bank", paymentMethod: "PIX" });

    await sendMessage(wa, { text: "gastei 50 no mercado" });
    const def = await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, amountCents: 5_000 } });
    expect([def.accountId, def.paymentMethod, def.status]).toEqual([c6.id, "PIX", "CONFIRMED"]);

    // Conta dita na mensagem vence o padrão; forma de pagamento padrão não é forçada em outra conta.
    await sendMessage(wa, { text: "gastei 30 na padaria no nubank" });
    const said = await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, amountCents: 3_000 } });
    expect(said.accountId).toBe(nubank.id);
    expect(said.paymentMethod).not.toBe("PIX");

    // Forma dita na mensagem vence a forma padrão (a conta continua a padrão).
    await sendMessage(wa, { text: "gastei 12 no lanche no débito" });
    const debit = await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, amountCents: 1_200 } });
    expect([debit.accountId, debit.paymentMethod]).toEqual([c6.id, "DEBIT_CARD"]);

    // No crédito: vai para o cartão, não para a conta padrão.
    await sendMessage(wa, { text: "gastei 80 no posto no crédito" });
    const credit = await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, amountCents: 8_000 } });
    expect([credit.accountId, credit.creditCardId !== null, credit.paymentMethod]).toEqual([null, true, "CREDIT_CARD"]);

    // Receita não usa o padrão de pagamento.
    await sendMessage(wa, { text: "recebi 200 de freela" });
    const income = await prisma.transaction.findFirstOrThrow({ where: { householdId: wa.householdId, amountCents: 20_000 } });
    expect(income.accountId).toBeNull();
  });

  it("só aceita conta visível, ativa e que não seja de investimento; conta arquivada deixa de valer", async () => {
    const wa = await createWaFamily();
    const inv = await createAccount(wa.ctx, { name: "CDB", type: "INVESTMENT", initialBalanceCents: 0 });
    await expect(setPaymentDefaults(wa.ctx, { accountId: inv.id, paymentMethod: "PIX" })).rejects.toThrow(/investimento/);
    const priv = await createAccount(wa.wifeCtx, { name: "Conta da Maria", type: "CHECKING", visibility: "PRIVATE", ownerMemberId: wa.wifeId, initialBalanceCents: 0 });
    await expect(setPaymentDefaults(wa.ctx, { accountId: priv.id, paymentMethod: null })).rejects.toThrow(/não encontrada/);
    const c6 = await createAccount(wa.ctx, { name: "C6 Bank", type: "CHECKING", initialBalanceCents: 0 });
    await setPaymentDefaults(wa.ctx, { accountId: c6.id, paymentMethod: "PIX" });
    await updateAccount(wa.ctx, c6.id, { archived: true });
    expect(await getPaymentDefaults(wa.ctx)).toEqual({ accountId: null, accountName: null, paymentMethod: "PIX" });
    // O padrão de uma pessoa não vale para outra.
    expect(await getPaymentDefaults(wa.wifeCtx)).toEqual({ accountId: null, accountName: null, paymentMethod: null });
  });
});
