import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { dashboardSummary } from "@/server/modules/analytics/service";
import { createTransaction, getTransaction, listTransactions } from "@/server/modules/transactions/service";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";

/**
 * Compra parcelada trazida a partir de uma parcela do meio ("parcelas 3 a 10") e a lista de
 * Transações por mês: cada mês mostra e soma só a parcela dele, com a numeração original.
 */
const OCT = { start: "2026-10-01", end: "2026-10-31" };
const NOV = { start: "2026-11-01", end: "2026-11-30" };

describe("parcelas na lista de transações", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("compra 'parcelas 3 a 10': numeração original, só a parcela no mês, inclusive nos meses seguintes", async () => {
    const fam = await createFamily();
    const { nubank, card } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.ctx, {
      type: "EXPENSE",
      amountCents: 159_992,
      description: "Ferreira Costa — parcelas 3 a 10",
      date: "2026-10-12",
      creditCardId: card.id,
      installmentCount: 8,
      installmentOffset: 2,
    });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 10_000, description: "Mercado", date: "2026-10-05", accountId: nubank.id });
    const detail = await getTransaction(fam.ctx, transaction.id);
    const inst = detail.installments as Array<{ number: number; totalInstallments: number; amountCents: number }>;
    expect(inst.map((i) => `${i.number}/${i.totalInstallments}`)).toEqual(["3/10", "4/10", "5/10", "6/10", "7/10", "8/10", "9/10", "10/10"]);
    expect(inst.reduce((s, i) => s + i.amountCents, 0)).toBe(159_992);

    // Outubro: a parcela 3/10 (R$ 199,99), não R$ 1.599,92.
    const oct = await listTransactions(fam.ctx, OCT);
    const row = oct.items.find((t) => t.id === transaction.id)!;
    expect(row.periodInstallment).toMatchObject({ number: 3, total: 10, amountCents: 19_999, date: "2026-10-12" });
    expect(row.amountCents).toBe(159_992);
    expect(oct.totals.expenseCents).toBe(10_000 + 19_999);
    expect((await dashboardSummary(fam.ctx, { period: OCT, regime: "ACCRUAL" })).expenseCents).toBe(10_000 + 19_999);

    // Novembro: a compra de outubro aparece com a parcela 4/10; o mercado de outubro não.
    const nov = await listTransactions(fam.ctx, NOV);
    expect(nov.items.map((t) => [t.description, t.periodInstallment?.number ?? null, t.periodInstallment?.date ?? null])).toEqual([["Ferreira Costa — parcelas 3 a 10", 4, "2026-11-12"]]);
    expect(nov.totals.expenseCents).toBe(nov.items[0]!.periodInstallment!.amountCents);
    expect((await dashboardSummary(fam.ctx, { period: NOV, regime: "ACCRUAL" })).expenseCents).toBe(nov.totals.expenseCents);

    // Um ano inteiro: as 8 parcelas que caem no período somam o valor da compra.
    const year = await listTransactions(fam.ctx, { start: "2026-10-01", end: "2027-09-30" });
    const all = year.items.find((t) => t.id === transaction.id)!.periodInstallment!;
    expect(all).toMatchObject({ number: null, count: 8, amountCents: 159_992 });

    // Sem período: a lista mostra a compra como é (valor total), sem parcela do período.
    const plain = await listTransactions(fam.ctx, {});
    expect(plain.items.find((t) => t.id === transaction.id)!.periodInstallment).toBeUndefined();
  });

  it("a migração do banco corrige compras antigas 'parcelas X a Y' (numeração e mês de cada parcela)", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const { transaction } = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 80_000, description: "Loja (parcelas 3 a 10 de 10)", date: "2026-10-12", creditCardId: card.id, installmentCount: 8 });
    // Outra que não bate (descrição diz 3 a 10, mas foram registradas 5): não mexe.
    const other = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 50_000, description: "Outra parcelas 3 a 10", date: "2026-10-12", creditCardId: card.id, installmentCount: 5 });
    expect((await prisma.installment.findMany({ where: { transactionId: transaction.id }, orderBy: { number: "asc" } })).map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const sql = readFileSync("prisma/migrations/20261102000000_installment_offset/migration.sql", "utf8").split("-- Compras parceladas")[1]!;
    for (const stmt of `-- Compras parceladas${sql}`.split(/;\s*\n/).map((x) => x.trim()).filter((x) => x.replace(/--.*$/gm, "").trim())) await prisma.$executeRawUnsafe(stmt);

    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id }, include: { installments: { orderBy: { number: "asc" } } } });
    expect(t.installmentOffset).toBe(2);
    expect(t.installments.map((i) => `${i.number}/${i.totalInstallments}`)).toEqual(["3/10", "4/10", "5/10", "6/10", "7/10", "8/10", "9/10", "10/10"]);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: other.transaction.id } })).installmentOffset).toBe(0);
    // Outubro conta só a parcela 3/10 (R$ 100,00) dessa compra.
    const oct = await listTransactions(fam.ctx, OCT);
    expect(oct.items.find((x) => x.id === transaction.id)!.periodInstallment).toMatchObject({ number: 3, total: 10, amountCents: 10_000 });
  });
});
