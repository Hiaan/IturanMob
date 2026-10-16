import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount, updateAccount } from "@/server/modules/accounts/service";
import { createTransaction, updateTransaction } from "@/server/modules/transactions/service";
import { createRule, updateRule } from "@/server/modules/categories/service";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";

/** Edição parcial altera só o que foi enviado (os valores padrão do cadastro não são reaplicados). */
describe("edições parciais", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("corrigir só o valor ou a descrição mantém o parcelamento e o rateio", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const tx = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 120_000, description: "Geladeira", date: "2026-10-10", creditCardId: card.id, installmentCount: 10, ownership: "INDIVIDUAL", responsibleMemberId: fam.wifeId });
    await updateTransaction(fam.ctx, tx.transaction.id, { description: "Geladeira nova" });
    await updateTransaction(fam.ctx, tx.transaction.id, { amountCents: 130_000 });
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.transaction.id }, include: { installments: true } });
    expect(after).toMatchObject({ description: "Geladeira nova", amountCents: 130_000, installmentCount: 10, ownership: "INDIVIDUAL", responsibleMemberId: fam.wifeId });
    expect(after.installments).toHaveLength(10);
  });

  it("arquivar uma conta não muda tipo, cor nem visibilidade; desativar uma regra mantém o padrão", async () => {
    const fam = await createFamily();
    const acc = await createAccount(fam.ctx, { name: "CDB", type: "INVESTMENT", color: "#123456", icon: "piggy-bank", includeInTotals: false, initialBalanceCents: 0, initialBalanceDate: "2026-01-01" });
    await updateAccount(fam.ctx, acc.id, { archived: true });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).toMatchObject({ type: "INVESTMENT", color: "#123456", icon: "piggy-bank", includeInTotals: false });
    const rule = await createRule(fam.ctx, { name: "Uber", matchField: "DESCRIPTION", matchType: "STARTS_WITH", pattern: "uber", priority: 7 });
    await updateRule(fam.ctx, rule.id, { active: false });
    expect(await prisma.financialRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ active: false, matchType: "STARTS_WITH", matchField: "DESCRIPTION", priority: 7 });
  });
});
