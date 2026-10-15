import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import * as budgetsRoute from "@/app/api/v1/budgets/route";
import * as budgetItemRoute from "@/app/api/v1/budgets/[id]/route";
import * as budgetBulkRoute from "@/app/api/v1/budgets/bulk/route";
import * as budgetCopyRoute from "@/app/api/v1/budgets/copy-previous/route";
import * as budgetHistoryRoute from "@/app/api/v1/budgets/history/route";
import { prisma } from "@/server/db";
import { addMonthsToKey, MONTH_NAMES, monthKey, todayISO } from "@/lib/dates";
import { createTransaction } from "@/server/modules/transactions/service";
import {
  budgetHistory,
  checkBudgetAlerts,
  copyPreviousMonth,
  deleteBudget,
  listBudgets,
  setBudgetsBulk,
  updateBudget,
  upsertBudget,
} from "@/server/modules/budgets/service";
import { runBudgetAlertJobs } from "@/server/modules/budgets/jobs";
import { categoryId, createBasicAccounts, createFamily, resetDatabase, subcategory } from "./helpers";

const TZ = "America/Recife";

type RouteHandler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Chama um handler de rota com sessão real (cookie), mesma origem e corpo JSON. */
async function api(handler: RouteHandler, opts: { token: string; path: string; method?: string; body?: unknown; params?: Record<string, string> }) {
  const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${opts.token}`, origin: "http://localhost:3000", host: "localhost:3000" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(new URL(opts.path, "http://localhost:3000"), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  // Corpo JSON livre: os testes inspecionam a resposta como o cliente faria.
  return { status: res.status, body: (await res.json()) as { data?: any; error?: { code: string; message: string } } }; // eslint-disable-line
}

describe("orçamentos", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("define limite somente para categorias de despesa e mostra o realizado do mês", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const month = monthKey(today);
    const food = await categoryId(fam.householdId, "Alimentação");
    const work = await categoryId(fam.householdId, "Trabalho", "INCOME");

    await expect(upsertBudget(fam.ctx, { categoryId: work, month, limitCents: 10_000 })).rejects.toThrow(/categorias de despesa/);
    await expect(upsertBudget(fam.ctx, { categoryId: food, month: "2026-13", limitCents: 10_000 })).rejects.toThrow();

    const first = await upsertBudget(fam.ctx, { categoryId: food, month, limitCents: 150_000 });
    const second = await upsertBudget(fam.ctx, { categoryId: food, month, limitCents: 200_000 });
    expect(second.id).toBe(first.id);
    expect(await prisma.budget.count({ where: { householdId: fam.householdId } })).toBe(1);

    const sup = await subcategory(fam.householdId, "Supermercado");
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 50_000, description: "Mercado", date: today, subcategoryId: sup.id, accountId: nubank.id });
    const list = await listBudgets(fam.ctx, { month });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ limitCents: 200_000, spentCents: 50_000, remainingCents: 150_000, percentUsed: 25, alertsTriggered: [] });
    expect(list.unbudgetedCategories.some((c) => c.id === food)).toBe(false);
    expect(list.unbudgetedCategories.length).toBeGreaterThan(5);

    const audits = await prisma.auditLog.findMany({ where: { householdId: fam.householdId, entityType: "Budget" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["CREATE", "UPDATE"]);

    const viewer = { ...fam.ctx, role: "VIEWER" as const };
    await expect(upsertBudget(viewer, { categoryId: food, month, limitCents: 1 })).rejects.toThrow(/permissão/);
  });

  it("emite cada alerta de limiar uma única vez, com mensagem neutra", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const month = monthKey(today);
    const food = await categoryId(fam.householdId, "Alimentação");
    const budget = await upsertBudget(fam.ctx, { categoryId: food, month, limitCents: 200_000 });

    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 150_000, description: "Compras do mês", date: today, categoryId: food, accountId: nubank.id });
    const firstRun = await checkBudgetAlerts(fam.householdId);
    // 50% e 75% atingidos de uma vez: ambos registrados, apenas o maior notificado.
    expect(firstRun).toEqual({ alerts: 2, notifications: 1 });
    const monthName = MONTH_NAMES[Number(month.slice(5, 7)) - 1];
    const husbandInbox = () =>
      prisma.notification.findMany({ where: { householdId: fam.householdId, type: "BUDGET_THRESHOLD", channel: "IN_APP", recipientMemberId: fam.husbandId }, orderBy: { createdAt: "asc" } });
    let inbox = await husbandInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe(`Alimentação atingiu 75% do orçamento de ${monthName} (R$ 1.500,00 de R$ 2.000,00).`);
    expect(inbox[0]!.dedupeKey).toBe(`budget:${budget.id}:75:in:${fam.husbandId}`);

    expect(await checkBudgetAlerts(fam.householdId)).toEqual({ alerts: 0, notifications: 0 });

    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 40_000, description: "Restaurante", date: today, categoryId: food, accountId: nubank.id });
    expect(await checkBudgetAlerts(fam.householdId)).toEqual({ alerts: 1, notifications: 1 });
    expect(await checkBudgetAlerts(fam.householdId)).toEqual({ alerts: 0, notifications: 0 });

    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 10_000, description: "Padaria", date: today, categoryId: food, accountId: nubank.id });
    expect(await checkBudgetAlerts(fam.householdId)).toEqual({ alerts: 1, notifications: 1 });

    const alerts = await prisma.budgetAlert.findMany({ where: { budgetId: budget.id }, orderBy: { threshold: "asc" } });
    expect(alerts.map((a) => a.threshold)).toEqual([50, 75, 90, 100]);
    inbox = await husbandInbox();
    expect(inbox.map((n) => n.body)).toEqual([
      `Alimentação atingiu 75% do orçamento de ${monthName} (R$ 1.500,00 de R$ 2.000,00).`,
      `Alimentação atingiu 90% do orçamento de ${monthName} (R$ 1.900,00 de R$ 2.000,00).`,
      `Alimentação atingiu 100% do orçamento de ${monthName} (R$ 2.000,00 de R$ 2.000,00).`,
    ]);
    // A esposa também recebe (preferências padrão) e o grupo recebe uma mensagem por alerta.
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, recipientMemberId: fam.wifeId, type: "BUDGET_THRESHOLD" } })).toBe(3);
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, channel: "WHATSAPP", type: "BUDGET_THRESHOLD" } })).toBe(3);

    const list = await listBudgets(fam.ctx, { month });
    expect(list.items[0]!.alertsTriggered).toEqual([50, 75, 90, 100]);

    // O job percorre as famílias e continua idempotente.
    expect(await runBudgetAlertJobs()).toMatchObject({ households: 1, alerts: 0, notifications: 0 });
  });

  it("respeita os limiares configurados pela família e ignora meses anteriores", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const month = monthKey(today);
    const food = await categoryId(fam.householdId, "Alimentação");
    await prisma.householdSettings.update({ where: { householdId: fam.householdId }, data: { budgetAlertThresholds: [80] } });
    await upsertBudget(fam.ctx, { categoryId: food, month, limitCents: 100_000 });
    await upsertBudget(fam.ctx, { categoryId: food, month: addMonthsToKey(month, -1), limitCents: 1_000 });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 79_999, description: "Mercado", date: today, categoryId: food, accountId: nubank.id });
    expect(await checkBudgetAlerts(fam.householdId)).toEqual({ alerts: 0, notifications: 0 });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 1, description: "Bala", date: today, categoryId: food, accountId: nubank.id });
    expect(await checkBudgetAlerts(fam.householdId)).toEqual({ alerts: 1, notifications: 1 });
    expect(await prisma.budgetAlert.count()).toBe(1);
  });

  it("define em lote, copia do mês anterior sem sobrescrever e exclui", async () => {
    const fam = await createFamily();
    const month = monthKey(todayISO(TZ));
    const prev = addMonthsToKey(month, -1);
    const food = await categoryId(fam.householdId, "Alimentação");
    const home = await categoryId(fam.householdId, "Moradia");
    const transport = await categoryId(fam.householdId, "Transporte");

    expect(
      await setBudgetsBulk(fam.ctx, {
        month: prev,
        items: [
          { categoryId: food, limitCents: 100_000 },
          { categoryId: home, limitCents: 300_000 },
          { categoryId: transport, limitCents: 50_000 },
        ],
      }),
    ).toMatchObject({ upserted: 3, removed: 0 });
    expect(await setBudgetsBulk(fam.ctx, { month: prev, items: [{ categoryId: transport, limitCents: null }] })).toMatchObject({ upserted: 0, removed: 1 });
    await expect(setBudgetsBulk(fam.ctx, { month: prev, items: [{ categoryId: food, limitCents: 1 }, { categoryId: food, limitCents: 2 }] })).rejects.toThrow(/apenas uma vez/);

    await upsertBudget(fam.ctx, { categoryId: food, month, limitCents: 120_000 });
    const copy = await copyPreviousMonth(fam.ctx, { month });
    expect(copy).toEqual({ month, sourceMonth: prev, copied: 1, skipped: 1 });
    expect(await copyPreviousMonth(fam.ctx, { month })).toMatchObject({ copied: 0, skipped: 2 });

    const list = await listBudgets(fam.ctx, { month });
    const byCat = new Map(list.items.map((i) => [i.category.id, i]));
    expect(byCat.get(food)!.limitCents).toBe(120_000);
    expect(byCat.get(home)!.limitCents).toBe(300_000);
    expect(list.totalLimitCents).toBe(420_000);

    await updateBudget(fam.ctx, byCat.get(home)!.budgetId, { limitCents: 310_000 });
    await deleteBudget(fam.ctx, byCat.get(food)!.budgetId);
    const after = await listBudgets(fam.ctx, { month });
    expect(after.items.map((i) => [i.category.id, i.limitCents])).toEqual([[home, 310_000]]);
    await expect(deleteBudget(fam.ctx, byCat.get(food)!.budgetId)).rejects.toThrow(/não encontrad/);

    // Outra família não enxerga nem altera.
    const other = await createFamily("Outra");
    await expect(deleteBudget(other.ctx, byCat.get(home)!.budgetId)).rejects.toThrow(/não encontrad/);
    expect((await listBudgets(other.ctx, { month })).items).toHaveLength(0);
  });

  it("histórico de limite × realizado por categoria", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const month = monthKey(todayISO(TZ));
    const prev = addMonthsToKey(month, -1);
    const food = await categoryId(fam.householdId, "Alimentação");
    const leisure = await categoryId(fam.householdId, "Lazer");
    await upsertBudget(fam.ctx, { categoryId: food, month: prev, limitCents: 100_000 });
    await upsertBudget(fam.ctx, { categoryId: food, month, limitCents: 120_000 });
    await upsertBudget(fam.ctx, { categoryId: leisure, month, limitCents: 30_000 });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 80_000, description: "Mercado", date: `${prev}-10`, categoryId: food, accountId: nubank.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 30_000, description: "Feira", date: `${month}-01`, categoryId: food, accountId: nubank.id });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 6_000, description: "Cinema", date: `${month}-01`, categoryId: leisure, accountId: nubank.id });

    const history = await budgetHistory(fam.ctx, { months: 3 });
    expect(history.months).toEqual([addMonthsToKey(month, -2), prev, month]);
    const foodSeries = history.series.find((s) => s.category.id === food)!;
    expect(foodSeries.points).toEqual([
      { month: addMonthsToKey(month, -2), limitCents: null, spentCents: 0, percentUsed: null },
      { month: prev, limitCents: 100_000, spentCents: 80_000, percentUsed: 80 },
      { month, limitCents: 120_000, spentCents: 30_000, percentUsed: 25 },
    ]);
    expect(history.totals[2]).toEqual({ month, limitCents: 150_000, spentCents: 36_000, percentUsed: 24 });

    const only = await budgetHistory(fam.ctx, { months: 2, categoryId: leisure });
    expect(only.series).toHaveLength(1);
    expect(only.series[0]!.points.map((p) => p.spentCents)).toEqual([0, 6_000]);
  });

  it("API: orçamentos", async () => {
    const fam = await createFamily();
    const month = monthKey(todayISO(TZ));
    const prev = addMonthsToKey(month, -1);
    const food = await categoryId(fam.householdId, "Alimentação");
    const home = await categoryId(fam.householdId, "Moradia");
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });

    const up = await api(budgetsRoute.POST, { token, path: "/api/v1/budgets", method: "POST", body: { categoryId: food, month, limitCents: 150_000 } });
    expect(up.status).toBe(201);
    const bulk = await api(budgetBulkRoute.POST, { token, path: "/api/v1/budgets/bulk", method: "POST", body: { month: prev, items: [{ categoryId: home, limitCents: 200_000 }] } });
    expect(bulk.body.data).toMatchObject({ upserted: 1, removed: 0 });
    const copy = await api(budgetCopyRoute.POST, { token, path: "/api/v1/budgets/copy-previous", method: "POST", body: { month } });
    expect(copy.body.data.copied).toBe(1);
    const list = await api(budgetsRoute.GET, { token, path: `/api/v1/budgets?month=${month}` });
    expect(list.status).toBe(200);
    expect(list.body.data.totalLimitCents).toBe(350_000);
    const bad = await api(budgetsRoute.GET, { token, path: "/api/v1/budgets?month=2026-1" });
    expect(bad.status).toBe(422);
    const history = await api(budgetHistoryRoute.GET, { token, path: "/api/v1/budgets/history?months=2" });
    expect(history.body.data.months).toEqual([prev, month]);
    const id = up.body.data.id as string;
    expect((await api(budgetItemRoute.PATCH, { token, path: `/api/v1/budgets/${id}`, method: "PATCH", body: { limitCents: 160_000 }, params: { id } })).body.data.limitCents).toBe(160_000);
    expect((await api(budgetItemRoute.DELETE, { token, path: `/api/v1/budgets/${id}`, method: "DELETE", params: { id } })).body.data).toEqual({ ok: true });
  });
});
