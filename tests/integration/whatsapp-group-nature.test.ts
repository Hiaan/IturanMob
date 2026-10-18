import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount, getAccount } from "@/server/modules/accounts/service";
import { createCard, listCards } from "@/server/modules/cards/service";
import { createRule } from "@/server/modules/categories/service";
import { updateSettings } from "@/server/modules/households/service";
import { formatBRL } from "@/lib/money";
import { resetDatabase } from "./helpers";
import { addWaGroup, clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues } from "./ai-pipeline-support";

/**
 * Empresa × Pessoa física pelo WhatsApp: vários grupos autorizados, cada um com sua natureza.
 * Ordem de decisão: o que a mensagem diz > regra > natureza do grupo > perguntar (grupo não
 * atribuído) ou padrão da família. Natureza nunca muda saldo, extrato nem fatura.
 */

async function family() {
  const fam = await createWaFamily("Família Grupos");
  const itau = await createAccount(fam.ctx, { name: "Itaú", institution: "Itaú", type: "CHECKING", initialBalanceCents: 500_000, initialBalanceDate: "2026-01-01" });
  const card = await createCard(fam.ctx, { name: "Nubank", issuer: "Nubank", closingDay: 3, dueDay: 10, limitCents: 500_000, paymentAccountId: itau.id });
  const empresa = await addWaGroup(fam, "Empresa", "BUSINESS");
  const avulso = await addWaGroup(fam, "Avulso", null);
  return { fam, itau, card, empresa, avulso };
}

const txByAmount = (householdId: string, amountCents: number) => prisma.transaction.findFirstOrThrow({ where: { householdId, amountCents, deletedAt: null } });

async function money(fam: Awaited<ReturnType<typeof family>>) {
  const [account, cards, ledger] = await Promise.all([
    getAccount(fam.fam.ctx, fam.itau.id),
    listCards(fam.fam.ctx),
    prisma.ledgerEntry.findMany({ where: { householdId: fam.fam.householdId }, orderBy: { id: "asc" }, select: { id: true, amountCents: true, accountId: true } }),
  ]);
  return { balance: account.balanceCents, outstanding: cards[0]!.outstandingCents, ledger };
}

describe("WhatsApp: natureza por grupo (Empresa × Pessoa física)", () => {
  beforeAll(() => initTestQueues("wa-group-nature"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("grupo da empresa → Empresa; a mensagem vence o grupo; regra vence o grupo; a mensagem vence a regra; resposta no próprio grupo", async () => {
    const s = await family();
    const hh = s.fam.householdId;

    const biz = await sendMessage(s.fam, { text: "gastei 50 no mercado no itaú", groupJid: s.empresa });
    expect(biz.reply).toContain("🏢 Empresa");
    expect(await txByAmount(hh, 5_000)).toMatchObject({ scope: "BUSINESS", natureReview: false });
    // A resposta sai no grupo de onde veio a mensagem.
    const out = await prisma.whatsAppMessage.findFirstOrThrow({ where: { householdId: hh, direction: "OUTBOUND", quotedExternalId: biz.externalId } });
    expect(out.chatId).toBe(s.empresa);

    // Grupo pessoa física: sem selo; e a resposta no grupo PF.
    const pf = await sendMessage(s.fam, { text: "gastei 70 na farmácia no itaú" });
    expect(pf.reply).not.toContain("🏢 Empresa");
    expect(await txByAmount(hh, 7_000)).toMatchObject({ scope: "PERSONAL" });
    const outPf = await prisma.whatsAppMessage.findFirstOrThrow({ where: { householdId: hh, direction: "OUTBOUND", quotedExternalId: pf.externalId } });
    expect(outPf.chatId).toBe(s.fam.groupJid);

    // A mensagem diz "pf" no grupo da empresa → pessoa física (e "pf" não fica na descrição).
    await sendMessage(s.fam, { text: "almoço 40 pf no itaú", groupJid: s.empresa });
    const almoco = await txByAmount(hh, 4_000);
    expect(almoco.scope).toBe("PERSONAL");
    expect(almoco.description.toLowerCase()).not.toMatch(/\bpf\b/);
    // "empresa" no meio da frase no grupo PF → Empresa.
    await sendMessage(s.fam, { text: "uber 33 empresa no itaú" });
    expect(await txByAmount(hh, 3_300)).toMatchObject({ scope: "BUSINESS" });

    // Regra de natureza (padaria = pessoal) vale sobre o grupo da empresa…
    await createRule(s.fam.ctx, { name: "Padaria é pessoal", pattern: "padaria", transactionType: "EXPENSE", setScope: "PERSONAL" });
    await sendMessage(s.fam, { text: "gastei 20 na padaria no itaú", groupJid: s.empresa });
    expect(await txByAmount(hh, 2_000)).toMatchObject({ scope: "PERSONAL" });
    // …mas o que a mensagem diz vence a regra.
    await sendMessage(s.fam, { text: "gastei 15 na padaria no itaú, da empresa", groupJid: s.empresa });
    expect(await txByAmount(hh, 1_500)).toMatchObject({ scope: "BUSINESS" });
  });

  it("grupo não atribuído pergunta 'É pessoa física ou empresa? (1 PF / 2 Empresa)'; '2' vira Empresa sem mudar saldo, extrato ou fatura", async () => {
    const s = await family();
    const hh = s.fam.householdId;
    await sendMessage(s.fam, { text: "gastei 100 no posto no itaú" });
    await sendMessage(s.fam, { text: "comprei 300 de material no cartão nubank" });

    const asked = await sendMessage(s.fam, { text: "uber 30 no cartão nubank", groupJid: s.avulso });
    expect(asked.reply).toContain("é de *pessoa física* ou da *empresa*?");
    expect(asked.reply).toContain("Responda *1* (PF) ou *2* (Empresa)");
    const uber = await txByAmount(hh, 3_000);
    expect(uber.natureReview).toBe(true);
    expect(await prisma.pendingItem.count({ where: { householdId: hh, type: "NATURE_REVIEW", status: "OPEN" } })).toBe(1);

    const before = await money(s);
    const ans = await sendMessage(s.fam, { text: "2", groupJid: s.avulso });
    expect(ans.reply).toContain("ficou como *Empresa*");
    expect(await txByAmount(hh, 3_000)).toMatchObject({ scope: "BUSINESS", natureReview: false });
    expect(await prisma.pendingItem.count({ where: { householdId: hh, type: "NATURE_REVIEW", status: "OPEN" } })).toBe(0);
    expect(await money(s)).toEqual(before);

    // "1" = pessoa física.
    await sendMessage(s.fam, { text: "pão 12 no itaú", groupJid: s.avulso });
    await sendMessage(s.fam, { text: "1", groupJid: s.avulso });
    expect(await txByAmount(hh, 1_200)).toMatchObject({ scope: "PERSONAL", natureReview: false });

    // Mensagem que já diz a natureza não pergunta; PF e PJ juntas: cada trecho decide.
    const both = await sendMessage(s.fam, { text: "mercado 120 pf, gasolina 80 pj no itaú", groupJid: s.avulso });
    expect(both.reply).not.toContain("é de *pessoa física* ou da *empresa*?");
    expect(await txByAmount(hh, 12_000)).toMatchObject({ scope: "PERSONAL", natureReview: false });
    const gas = await txByAmount(hh, 8_000);
    expect(gas).toMatchObject({ scope: "BUSINESS", natureReview: false });
    expect(gas.description.toLowerCase()).not.toMatch(/\bpj\b/);

    // Configuração: usar o padrão da família em vez de perguntar.
    await updateSettings(s.fam.ctx, { whatsappUnassignedNature: "FAMILY_DEFAULT", defaultReportScope: "BUSINESS" });
    const quiet = await sendMessage(s.fam, { text: "estacionamento 25 no itaú", groupJid: s.avulso });
    expect(quiet.reply).not.toContain("é de *pessoa física* ou da *empresa*?");
    expect(await txByAmount(hh, 2_500)).toMatchObject({ scope: "BUSINESS", natureReview: false });
  });

  it("perguntas: grupo da empresa responde no recorte Empresa; grupo PF em Pessoa física; não atribuído em Tudo, com a divisão PF/Empresa", async () => {
    const s = await family();
    await sendMessage(s.fam, { text: "gastei 200 no mercado no itaú" });
    await sendMessage(s.fam, { text: "gastei 90 de software no itaú", groupJid: s.empresa });

    const qBiz = await sendMessage(s.fam, { text: "quanto gastamos este mês?", groupJid: s.empresa });
    expect(qBiz.message.intent).toBe("QUERY");
    expect(qBiz.reply).toContain(formatBRL(9_000));
    expect(qBiz.reply).not.toContain(formatBRL(20_000));

    const qPf = await sendMessage(s.fam, { text: "quanto gastamos este mês?" });
    expect(qPf.reply).toContain(formatBRL(20_000));
    expect(qPf.reply).not.toContain(formatBRL(9_000));

    const qAll = await sendMessage(s.fam, { text: "quanto gastamos este mês?", groupJid: s.avulso });
    expect(qAll.reply).toContain(formatBRL(29_000));
    expect(qAll.reply).toContain(`Pessoa física ${formatBRL(20_000)} · Empresa ${formatBRL(9_000)}`);

    // "empresa" na pergunta vira o recorte (no grupo PF), sem registrar nada.
    const count = await prisma.transaction.count({ where: { householdId: s.fam.householdId } });
    const qWord = await sendMessage(s.fam, { text: "quanto gastamos da empresa este mês?" });
    expect(qWord.reply).toContain(formatBRL(9_000));
    expect(await prisma.transaction.count({ where: { householdId: s.fam.householdId } })).toBe(count);
  });
});
