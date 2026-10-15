import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import * as goalsRoute from "@/app/api/v1/goals/route";
import * as goalItemRoute from "@/app/api/v1/goals/[id]/route";
import * as goalContribRoute from "@/app/api/v1/goals/[id]/contributions/route";
import * as contribItemRoute from "@/app/api/v1/goals/contributions/[id]/route";
import { prisma } from "@/server/db";
import { addMonths, endOfMonth, startOfMonth, todayISO } from "@/lib/dates";
import { createAccount, getAccount } from "@/server/modules/accounts/service";
import { dashboardSummary } from "@/server/modules/analytics/service";
import {
  contributeToGoal,
  createGoal,
  deleteContribution,
  deleteGoal,
  findGoalByName,
  getGoal,
  listContributions,
  listGoals,
  updateGoal,
} from "@/server/modules/goals/service";
import { createBasicAccounts, createFamily, resetDatabase } from "./helpers";

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

async function monthTotals(ctx: Parameters<typeof dashboardSummary>[0]) {
  const today = todayISO(TZ);
  const s = await dashboardSummary(ctx, { period: { start: startOfMonth(today), end: endOfMonth(today) } });
  return { income: s.incomeCents, expense: s.expenseCents };
}

describe("metas financeiras", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("alocação interna não altera saldos nem despesas", async () => {
    const fam = await createFamily();
    const { nubank, itau } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const deadline = addMonths(today, 5);
    const goal = await createGoal(fam.ctx, { name: "Viagem para Gramado", targetCents: 500_000, deadline });
    expect(goal).toMatchObject({ savedCents: 0, percent: 0, remainingCents: 500_000, status: "ACTIVE", monthsLeft: 6 });

    const res = await contributeToGoal(fam.ctx, goal.id, { amountCents: 50_000, note: "Separado do salário" });
    expect(res.created).toBe(true);
    expect(res.transaction).toBeNull();
    expect(res.contribution.kind).toBe("ALLOCATION");
    expect(res.goal).toMatchObject({ savedCents: 50_000, percent: 10, remainingCents: 450_000, monthlyNeededCents: 75_000 });

    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(100_000);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(500_000);
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    expect(await monthTotals(fam.ctx)).toEqual({ income: 0, expense: 0 });

    // Contribuição informando a própria conta da meta também é alocação interna.
    const withAccount = await createGoal(fam.ctx, { name: "Reserva", targetCents: 100_000, accountId: itau.id });
    const same = await contributeToGoal(fam.ctx, withAccount.id, { amountCents: 10_000, fromAccountId: itau.id });
    expect(same.transaction).toBeNull();
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(500_000);

    const list = await listGoals(fam.ctx);
    expect(list.items.map((g) => g.name)).toEqual(["Viagem para Gramado", "Reserva"]);
    expect(list.totals).toMatchObject({ activeCount: 2, targetCents: 600_000, savedCents: 60_000 });
  });

  it("contribuição com transferência muda os saldos sem gerar despesa; resgate devolve o dinheiro", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const poupanca = await createAccount(fam.ctx, { name: "Poupança", type: "SAVINGS", initialBalanceCents: 0, initialBalanceDate: "2026-01-01" });
    const goal = await createGoal(fam.ctx, { name: "Reserva de emergência", targetCents: 1_000_000, accountId: poupanca.id });

    const c1 = await contributeToGoal(fam.ctx, goal.id, { amountCents: 100_000, fromAccountId: itau.id });
    expect(c1.contribution.kind).toBe("TRANSFER");
    expect(c1.transaction).toMatchObject({ type: "TRANSFER", amountCents: 100_000, goalId: goal.id });
    expect(c1.transaction!.account?.id).toBe(itau.id);
    expect(c1.transaction!.destinationAccount?.id).toBe(poupanca.id);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(400_000);
    expect((await getAccount(fam.ctx, poupanca.id)).balanceCents).toBe(100_000);
    expect(await monthTotals(fam.ctx)).toEqual({ income: 0, expense: 0 });

    const w = await contributeToGoal(fam.ctx, goal.id, { amountCents: -30_000, fromAccountId: itau.id, note: "Conserto do carro" });
    expect(w.transaction!.account?.id).toBe(poupanca.id);
    expect(w.transaction!.destinationAccount?.id).toBe(itau.id);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(430_000);
    expect((await getAccount(fam.ctx, poupanca.id)).balanceCents).toBe(70_000);
    expect(w.goal.savedCents).toBe(70_000);
    expect(await monthTotals(fam.ctx)).toEqual({ income: 0, expense: 0 });

    await expect(contributeToGoal(fam.ctx, goal.id, { amountCents: -70_001 })).rejects.toThrow(/resgate é maior/);
    await expect(contributeToGoal(fam.ctx, goal.id, { amountCents: 0 })).rejects.toThrow(/diferente de zero/);

    // Excluir a contribuição que deixaria o acumulado negativo é bloqueado.
    await expect(deleteContribution(fam.ctx, c1.contribution.id)).rejects.toThrow(/negativo/);

    // Excluir o resgate desfaz a transferência correspondente.
    await deleteContribution(fam.ctx, w.contribution.id);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(400_000);
    expect((await getAccount(fam.ctx, poupanca.id)).balanceCents).toBe(100_000);
    const deletedTx = await prisma.transaction.findUniqueOrThrow({ where: { id: w.transaction!.id } });
    expect(deletedTx.deletedAt).not.toBeNull();

    await deleteContribution(fam.ctx, c1.contribution.id);
    expect((await getAccount(fam.ctx, itau.id)).balanceCents).toBe(500_000);
    expect((await getGoal(fam.ctx, goal.id)).savedCents).toBe(0);

    const history = await listContributions(fam.ctx, goal.id, { includeDeleted: true });
    expect(history.items).toHaveLength(2);
    expect(history.items.every((i) => i.deletedAt)).toBe(true);
    expect((await listContributions(fam.ctx, goal.id)).items).toHaveLength(0);
  });

  it("conclui automaticamente ao atingir o valor desejado, com auditoria", async () => {
    const fam = await createFamily();
    const goal = await createGoal(fam.ctx, { name: "Notebook", targetCents: 100_000 });
    const first = await contributeToGoal(fam.ctx, goal.id, { amountCents: 60_000 });
    expect(first.completedNow).toBe(false);
    const second = await contributeToGoal(fam.ctx, goal.id, { amountCents: 40_000 });
    expect(second.completedNow).toBe(true);
    expect(second.goal).toMatchObject({ status: "COMPLETED", percent: 100, remainingCents: 0 });

    const auto = await prisma.auditLog.findFirstOrThrow({ where: { householdId: fam.householdId, entityType: "FinancialGoal", entityId: goal.id, source: "auto" } });
    expect(auto.after).toEqual({ status: "COMPLETED" });

    // Corrigir um lançamento (excluir a contribuição) reabre a meta.
    const reopened = await deleteContribution(fam.ctx, second.contribution.id);
    expect(reopened.goal.status).toBe("ACTIVE");

    // Aumentar o valor desejado de uma meta concluída reabre; reduzir abaixo do acumulado conclui.
    const done = await updateGoal(fam.ctx, goal.id, { targetCents: 50_000 });
    expect(done.status).toBe("COMPLETED");
    const again = await updateGoal(fam.ctx, goal.id, { targetCents: 80_000 });
    expect(again.status).toBe("ACTIVE");

    const archived = await updateGoal(fam.ctx, goal.id, { status: "ARCHIVED" });
    expect(archived.status).toBe("ARCHIVED");
    await expect(contributeToGoal(fam.ctx, goal.id, { amountCents: 1_000 })).rejects.toThrow(/arquivada/);
    expect((await listGoals(fam.ctx)).items).toHaveLength(0);
    expect((await listGoals(fam.ctx, { includeArchived: true })).items).toHaveLength(1);
  });

  it("busca aproximada pelo nome para o motor de IA", async () => {
    const fam = await createFamily();
    const travel = await createGoal(fam.ctx, { name: "Viagem para Gramado", targetCents: 500_000 });
    const emergency = await createGoal(fam.ctx, { name: "Reserva de Emergência", targetCents: 1_000_000 });
    await createGoal(fam.ctx, { name: "Carro novo", targetCents: 4_000_000 });

    expect((await findGoalByName(fam.ctx, "viagem"))?.id).toBe(travel.id);
    expect((await findGoalByName(fam.ctx, "a viagem"))?.id).toBe(travel.id);
    expect((await findGoalByName(fam.ctx, "viagens"))?.id).toBe(travel.id);
    expect((await findGoalByName(fam.ctx, "reserva de emergencia"))).toMatchObject({ id: emergency.id, score: 1 });
    expect((await findGoalByName(fam.ctx, "emergência"))?.id).toBe(emergency.id);
    expect(await findGoalByName(fam.ctx, "casa na praia")).toBeNull();
    expect(await findGoalByName(fam.ctx, "")).toBeNull();
  });

  it("CRUD, nome único, idempotência por mensagem e isolamento entre famílias", async () => {
    const fam = await createFamily();
    const goal = await createGoal(fam.ctx, { name: "Viagem", targetCents: 200_000, color: "#2563eb", icon: "plane" });
    await expect(createGoal(fam.ctx, { name: "viagem", targetCents: 1 })).rejects.toThrow(/Já existe/);

    // A mesma mensagem do WhatsApp não gera contribuição duplicada.
    const a = await contributeToGoal(fam.ctx, goal.id, { amountCents: 50_000, sourceMessageId: "msg-123" });
    const b = await contributeToGoal(fam.ctx, goal.id, { amountCents: 50_000, sourceMessageId: "msg-123" });
    expect(b.created).toBe(false);
    expect(b.contribution.id).toBe(a.contribution.id);
    expect((await getGoal(fam.ctx, goal.id)).savedCents).toBe(50_000);

    const other = await createFamily("Outra família");
    await expect(getGoal(other.ctx, goal.id)).rejects.toThrow(/não encontrad/);
    await expect(contributeToGoal(other.ctx, goal.id, { amountCents: 1 })).rejects.toThrow(/não encontrad/);
    await expect(deleteContribution(other.ctx, a.contribution.id)).rejects.toThrow(/não encontrad/);
    expect(await findGoalByName(other.ctx, "viagem")).toBeNull();

    const viewer = { ...fam.ctx, role: "VIEWER" as const };
    await expect(contributeToGoal(viewer, goal.id, { amountCents: 1 })).rejects.toThrow(/permissão/);

    await deleteGoal(fam.ctx, goal.id);
    expect(await prisma.goalContribution.count({ where: { goalId: goal.id } })).toBe(0);
    const actions = (await prisma.auditLog.findMany({ where: { entityType: "FinancialGoal", entityId: goal.id }, orderBy: { createdAt: "asc" } })).map((x) => x.action);
    expect(actions).toEqual(["CREATE", "DELETE"]);
  });

  it("API: metas e contribuições", async () => {
    const fam = await createFamily();
    const { itau } = await createBasicAccounts(fam.ctx);
    const poupanca = await createAccount(fam.ctx, { name: "Poupança", type: "SAVINGS", initialBalanceCents: 0, initialBalanceDate: "2026-01-01" });
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });

    const created = await api(goalsRoute.POST, { token, path: "/api/v1/goals", method: "POST", body: { name: "Viagem", targetCents: 300_000, accountId: poupanca.id } });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const contrib = await api(goalContribRoute.POST, { token, path: `/api/v1/goals/${id}/contributions`, method: "POST", body: { amountCents: 50_000, fromAccountId: itau.id }, params: { id } });
    expect(contrib.status).toBe(201);
    expect(contrib.body.data.contribution.kind).toBe("TRANSFER");
    expect((await getAccount(fam.ctx, poupanca.id)).balanceCents).toBe(50_000);
    const history = await api(goalContribRoute.GET, { token, path: `/api/v1/goals/${id}/contributions?limit=10`, params: { id } });
    expect(history.body.data.items).toHaveLength(1);
    const list = await api(goalsRoute.GET, { token, path: "/api/v1/goals?includeArchived=true" });
    expect(list.body.data.items[0]).toMatchObject({ id, savedCents: 50_000 });
    const patched = await api(goalItemRoute.PATCH, { token, path: `/api/v1/goals/${id}`, method: "PATCH", body: { targetCents: 50_000 }, params: { id } });
    expect(patched.body.data.status).toBe("COMPLETED");
    const cid = contrib.body.data.contribution.id as string;
    const removed = await api(contribItemRoute.DELETE, { token, path: `/api/v1/goals/contributions/${cid}`, method: "DELETE", params: { id: cid } });
    expect(removed.body.data.goal).toMatchObject({ savedCents: 0, status: "ACTIVE" });
    expect((await getAccount(fam.ctx, poupanca.id)).balanceCents).toBe(0);
    expect((await api(goalItemRoute.GET, { token, path: `/api/v1/goals/${id}`, params: { id } })).body.data.recentContributions).toHaveLength(0);
    expect((await api(goalItemRoute.DELETE, { token, path: `/api/v1/goals/${id}`, method: "DELETE", params: { id } })).body.data).toEqual({ ok: true });
  });
});
