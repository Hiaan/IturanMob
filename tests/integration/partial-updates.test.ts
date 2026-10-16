import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount, updateAccount } from "@/server/modules/accounts/service";
import { createTransaction, updateTransaction } from "@/server/modules/transactions/service";
import { createRule, updateRule } from "@/server/modules/categories/service";
import { NextRequest } from "next/server";
import { createSession } from "@/server/auth/session";
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

  it("pela API (PATCH): arquivar uma conta e editar a descrição de uma compra parcelada mudam só o enviado", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const acc = await createAccount(fam.ctx, { name: "Poupança", type: "SAVINGS", color: "#2255aa", includeInTotals: false, initialBalanceCents: 12_345, initialBalanceDate: "2026-01-01" });
    const tx = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 60_000, description: "TV", date: "2026-10-10", creditCardId: card.id, installmentCount: 6 });
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });
    const headers = { cookie: `fa_session=${token}`, origin: "http://localhost:3000", "content-type": "application/json" };
    const accountRoute = await import("@/app/api/v1/accounts/[id]/route");
    const txRoute = await import("@/app/api/v1/transactions/[id]/route");
    const ctxOf = (id: string) => ({ params: Promise.resolve<Record<string, string>>({ id }) });

    const res = await accountRoute.PATCH(new NextRequest(`http://localhost:3000/api/v1/accounts/${acc.id}`, { method: "PATCH", headers, body: JSON.stringify({ archived: true }) }), ctxOf(acc.id));
    expect(res.status).toBe(200);
    expect(await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).toMatchObject({ type: "SAVINGS", color: "#2255aa", includeInTotals: false, initialBalanceCents: 12_345 });

    const res2 = await txRoute.PATCH(new NextRequest(`http://localhost:3000/api/v1/transactions/${tx.transaction.id}`, { method: "PATCH", headers, body: JSON.stringify({ description: "TV 55" }) }), ctxOf(tx.transaction.id));
    expect(res2.status).toBe(200);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: tx.transaction.id } })).toMatchObject({ description: "TV 55", installmentCount: 6 });
  });
});
