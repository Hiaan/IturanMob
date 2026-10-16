import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount, getAccount } from "@/server/modules/accounts/service";
import { resetDatabase } from "./helpers";
import { clearTestQueues, createWaFamily, initTestQueues, sendMessage, teardownTestQueues } from "./ai-pipeline-support";

/** Aplicação/resgate pelo WhatsApp: transferência com a conta de investimento, nunca receita/despesa. */

async function family(withInvestment: boolean) {
  const fam = await createWaFamily("Família Investe");
  const itau = await createAccount(fam.ctx, { name: "Itaú", institution: "Itaú", type: "CHECKING", initialBalanceCents: 200_000, initialBalanceDate: "2026-01-01" });
  const cdb = withInvestment ? await createAccount(fam.ctx, { name: "CDB Itaú", institution: "Itaú", type: "INVESTMENT", initialBalanceCents: 500_000, initialBalanceDate: "2026-01-01" }) : null;
  return { fam, itau, cdb };
}

describe("WhatsApp: aplicação e resgate", () => {
  beforeAll(() => initTestQueues("wa-investments"));
  beforeEach(async () => {
    await resetDatabase();
    await clearTestQueues();
  });
  afterAll(async () => {
    await teardownTestQueues();
  });

  it("'apliquei 1000 no CDB' e 'resgatei 300' viram transferências; rendimento continua receita", async () => {
    const { fam, itau, cdb } = await family(true);
    const ap = await sendMessage(fam, { text: "apliquei 1000 no cdb" });
    expect(ap.reply).toContain("Transferência registrada");
    expect(ap.reply).toContain("Itaú → CDB Itaú (não é receita nem despesa)");
    const rs = await sendMessage(fam, { text: "resgatei 300 do investimento" });
    expect(rs.reply).toContain("CDB Itaú → Itaú");
    const rend = await sendMessage(fam, { text: "rendeu 12,50 no cdb" });
    expect(rend.reply).toContain("Receita registrada");

    const txs = await prisma.transaction.findMany({ where: { householdId: fam.householdId }, orderBy: { createdAt: "asc" } });
    expect(txs.map((t) => [t.type, t.amountCents, t.accountId, t.destinationAccountId])).toEqual([
      ["TRANSFER", 100000, itau.id, cdb!.id],
      ["TRANSFER", 30000, cdb!.id, itau.id],
      ["INCOME", 1250, expect.anything(), null],
    ]);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(200_000 - 100_000 + 30_000 + (txs[2]!.accountId === itau.id ? 1250 : 0));
  });

  it("sem conta de investimento: pergunta e aceita 'criar CDB Nubank'; com várias, pergunta qual", async () => {
    const { fam, itau } = await family(false);
    const q = await sendMessage(fam, { text: "guardei 200 na caixinha" });
    expect(q.reply).toContain("ainda não há nenhuma cadastrada");
    expect(q.reply).toContain("criar <nome>");
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    const created = await sendMessage(fam, { text: "criar Caixinha Nubank" });
    expect(created.reply).toContain("Transferência registrada");
    expect(created.reply).toContain("Conta *Caixinha Nubank* criada (saldo inicial R$ 0,00");
    const acc = await prisma.account.findFirstOrThrow({ where: { householdId: fam.householdId, name: "Caixinha Nubank" } });
    expect(acc.type).toBe("INVESTMENT");
    const tx = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId } });
    expect(tx).toMatchObject({ type: "TRANSFER", amountCents: 20000, accountId: itau.id, destinationAccountId: acc.id, categoryId: null });

    await createAccount(fam.ctx, { name: "Poupança BB", institution: "Banco do Brasil", type: "SAVINGS", initialBalanceCents: 0, initialBalanceDate: "2026-01-01" });
    await createAccount(fam.ctx, { name: "Tesouro", institution: null, type: "INVESTMENT", initialBalanceCents: 0, initialBalanceDate: "2026-01-01" });
    const which = await sendMessage(fam, { text: "apliquei 150" });
    expect(which.reply).toContain("Em qual conta de investimento foi a aplicação de R$ 150,00?");
    const answer = await sendMessage(fam, { text: "tesouro" });
    expect(answer.reply).toContain("Itaú → Tesouro");
  });
});
