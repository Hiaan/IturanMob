import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { createAccount, getAccount, updateAccount, verifyLedgerIntegrity } from "@/server/modules/accounts/service";
import { createTransaction, listTransactions } from "@/server/modules/transactions/service";
import { dashboardSummary } from "@/server/modules/analytics/service";
import { backfillBrlAmounts, fxVariation, refreshFxRates } from "@/server/modules/fx/service";
import { commitImport, createImportPreviewFromBuffer, setImportRowsTransfer } from "@/server/modules/imports/service";
import { createFamily, resetDatabase } from "./helpers";

/** Contas em moeda estrangeira: saldo na moeda, totais em reais pela PTAX, transferência com câmbio. */

async function rate(currency: string, date: string, value: string) {
  await prisma.exchangeRate.create({ data: { currency, date: new Date(`${date}T00:00:00Z`), rateBrl: new Prisma.Decimal(value) } });
}

async function setup() {
  const fam = await createFamily();
  const c6 = await createAccount(fam.ctx, { name: "C6", institution: "C6 Bank", type: "CHECKING", initialBalanceCents: 100_000, initialBalanceDate: "2026-09-01" });
  await rate("USD", "2026-09-01", "5.000000");
  await rate("USD", "2026-10-01", "5.500000");
  const wise = await createAccount(fam.ctx, { name: "Wise", institution: "Wise", type: "DIGITAL", currency: "USD", initialBalanceCents: 100_000, initialBalanceDate: "2026-09-01" });
  return { fam, c6, wise };
}

describe("Contas em moeda estrangeira", () => {
  beforeEach(async () => {
    await resetDatabase();
    await prisma.exchangeRate.deleteMany();
  });

  it("saldo na moeda da conta, totais da família em reais pela PTAX mais recente (com a data)", async () => {
    const { fam, wise } = await setup();
    const w = await getAccount(fam.ctx, wise.id);
    expect(w).toMatchObject({ currency: "USD", balanceCents: 100_000, balanceBrlCents: 550_000, fx: { rate: 5.5, date: "2026-10-01" } });
    const summary = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" } });
    expect(summary.availableBalanceCents).toBe(100_000 + 550_000);
    // Moeda não muda depois de haver lançamentos.
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 1_000, description: "Café em NY", date: "2026-10-02", accountId: wise.id });
    await expect(updateAccount(fam.ctx, wise.id, { currency: "BRL" })).rejects.toThrow(/moeda não pode mudar/);
  });

  it("despesa em dólar entra nos relatórios em reais pela PTAX da data; sem cotação, é preenchida depois", async () => {
    const { fam, wise } = await setup();
    const tx = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 2_000, description: "Livro", date: "2026-10-05", accountId: wise.id });
    expect(tx.transaction).toMatchObject({ currency: "USD", amountCents: 2_000, amountBrlCents: 11_000 });
    const summary = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" }, regime: "ACCRUAL" });
    expect(summary.expenseCents).toBe(11_000);
    const list = await listTransactions(fam.ctx, { start: "2026-10-01", end: "2026-10-31" });
    expect(list.totals.expenseCents).toBe(11_000);

    // EUR sem cotação ainda: fica de fora dos totais até a cotação chegar.
    const eur = await createAccount(fam.ctx, { name: "Revolut", type: "DIGITAL", currency: "EUR", initialBalanceCents: 0, initialBalanceDate: "2026-10-01" });
    const e = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 1_000, description: "Museu", date: "2026-10-06", accountId: eur.id });
    expect(e.transaction.amountBrlCents).toBeNull();
    await rate("EUR", "2026-10-01", "6.000000");
    expect(await backfillBrlAmounts()).toBe(1);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: e.transaction.id } })).amountBrlCents).toBe(6_000);
  });

  it("transferência Wise (USD) → C6 (BRL) com câmbio efetivo; variação cambial separada; integridade ok", async () => {
    const { fam, c6, wise } = await setup();
    await expect(createTransaction(fam.ctx, { type: "TRANSFER", amountCents: 50_000, description: "Wise → C6", date: "2026-10-02", accountId: wise.id, destinationAccountId: c6.id })).rejects.toThrow(/moedas diferentes/);
    const t = await createTransaction(fam.ctx, { type: "TRANSFER", amountCents: 50_000, destinationAmountCents: 270_000, description: "Wise → C6", date: "2026-10-02", accountId: wise.id, destinationAccountId: c6.id });
    expect(t.transaction).toMatchObject({ currency: "USD", amountCents: 50_000, destinationAmountCents: 270_000 });
    expect((await getAccount(fam.ctx, wise.id)).balanceCents).toBe(50_000);
    expect((await getAccount(fam.ctx, c6.id)).balanceCents).toBe(100_000 + 270_000);
    // Não é receita nem despesa.
    const summary = await dashboardSummary(fam.ctx, { period: { start: "2026-10-01", end: "2026-10-31" } });
    expect([summary.incomeCents, summary.expenseCents]).toEqual([0, 0]);
    expect((await verifyLedgerIntegrity(fam.householdId)).ok).toBe(true);

    // Variação cambial da Wise: US$ 500 restantes valem R$ 2.750 hoje; custaram US$ 1.000 × 5,00 − R$ 2.700 recebidos.
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: wise.id } });
    const v = await fxVariation(acc, 50_000);
    expect(v).toMatchObject({ valueBrlCents: 275_000, costBrlCents: 500_000 - 270_000, variationBrlCents: 275_000 - 230_000, rate: 5.5 });
    // Pagar fatura com conta em dólar não é permitido.
    const card = await prisma.creditCard.create({ data: { householdId: fam.householdId, name: "Cartão", closingDay: 3, dueDay: 10, limitCents: 100_000 } });
    await expect(createTransaction(fam.ctx, { type: "CARD_PAYMENT", amountCents: 1_000, description: "Fatura", date: "2026-10-10", accountId: wise.id, creditCardId: card.id })).rejects.toThrow(/conta em reais/);
  });

  it("importação: 'REMITLY CORRETORA DE CAMBIO' no C6 vira transferência da Wise, pedindo o valor em dólar", async () => {
    const { fam, c6, wise } = await setup();
    const csv = Buffer.from(["Data;Descrição;Valor", "02/10/2026;REMITLY CORRETORA DE CAMBIO;2700,00", "03/10/2026;MERCADO;-50,00"].join("\n"));
    const preview = await createImportPreviewFromBuffer(fam.ctx, { fileName: "c6.csv", accountId: c6.id, content: csv });
    const row = preview.rows.find((r) => r.description?.startsWith("REMITLY"))!;
    expect(row).toMatchObject({ kind: "TRANSFER", selected: false, transfer: { accountId: wise.id, direction: "IN" } });
    expect(row.message).toContain("informe quanto saiu em USD");
    expect(row.message).toContain("PTAX");
    const updated = await setImportRowsTransfer(fam.ctx, preview.batch.id, { rowIds: [row.id], transferAccountId: wise.id, counterpartAmountCents: 50_000 });
    expect(updated.rows.find((r) => r.id === row.id)).toMatchObject({ selected: true });
    await commitImport(fam.ctx, preview.batch.id);
    const t = await prisma.transaction.findFirstOrThrow({ where: { householdId: fam.householdId, type: "TRANSFER" } });
    expect(t).toMatchObject({ accountId: wise.id, amountCents: 50_000, currency: "USD", destinationAccountId: c6.id, destinationAmountCents: 270_000 });

    // Sem conta em outra moeda, remessa é recebimento comum.
    const fam2 = await createFamily("Outra");
    const acc2 = await createAccount(fam2.ctx, { name: "C6", type: "CHECKING", initialBalanceCents: 0, initialBalanceDate: "2026-09-01" });
    const p2 = await createImportPreviewFromBuffer(fam2.ctx, { fileName: "c6.csv", accountId: acc2.id, content: csv });
    expect(p2.rows.find((r) => r.description?.startsWith("REMITLY"))).toMatchObject({ kind: "INCOME", transfer: null });
  });

  it("cotações do Banco Central (PTAX) buscadas para as moedas em uso", async () => {
    await setup();
    await prisma.exchangeRate.deleteMany();
    const calls: string[] = [];
    const res = await refreshFxRates({
      now: new Date("2026-10-16T12:00:00Z"),
      fetchImpl: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => [{ data: "01/10/2026", valor: "5.4321" }] };
      },
    });
    expect(res.errors).toEqual([]);
    expect(calls[0]).toContain("bcdata.sgs.1/dados");
    expect(await prisma.exchangeRate.count({ where: { currency: "USD" } })).toBe(1);
  });
});
