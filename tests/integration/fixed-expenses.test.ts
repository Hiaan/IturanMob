import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createAccount } from "@/server/modules/accounts/service";
import { cardsSpendingByCategory, createCard, getStatement } from "@/server/modules/cards/service";
import { createRecurring } from "@/server/modules/recurring/service";
import { createTransaction } from "@/server/modules/transactions/service";
import { setTransactionNature } from "@/server/modules/transactions/nature";
import { expensesByCategory } from "@/server/modules/analytics/service";
import { fixedExpensesOverview } from "@/server/modules/fixed-expenses/service";
import { addMonthsToKey, dateToISO, monthKey, monthRange, todayISO } from "@/lib/dates";
import { categoryId, createFamily, resetDatabase } from "./helpers";

/** Gastos fixos: recorrências + parcelas em andamento + projeção; fatura por categoria. */

const TZ = "America/Recife";
const shift = (months: number, day = 12) => `${addMonthsToKey(monthKey(todayISO(TZ)), months)}-${String(day).padStart(2, "0")}`;

async function setup() {
  const fam = await createFamily();
  const itau = await createAccount(fam.ctx, { name: "Itaú", type: "CHECKING", initialBalanceCents: 1_000_000, initialBalanceDate: "2025-01-01" });
  // Mesmos dias da família real: Nubank fecha 29/vence 5, Inter 3/10, C6 Black 8/15.
  const nubank = await createCard(fam.ctx, { name: "Nubank", closingDay: 29, dueDay: 5, limitCents: 2_000_000, paymentAccountId: itau.id });
  const inter = await createCard(fam.ctx, { name: "Inter", closingDay: 3, dueDay: 10, limitCents: 2_000_000, paymentAccountId: itau.id });
  const c6 = await createCard(fam.ctx, { name: "C6 Black", closingDay: 8, dueDay: 15, limitCents: 2_000_000, paymentAccountId: itau.id });
  const food = await categoryId(fam.householdId, "Alimentação");
  const home = await categoryId(fam.householdId, "Moradia");
  const start = `${monthKey(todayISO(TZ))}-01`;
  await createRecurring(fam.ctx, { description: "Aluguel", amountCents: 200_000, accountId: itau.id, categoryId: home, dayOfMonth: 10, startDate: start });
  await createRecurring(fam.ctx, { description: "Netflix", amountCents: 5_590, creditCardId: nubank.id, paymentMethod: "CREDIT_CARD", dayOfMonth: 20, startDate: start });
  await createRecurring(fam.ctx, { description: "Energia", amountCents: 30_000, isVariableAmount: true, accountId: itau.id, dayOfMonth: 15, startDate: start });
  await createRecurring(fam.ctx, { description: "Contador da empresa", amountCents: 50_000, accountId: itau.id, dayOfMonth: 5, startDate: start, scope: "BUSINESS" });
  // Parceladas: geladeira 10x no Inter (comprada há 3 meses), notebook 6x no C6 (há 1 mês), tênis 3x no Nubank (hoje).
  const geladeira = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 300_000, description: "Geladeira", date: shift(-3), creditCardId: inter.id, paymentMethod: "CREDIT_CARD", installmentCount: 10, categoryId: home });
  const notebook = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 600_000, description: "Notebook", date: shift(-1), creditCardId: c6.id, paymentMethod: "CREDIT_CARD", installmentCount: 6 });
  const tenis = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 45_000, description: "Tênis", date: todayISO(TZ), creditCardId: nubank.id, paymentMethod: "CREDIT_CARD", installmentCount: 3, categoryId: food });
  // Empresa e repasse
  const camera = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 240_000, description: "Câmera (empresa)", date: shift(-1), creditCardId: c6.id, paymentMethod: "CREDIT_CARD", installmentCount: 4, nature: "BUSINESS" });
  const ads = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 90_000, description: "FACEBK *CLIENTE", date: todayISO(TZ), creditCardId: nubank.id, paymentMethod: "CREDIT_CARD", installmentCount: 3 });
  await setTransactionNature(fam.ctx, { transactionIds: [ads.transaction.id], nature: "PASSTHROUGH", party: "Cliente X" });
  const single = await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 8_000, description: "Mercado", date: todayISO(TZ), creditCardId: nubank.id, paymentMethod: "CREDIT_CARD", categoryId: food });
  return { fam, itau, nubank, inter, c6, food, home, geladeira: geladeira.transaction, notebook: notebook.transaction, tenis: tenis.transaction, camera: camera.transaction, ads: ads.transaction, single: single.transaction };
}

async function futureOf(transactionId: string) {
  const today = todayISO(TZ);
  const all = await prisma.installment.findMany({ where: { transactionId }, orderBy: { number: "asc" } });
  const future = all.filter((i) => dateToISO(i.dueDate) >= today);
  return { all, future, endsMonth: monthKey(dateToISO(all[all.length - 1]!.dueDate)) };
}

describe("Gastos fixos e fatura por categoria", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("contas fixas, parcelas em andamento (atual/total, restante, término) e projeção de 12 meses; Repasse fora, Empresa no recorte", async () => {
    const s = await setup();
    const view = await fixedExpensesOverview(s.fam.ctx);
    expect(view.scope).toBe("PERSONAL");
    // Contas fixas pessoais (o contador é da empresa).
    expect(view.recurring.items.map((r) => r.description).sort()).toEqual(["Aluguel", "Energia", "Netflix"]);
    expect(view.recurring.monthlyTotalCents).toBe(200_000 + 5_590 + 30_000);
    expect(view.recurring.estimatedCount).toBe(1);

    // Parcelas: só as parceladas pessoais com parcelas a vencer (sem o mercado à vista, a câmera da empresa e o repasse).
    expect(view.installments.items.map((i) => i.description).sort()).toEqual(["Geladeira", "Notebook", "Tênis"]);
    for (const tx of [s.geladeira, s.notebook, s.tenis]) {
      const item = view.installments.items.find((i) => i.transactionId === tx.id)!;
      const f = await futureOf(tx.id);
      expect(item).toMatchObject({
        totalInstallments: f.all.length,
        currentNumber: f.future[0]!.number,
        remainingCount: f.future.length,
        remainingCents: f.future.reduce((t, i) => t + i.amountCents, 0),
        installmentAmountCents: f.future[0]!.amountCents,
        endsMonth: f.endsMonth,
      });
    }
    // Ordenado pelo término; soma por cartão.
    const ends = view.installments.items.map((i) => i.endsMonth);
    expect([...ends].sort()).toEqual(ends);
    const inter = view.installments.byCard.find((c) => c.card.name === "Inter")!;
    expect(inter.remainingCents).toBe(view.installments.items.find((i) => i.description === "Geladeira")!.remainingCents);
    expect(view.installments.totalRemainingCents).toBe(view.installments.items.reduce((t, i) => t + i.remainingCents, 0));

    // Projeção: 12 meses; cada mês = contas fixas + parcelas; o mês de término mostra quanto libera depois.
    expect(view.projection).toHaveLength(12);
    const first = view.projection[0]!;
    expect(first.recurringCents).toBe(200_000 + 30_000);
    expect(first.recurringOnCardCents).toBe(5_590);
    for (const m of view.projection) expect(m.totalCents).toBe(m.recurringCents + m.recurringOnCardCents + m.installmentsCents);
    const geladeiraEnd = view.installments.items.find((i) => i.description === "Geladeira")!.endsMonth;
    const endMonth = view.projection.find((m) => m.month === geladeiraEnd);
    if (endMonth) {
      expect(endMonth.endingCount).toBeGreaterThanOrEqual(1);
      expect(endMonth.releasesNextMonthCents).toBeGreaterThanOrEqual(30_000);
    }
    // Parcelas do mês por cartão batem com as parcelas do banco (vencimento no mês).
    const m2 = view.projection[2]!;
    const { start, end } = monthRange(m2.month);
    const inMonth = await prisma.installment.aggregate({
      where: { transactionId: { in: [s.geladeira.id, s.notebook.id, s.tenis.id] }, dueDate: { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) } },
      _sum: { amountCents: true },
    });
    expect(m2.installmentsCents).toBe(inMonth._sum.amountCents ?? 0);

    // Recorte Empresa: contador e câmera; Tudo: os dois juntos; Repasse sempre fora.
    const biz = await fixedExpensesOverview(s.fam.ctx, { scope: "BUSINESS" });
    expect(biz.recurring.items.map((r) => r.description)).toEqual(["Contador da empresa"]);
    expect(biz.installments.items.map((i) => i.description)).toEqual(["Câmera (empresa)"]);
    const all = await fixedExpensesOverview(s.fam.ctx, { scope: "ALL", months: 6 });
    expect(all.projection).toHaveLength(6);
    expect(all.installments.items.map((i) => i.description).sort()).toEqual(["Câmera (empresa)", "Geladeira", "Notebook", "Tênis"]);
  });

  it("fatura: resumo por categoria e por natureza; Cartões: atual e anterior por cartão e somando todos; painel filtra por forma de pagamento", async () => {
    const s = await setup();
    const inst = await prisma.installment.findFirstOrThrow({ where: { transactionId: s.tenis.id, number: 1 } });
    const st = await getStatement(s.fam.ctx, inst.statementId);
    const total = st.installments.reduce((t, i) => t + i.amountCents, 0);
    expect(st.byCategory.reduce((t, c) => t + c.amountCents, 0)).toBe(total);
    expect(st.byCategory.find((c) => c.categoryId === s.food)!.amountCents).toBe(15_000 + 8_000);
    expect(st.byNature.PASSTHROUGH).toBe(30_000);
    expect(Math.round(st.byCategory.reduce((t, c) => t + c.percent, 0))).toBe(100);

    const spending = await cardsSpendingByCategory(s.fam.ctx);
    expect(spending.cards.map((c) => c.card.name).sort()).toEqual(["C6 Black", "Inter", "Nubank"]);
    const sumCards = spending.cards.reduce((t, c) => t + (c.current?.totalCents ?? 0), 0);
    expect(spending.combined.current.totalCents).toBe(sumCards);

    // "Despesas por categoria" só do cartão (forma de pagamento) — sem o aluguel/energia da conta.
    const period = { start: shift(-4, 1), end: shift(1, 28) };
    const byCard = await expensesByCategory(s.fam.ctx, { period, regime: "ACCRUAL", filters: { paymentMethod: "CREDIT_CARD" } });
    expect(byCard.totalCents).toBe(300_000 + 600_000 + 45_000 + 8_000);
    const nubankOnly = await expensesByCategory(s.fam.ctx, { period, regime: "ACCRUAL", filters: { creditCardId: s.nubank.id } });
    expect(nubankOnly.totalCents).toBe(45_000 + 8_000);
  });
});
