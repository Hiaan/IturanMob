import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { createSession } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { isoToDate } from "@/lib/dates";
import { categoryId, createBasicAccounts, createFamily, resetDatabase, subcategory } from "./helpers";
import { createTransaction } from "@/server/modules/transactions/service";
import { createAccount } from "@/server/modules/accounts/service";
import { createCard, listStatements, payStatement } from "@/server/modules/cards/service";
import {
  buildMonthlyReport,
  buildWeeklyReport,
  exportReport,
  familyScopeContext,
  generateReport,
  getReport,
  listReports,
  listReportSchedules,
  reportSummaryText,
  updateReportSchedule,
} from "@/server/modules/reports/service";
import { processScheduledReports } from "@/server/modules/reports/jobs";
import { latestOccurrence, nextOccurrence, previousCompleteWeek, zonedInstant } from "@/server/modules/reports/schedule";

const NOW = new Date("2026-10-20T12:00:00Z"); // terça-feira, 09:00 em Recife

async function seedOctober() {
  const fam = await createFamily("Família Relatório");
  const { nubank, itau, card } = await createBasicAccounts(fam.ctx);
  const trabalho = await categoryId(fam.householdId, "Trabalho", "INCOME");
  const mercado = await subcategory(fam.householdId, "Supermercado");

  // Setembro: compra no cartão (fatura de outubro, vence 10/10) e gastos para comparação.
  await createTransaction(fam.ctx, { type: "INCOME", amountCents: 300_000, description: "Salário setembro", date: "2026-09-05", accountId: itau.id, categoryId: trabalho });
  await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 50_000, description: "Mercado setembro", date: "2026-09-10", accountId: nubank.id, subcategoryId: mercado.id });
  await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 30_000, description: "Restaurante", date: "2026-09-20", creditCardId: card.id });

  // Outubro.
  await createTransaction(fam.ctx, { type: "INCOME", amountCents: 350_000, description: "Salário outubro", date: "2026-10-05", accountId: itau.id, categoryId: trabalho });
  await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 25_800, description: "Supermercado Bom Preço", date: "2026-10-10", accountId: nubank.id, subcategoryId: mercado.id });
  await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 120_000, description: "Notebook", date: "2026-10-15", creditCardId: card.id, installmentCount: 3 });
  await createTransaction(fam.ctx, { type: "TRANSFER", amountCents: 50_000, description: "Reserva", date: "2026-10-12", accountId: itau.id, destinationAccountId: nubank.id });
  // Pagamento da fatura de outubro (compra de setembro): saída de caixa, não é despesa.
  const statements = await listStatements(fam.ctx, card.id);
  const october = statements.find((s) => s.referenceMonth === "2026-10")!;
  expect(october.totalCents).toBe(30_000);
  await payStatement(fam.ctx, october.id, { date: "2026-10-09" });

  const alimentacao = await categoryId(fam.householdId, "Alimentação");
  await prisma.budget.create({ data: { householdId: fam.householdId, categoryId: alimentacao, month: "2026-10", limitCents: 50_000 } });
  const goal = await prisma.financialGoal.create({ data: { householdId: fam.householdId, name: "Viagem", targetCents: 1_000_000, deadline: isoToDate("2027-06-30") } });
  await prisma.goalContribution.createMany({
    data: [
      { householdId: fam.householdId, goalId: goal.id, amountCents: 50_000, date: isoToDate("2026-09-15") },
      { householdId: fam.householdId, goalId: goal.id, amountCents: 100_000, date: isoToDate("2026-10-05") },
    ],
  });
  await prisma.recurringTransaction.createMany({
    data: [
      { householdId: fam.householdId, description: "Internet", amountCents: 12_000, frequency: "MONTHLY", startDate: isoToDate("2026-01-01"), dayOfMonth: 10 },
      { householdId: fam.householdId, description: "IPVA", amountCents: 120_000, frequency: "YEARLY", startDate: isoToDate("2026-01-01"), isVariableAmount: true },
      { householdId: fam.householdId, description: "Antiga", amountCents: 9_999, frequency: "MONTHLY", startDate: isoToDate("2025-01-01"), active: false },
    ],
  });
  return { fam, nubank, itau, card };
}

describe("relatórios", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  beforeEach(async () => {
    await resetDatabase();
  });

  it("relatório mensal (competência) com números corretos e sem dupla contagem do pagamento de fatura", async () => {
    const { fam } = await seedOctober();
    const r = await buildMonthlyReport(fam.ctx, "2026-10", { regime: "ACCRUAL", now: NOW });

    expect(r.type).toBe("MONTHLY");
    expect(r.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(r.isPartial).toBe(true);
    // Receita: salário. Despesas: mercado + notebook (valor total). Pagamento de fatura e transferência fora.
    expect(r.totals).toEqual({ incomeCents: 350_000, expenseCents: 145_800, resultCents: 204_200 });
    expect(r.recognizedTransactions).toBe(3);
    expect(r.comparison.previousExpenseCents).toBe(80_000);
    expect(r.comparison.previousIncomeCents).toBe(300_000);
    expect(r.evolution).toHaveLength(6);
    expect(r.evolution.at(-1)).toMatchObject({ month: "2026-10", incomeCents: 350_000, expenseCents: 145_800 });
    expect(r.evolution.at(-2)).toMatchObject({ month: "2026-09", expenseCents: 80_000 });
    expect(r.previousMonths).toMatchObject({ months: 1, averageExpenseCents: 80_000 });

    const alimentacao = r.topCategories.find((c) => c.name === "Alimentação");
    expect(alimentacao?.amountCents).toBe(25_800);
    expect(r.topCategories.reduce((s, c) => s + c.amountCents, 0)).toBe(145_800);
    expect(r.incomeCategories[0]).toMatchObject({ name: "Trabalho", amountCents: 350_000 });

    expect(r.budget.items).toHaveLength(1);
    expect(r.budget.items[0]).toMatchObject({ name: "Alimentação", limitCents: 50_000, spentCents: 25_800 });
    expect(r.goals[0]).toMatchObject({ name: "Viagem", savedCents: 150_000, contributedInPeriodCents: 100_000, percent: 15 });
    expect(r.goals[0]!.monthlyNeededCents).toBe(Math.ceil(850_000 / 8));
    expect(r.recurringExpenses.items.map((i) => i.description)).toEqual(["IPVA", "Internet"]);
    expect(r.recurringExpenses.monthlyTotalCents).toBe(12_000 + 10_000);
    expect(r.recurringExpenses.certainty).toBe("PROJECTION");
    // Parcelas futuras do notebook: nov, dez e jan.
    expect(r.futureInstallments.items).toEqual([
      { month: "2026-11", amountCents: 40_000 },
      { month: "2026-12", amountCents: 40_000 },
      { month: "2027-01", amountCents: 40_000 },
    ]);
    expect(r.categoryComparison.totalPreviousCents).toBe(80_000);
    expect(r.topExpenses[0]).toMatchObject({ description: "Notebook", amountCents: 120_000 });
    // Saldo: Nubank 100.000 − 25.800 + 50.000 − 50.000 (set) − 30.000 (fatura) ; Itaú 500.000 + 300.000 + 350.000 − 50.000
    expect(r.balance.availableCents).toBe(100_000 - 50_000 - 25_800 + 50_000 - 30_000 + (500_000 + 300_000 + 350_000 - 50_000));
    expect(r.regime).toBe("ACCRUAL");
    expect(r.origin.summary).toMatch(/competência/i);
    expect(r.origin.confirmed.join(" ")).toMatch(/pagamentos de fatura/);
    expect(r.origin.projections.length).toBeGreaterThan(0);
  });

  it("relatório mensal no regime de caixa conta a parcela da fatura uma única vez", async () => {
    const { fam } = await seedOctober();
    const r = await buildMonthlyReport(fam.ctx, "2026-10", { regime: "CASH", now: NOW });
    // Mercado (débito) + fatura de outubro pela parcela da compra de setembro; o pagamento da fatura não soma.
    expect(r.totals.expenseCents).toBe(25_800 + 30_000);
    expect(r.totals.incomeCents).toBe(350_000);
    expect(r.origin.regimeLabel).toBe("Caixa");
  });

  it("relatório semanal com comparação e contas a vencer nos próximos 7 dias", async () => {
    const { fam, nubank } = await seedOctober();
    const card2 = await createCard(fam.ctx, { name: "Cartão Azul", closingDay: 15, dueDay: 25 });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 7_000, description: "Farmácia", date: "2026-10-01", creditCardId: card2.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 4_000, description: "Padaria", date: "2026-10-06", accountId: nubank.id });
    await prisma.scheduledPayment.createMany({
      data: [
        { householdId: fam.householdId, description: "Conta de luz", amountCents: 18_000, dueDate: isoToDate("2026-10-22"), isEstimate: true },
        { householdId: fam.householdId, description: "Condomínio", amountCents: 60_000, dueDate: isoToDate("2026-10-18") },
        { householdId: fam.householdId, description: "Seguro", amountCents: 90_000, dueDate: isoToDate("2026-11-30") },
        { householdId: fam.householdId, description: "Streaming", amountCents: 3_990, dueDate: isoToDate("2026-10-21"), creditCardId: card2.id },
      ],
    });

    const r = await buildWeeklyReport(fam.ctx, "2026-10-14", { now: NOW });
    expect(r.period).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(r.periodLabel).toBe("Semana de 12/10/2026 a 18/10/2026");
    expect(r.totals).toEqual({ incomeCents: 0, expenseCents: 120_000, resultCents: -120_000 });
    expect(r.comparison.previousPeriod).toEqual({ start: "2026-10-05", end: "2026-10-11" });
    expect(r.comparison.previousExpenseCents).toBe(25_800 + 4_000);
    expect(r.comparison.previousIncomeCents).toBe(350_000);
    expect(r.topCategories.length).toBeLessThanOrEqual(5);

    const bills = r.upcomingBills;
    expect(bills.from).toBe("2026-10-20");
    expect(bills.to).toBe("2026-10-27");
    const names = bills.items.map((b) => b.description);
    expect(names).toContain("Conta de luz");
    expect(names).toContain("Condomínio"); // vencida, ainda em aberto
    expect(names).not.toContain("Seguro");
    expect(names).not.toContain("Streaming"); // assinatura no cartão entra pela fatura
    const statement = bills.items.find((b) => b.kind === "CARD_STATEMENT");
    expect(statement).toMatchObject({ amountCents: 7_000, date: "2026-10-25", certainty: "CONFIRMED" });
    expect(bills.items.find((b) => b.description === "Conta de luz")?.certainty).toBe("PROJECTION");
    expect(bills.overdueCount).toBe(1);
    expect(bills.totalCents).toBe(18_000 + 60_000 + 7_000);

    const text = reportSummaryText(r);
    expect(text).toMatch(/Resumo semanal/);
    expect(text).toMatch(/Gasto: R\$\s1\.200,00/);
  });

  it("gera, lista e exporta (PDF, XLSX e CSV) com bytes válidos", async () => {
    const { fam } = await seedOctober();
    const report = await generateReport(fam.ctx, { type: "MONTHLY", month: "2026-10" });
    expect(report.data.scope).toBe("FAMILY");
    const list = await listReports(fam.ctx);
    expect(list.map((r) => r.id)).toContain(report.id);
    expect((await getReport(fam.wifeCtx, report.id)).id).toBe(report.id);

    const pdf = await exportReport(fam.ctx, report.id, "pdf");
    expect(pdf.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.fileName).toBe("relatorio-mensal-2026-10.pdf");
    expect(pdf.content.length).toBeGreaterThan(3_000);

    const xlsx = await exportReport(fam.ctx, report.id, "xlsx");
    expect(xlsx.content.subarray(0, 2).toString("latin1")).toBe("PK");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.content as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Resumo", "Categorias", "Orçamento", "Transações do período"]);
    const txSheet = wb.getWorksheet("Transações do período")!;
    expect(txSheet.getRow(1).getCell(1).value).toBe("Data");
    expect(txSheet.actualRowCount).toBe(1 + 5); // salário, mercado, notebook, transferência, pagamento de fatura
    expect(wb.getWorksheet("Orçamento")!.getRow(2).getCell(1).value).toBe("Alimentação");

    const csv = await exportReport(fam.ctx, report.id, "csv");
    const text = csv.content.toString("utf8");
    expect(text.startsWith("﻿Data;Descrição;Categoria;Subcategoria;Tipo;Valor;Forma de pagamento;Conta/Cartão;Responsável;Situação\r\n")).toBe(true);
    expect(text).toContain("10/10/2026;Supermercado Bom Preço;Alimentação;Supermercado;Despesa;-258,00;");
    expect(text).toContain(";Receita;3500,00;");
    expect(text).toContain("Pagamento de fatura;-300,00;");

    const weekly = await generateReport(fam.ctx, { type: "WEEKLY", periodStart: "2026-10-12" });
    const weeklyPdf = await exportReport(fam.ctx, weekly.id, "pdf");
    expect(weeklyPdf.content.subarray(0, 4).toString("latin1")).toBe("%PDF");
    const audits = await prisma.auditLog.count({ where: { householdId: fam.householdId, action: "EXPORT", entityType: "Report" } });
    expect(audits).toBe(4);
  });

  it("relatório da família não expõe contas privadas; relatório pessoal é visível só para quem gerou", async () => {
    // Somente lançamentos em conta (ver nota sobre visibilidade de lançamentos sem conta no relatório do módulo).
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 25_800, description: "Mercado", date: "2026-10-10", accountId: nubank.id });
    const priv = await createAccount(fam.wifeCtx, { name: "Conta da Maria", visibility: "PRIVATE", initialBalanceCents: 10_000 });
    await createTransaction(fam.wifeCtx, { type: "EXPENSE", amountCents: 9_900, description: "Presente surpresa", date: "2026-10-11", accountId: priv.id });

    const family = await buildMonthlyReport(familyScopeContext(fam.householdId, "America/Recife"), "2026-10", { regime: "ACCRUAL", now: NOW });
    expect(family.totals.expenseCents).toBe(25_800);
    expect(family.scope).toBe("FAMILY");
    expect(family.balance.availableCents).toBe(600_000 - 25_800);

    const personal = await generateReport(fam.wifeCtx, { type: "MONTHLY", month: "2026-10", regime: "ACCRUAL" });
    expect(personal.data.scope).toBe("PERSONAL");
    expect(personal.data.totals.expenseCents).toBe(25_800 + 9_900);
    await expect(getReport(fam.ctx, personal.id)).rejects.toThrow(/não encontrad/);
    expect((await listReports(fam.ctx)).map((r) => r.id)).not.toContain(personal.id);
    expect((await listReports(fam.wifeCtx)).map((r) => r.id)).toContain(personal.id);

    // Quem não tem contas privadas gera relatório da família por padrão (visível a todos).
    const shared = await generateReport(fam.ctx, { type: "MONTHLY", month: "2026-10" });
    expect(shared.data.scope).toBe("FAMILY");
    expect((await getReport(fam.wifeCtx, shared.id)).data.totals.expenseCents).toBe(25_800);
  });
  it("rotas da API: gerar, listar, exportar (download binário) e agendamentos", async () => {
    const { fam } = await seedOctober();
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });
    const headers = { cookie: `fa_session=${token}`, origin: "http://localhost:3000" };
    const list = await import("@/app/api/v1/reports/route");
    const exp = await import("@/app/api/v1/reports/[id]/export/route");
    const schedules = await import("@/app/api/v1/reports/schedules/route");
    const schedule = await import("@/app/api/v1/reports/schedules/[type]/route");

    const created = await list.POST(
      new NextRequest("http://localhost:3000/api/v1/reports", { method: "POST", body: JSON.stringify({ type: "MONTHLY", month: "2026-10" }), headers: { ...headers, "content-type": "application/json" } }),
      { params: Promise.resolve({}) },
    );
    expect(created.status).toBe(201);
    const report = (await created.json()).data as { id: string; data: { totals: { expenseCents: number } } };
    expect(report.data.totals.expenseCents).toBe(145_800);

    const pdf = await exp.GET(new NextRequest(`http://localhost:3000/api/v1/reports/${report.id}/export?format=pdf`, { headers }), { params: Promise.resolve({ id: report.id }) });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain('attachment; filename="relatorio-mensal-2026-10.pdf"');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("%PDF");
    const csv = await exp.GET(new NextRequest(`http://localhost:3000/api/v1/reports/${report.id}/export?format=csv`, { headers }), { params: Promise.resolve({ id: report.id }) });
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const bad = await exp.GET(new NextRequest(`http://localhost:3000/api/v1/reports/${report.id}/export?format=doc`, { headers }), { params: Promise.resolve({ id: report.id }) });
    expect(bad.status).toBe(422);

    const listed = await list.GET(new NextRequest("http://localhost:3000/api/v1/reports?type=MONTHLY", { headers }), { params: Promise.resolve({}) });
    expect((await listed.json()).data).toHaveLength(1);
    const sch = await schedules.GET(new NextRequest("http://localhost:3000/api/v1/reports/schedules", { headers }), { params: Promise.resolve({}) });
    expect(((await sch.json()).data as Array<{ type: string; nextRunAt: string | null }>).every((s) => s.nextRunAt)).toBe(true);
    const patched = await schedule.PATCH(
      new NextRequest("http://localhost:3000/api/v1/reports/schedules/monthly", { method: "PATCH", body: JSON.stringify({ dayOfMonth: 5, hour: 9, sendWhatsApp: true }), headers: { ...headers, "content-type": "application/json" } }),
      { params: Promise.resolve({ type: "monthly" }) },
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).data).toMatchObject({ type: "MONTHLY", dayOfMonth: 5, hour: 9, sendWhatsApp: true, nextRunAt: "2026-11-05T12:00:00.000Z" });
  });
});

describe("agendamento de relatórios", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("calcula horários no fuso da família", () => {
    const tz = "America/Recife";
    const cfg = { type: "WEEKLY" as const, dayOfWeek: 1, dayOfMonth: null, hour: 8 };
    expect(zonedInstant("2026-10-19", 8, tz).toISOString()).toBe("2026-10-19T11:00:00.000Z");
    expect(nextOccurrence(cfg, tz, new Date("2026-10-19T10:59:00Z")).toISOString()).toBe("2026-10-19T11:00:00.000Z");
    expect(nextOccurrence(cfg, tz, new Date("2026-10-19T11:00:00Z")).toISOString()).toBe("2026-10-26T11:00:00.000Z");
    expect(latestOccurrence(cfg, tz, new Date("2026-10-21T00:00:00Z")).toISOString()).toBe("2026-10-19T11:00:00.000Z");
    expect(previousCompleteWeek("2026-10-19")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(previousCompleteWeek("2026-10-18")).toEqual({ start: "2026-10-05", end: "2026-10-11" });
    const monthly = { type: "MONTHLY" as const, dayOfWeek: null, dayOfMonth: 31, hour: 7 };
    expect(nextOccurrence(monthly, tz, new Date("2026-11-01T00:00:00Z")).toISOString()).toBe("2026-11-30T10:00:00.000Z");
  });

  it("gera relatórios programados uma única vez por período (idempotente)", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 12_345, description: "Mercado", date: "2026-10-14", accountId: nubank.id });
    await updateReportSchedule(fam.ctx, "WEEKLY", { sendWhatsApp: true, dayOfWeek: 1, hour: 8 });

    const now = new Date("2026-10-19T12:00:00Z");
    // Primeira rodada sem nextRunAt (mensal) apenas agenda; semanal (definido no PATCH) ainda não venceu.
    await prisma.reportSchedule.update({ where: { householdId_type: { householdId: fam.householdId, type: "MONTHLY" } }, data: { nextRunAt: null } });
    await prisma.reportSchedule.update({ where: { householdId_type: { householdId: fam.householdId, type: "WEEKLY" } }, data: { nextRunAt: new Date("2026-10-19T11:00:00Z") } });
    const first = await processScheduledReports(now);
    const weekly = first.find((r) => r.type === "WEEKLY")!;
    expect(weekly).toMatchObject({ status: "generated", periodStart: "2026-10-12", nextRunAt: "2026-10-26T11:00:00.000Z" });
    expect(first.find((r) => r.type === "MONTHLY")!.status).toBe("scheduled");

    const report = await getReport(fam.ctx, weekly.reportId!);
    expect(report.scheduled).toBe(true);
    expect(report.data.totals.expenseCents).toBe(12_345);
    expect(report.data.scope).toBe("FAMILY");

    // Nova rodada: nada vencido.
    const second = await processScheduledReports(now);
    expect(second.find((r) => r.type === "WEEKLY")!.status).toBe("not_due");

    // Mesmo período reprocessado (ex.: agendamento reajustado): não duplica.
    await prisma.reportSchedule.update({ where: { householdId_type: { householdId: fam.householdId, type: "WEEKLY" } }, data: { nextRunAt: new Date("2026-10-19T11:00:00Z") } });
    const third = await processScheduledReports(now);
    expect(third.find((r) => r.type === "WEEKLY")).toMatchObject({ status: "already_generated", reportId: weekly.reportId });
    expect(await prisma.report.count({ where: { householdId: fam.householdId, type: "WEEKLY" } })).toBe(1);

    // Mensal vencido: relatório do mês anterior completo.
    await prisma.reportSchedule.update({ where: { householdId_type: { householdId: fam.householdId, type: "MONTHLY" } }, data: { nextRunAt: new Date("2026-10-01T11:00:00Z") } });
    const fourth = await processScheduledReports(now);
    expect(fourth.find((r) => r.type === "MONTHLY")).toMatchObject({ status: "generated", periodStart: "2026-09-01", nextRunAt: "2026-11-01T11:00:00.000Z" });

    const schedules = await listReportSchedules(fam.ctx);
    const w = schedules.find((s) => s.type === "WEEKLY")!;
    expect(w.sendWhatsApp).toBe(true);
    expect(w.lastRunAt).not.toBeNull();

    // Desabilitado: não executa.
    await updateReportSchedule(fam.ctx, "WEEKLY", { enabled: false });
    const fifth = await processScheduledReports(new Date("2026-12-01T12:00:00Z"));
    expect(fifth.find((r) => r.type === "WEEKLY")).toBeUndefined();
    await expect(updateReportSchedule(fam.wifeCtx, "WEEKLY", { enabled: true })).rejects.toThrow(/permissão/);
  });
});
