import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import * as billsRoute from "@/app/api/v1/bills/route";
import * as billRoute from "@/app/api/v1/bills/[id]/route";
import * as billPayRoute from "@/app/api/v1/bills/[id]/pay/route";
import * as billSkipRoute from "@/app/api/v1/bills/[id]/skip/route";
import * as billCancelRoute from "@/app/api/v1/bills/[id]/cancel/route";
import * as recurringRoute from "@/app/api/v1/recurring/route";
import * as recurringItemRoute from "@/app/api/v1/recurring/[id]/route";
import * as recurringToggleRoute from "@/app/api/v1/recurring/[id]/toggle/route";
import { prisma } from "@/server/db";
import { addDays, dateToISO, formatDateBR, todayISO } from "@/lib/dates";
import { createAccount, getAccount } from "@/server/modules/accounts/service";
import { statementForClosingMonth } from "@/server/modules/cards/billing";
import { createCard, listStatements } from "@/server/modules/cards/service";
import { createTransaction } from "@/server/modules/transactions/service";
import { cancelBill, createBill, findMatchingScheduledPayment, getBill, listBills, markPaid, skipBill, undoPayment, updateBill } from "@/server/modules/bills/service";
import { runBillReminderJobs } from "@/server/modules/bills/jobs";
import { createRecurring } from "@/server/modules/recurring/service";
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

/** Configuração de cartão cuja fatura deste mês já fechou e ainda não venceu. */
function closedStatementCard(today: string) {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  for (let closingDay = Math.min(d, 28); closingDay >= 1; closingDay--) {
    for (let dueDay = 1; dueDay <= 28; dueDay++) {
      const st = statementForClosingMonth(y, m, { closingDay, dueDay });
      if (st.closingDate <= today && st.dueDate >= today) return { closingDay, dueDay, purchaseDate: addDays(st.closingDate, -1), statement: st };
    }
  }
  throw new Error("configuração não encontrada");
}

describe("contas a pagar", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("status derivado, totais, pagamento vinculado e desfazer pagamento", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const home = await categoryId(fam.householdId, "Moradia");
    const iptu = await createBill(fam.ctx, { description: "IPTU", amountCents: 35_000, dueDate: addDays(today, 5), categoryId: home });
    const condo = await createBill(fam.ctx, { description: "Condomínio", amountCents: 80_000, dueDate: addDays(today, -3), categoryId: home });
    const refund = await createBill(fam.ctx, { type: "INCOME", description: "Reembolso do plano", amountCents: 20_000, dueDate: addDays(today, 2) });
    expect(iptu.status).toBe("PENDING");
    expect(condo).toMatchObject({ status: "OVERDUE", statusLabel: "Vencida", daysUntilDue: -3 });

    const list = await listBills(fam.ctx, { start: addDays(today, -10), end: addDays(today, 10) });
    expect(list.items.map((i) => i.description)).toEqual(["Condomínio", "Reembolso do plano", "IPTU"]);
    expect(list.totals).toMatchObject({ pendingCents: 35_000, overdueCents: 80_000, toPayCents: 115_000, paidCents: 0, expectedIncomeCents: 20_000 });

    // Vencidas anteriores ao período aparecem por padrão (quando o período começa até hoje).
    const fromToday = await listBills(fam.ctx, { start: today, end: addDays(today, 10) });
    expect(fromToday.items.map((i) => i.description).sort()).toEqual(["Condomínio", "IPTU", "Reembolso do plano"]);
    const onlyPeriod = await listBills(fam.ctx, { start: today, end: addDays(today, 10), includeOverdue: false });
    expect(onlyPeriod.items.map((i) => i.description).sort()).toEqual(["IPTU", "Reembolso do plano"]);
    // Períodos futuros não repetem as vencidas.
    const future = await listBills(fam.ctx, { start: addDays(today, 1), end: addDays(today, 10) });
    expect(future.items.map((i) => i.description).sort()).toEqual(["IPTU", "Reembolso do plano"]);

    const { bill, transaction } = await markPaid(fam.ctx, condo.id, { accountId: nubank.id, date: today, paymentMethod: "PIX" });
    expect(transaction).toMatchObject({ type: "EXPENSE", amountCents: 80_000, source: "MANUAL", paymentMethod: "PIX" });
    expect(transaction.category?.id).toBe(home);
    expect(bill).toMatchObject({ status: "PAID", paidAmountCents: 80_000 });
    expect(bill.transaction?.id).toBe(transaction.id);
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(20_000);
    await expect(markPaid(fam.ctx, condo.id, { accountId: nubank.id })).rejects.toThrow(/já foi paga/);
    await expect(updateBill(fam.ctx, condo.id, { amountCents: 1 })).rejects.toThrow(/Desfaça o pagamento/);

    const paidList = await listBills(fam.ctx, { start: addDays(today, -10), end: addDays(today, 10), statuses: ["PAID"] });
    expect(paidList.items.map((i) => i.id)).toEqual([condo.id]);
    expect(paidList.totals).toMatchObject({ paidCents: 80_000, overdueCents: 0, toPayCents: 35_000 });

    // Receita prevista recebida.
    const received = await markPaid(fam.ctx, refund.id, { accountId: nubank.id });
    expect(received.bill.statusLabel).toBe("Recebida");
    expect(received.transaction.type).toBe("INCOME");

    const undone = await undoPayment(fam.ctx, condo.id);
    expect(undone.status).toBe("OVERDUE");
    expect(undone.paidAmountCents).toBeNull();
    expect((await getAccount(fam.ctx, nubank.id)).balanceCents).toBe(120_000);
    const deleted = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(deleted.deletedAt).not.toBeNull();

    // Pode pagar de novo após desfazer, com valor diferente do previsto.
    const repaid = await markPaid(fam.ctx, condo.id, { accountId: nubank.id, amountCents: 82_000 });
    expect(repaid.bill.paidAmountCents).toBe(82_000);
  });

  it("pagamento no cartão deixa a conta como lançada", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const bill = await createBill(fam.ctx, { description: "Seguro", amountCents: 15_000, dueDate: today });
    const res = await markPaid(fam.ctx, bill.id, { creditCardId: card.id });
    expect(res.bill.status).toBe("POSTED");
    expect(res.bill.statusLabel).toBe("Lançada");
    expect(res.transaction.creditCard?.id).toBe(card.id);
  });

  it("ignorar, cancelar e reabrir não geram transação", async () => {
    const fam = await createFamily();
    await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const a = await createBill(fam.ctx, { description: "Mensalidade do clube", amountCents: 10_000, dueDate: addDays(today, 3) });
    const b = await createBill(fam.ctx, { description: "Revista", amountCents: 3_000, dueDate: addDays(today, 4) });
    expect((await skipBill(fam.ctx, a.id)).status).toBe("SKIPPED");
    expect((await skipBill(fam.ctx, a.id)).status).toBe("SKIPPED");
    expect((await cancelBill(fam.ctx, b.id)).statusLabel).toBe("Cancelada");
    await expect(markPaid(fam.ctx, a.id, {})).rejects.toThrow(/Reabra a conta/);
    const reopened = await updateBill(fam.ctx, a.id, { status: "PENDING", amountCents: 12_000 });
    expect(reopened).toMatchObject({ status: "PENDING", amountCents: 12_000 });
    expect(await prisma.transaction.count({ where: { householdId: fam.householdId } })).toBe(0);
    const list = await listBills(fam.ctx, { start: today, end: addDays(today, 10), statuses: ["SKIPPED", "CANCELLED"] });
    expect(list.items.map((i) => i.description)).toEqual(["Revista"]);
  });

  it("faturas de cartão em aberto aparecem como linhas somente leitura", async () => {
    const fam = await createFamily();
    const { card } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 30_000, description: "Farmácia", date: today, creditCardId: card.id });
    const st = (await listStatements(fam.ctx, card.id)).find((s) => s.totalCents > 0)!;
    const list = await listBills(fam.ctx, { start: st.dueDate, end: st.dueDate });
    const row = list.items.find((i) => i.kind === "CARD_STATEMENT")!;
    expect(row).toMatchObject({ id: `statement:${st.id}`, readOnly: true, amountCents: 30_000, dueDate: st.dueDate, type: "EXPENSE" });
    expect(row.statement?.referenceMonth).toBe(st.referenceMonth);
    expect(list.totals).toMatchObject({ statementsCents: 30_000, toPayCents: 30_000 });
    expect((await listBills(fam.ctx, { start: st.dueDate, end: st.dueDate, includeStatements: false })).items).toHaveLength(0);
    expect((await listBills(fam.ctx, { start: st.dueDate, end: st.dueDate, type: "INCOME" })).items).toHaveLength(0);
  });

  it("encontra a conta prevista para evitar duplicidade ao registrar o pagamento", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const home = await categoryId(fam.householdId, "Moradia");
    const internetSub = await subcategory(fam.householdId, "Internet");
    const due = addDays(today, 3);
    const rec = await createRecurring(fam.ctx, {
      description: "Internet Vivo Fibra",
      amountCents: 12_000,
      subcategoryId: internetSub.id,
      accountId: nubank.id,
      dayOfMonth: Number(due.slice(8, 10)),
      startDate: today,
    });
    const occurrence = await prisma.scheduledPayment.findFirstOrThrow({ where: { recurringTransactionId: rec.id }, orderBy: { dueDate: "asc" } });
    expect(dateToISO(occurrence.dueDate)).toBe(due);

    // "Paguei 120 de internet"
    const match = await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 12_000, date: today, description: "Internet", categoryId: home });
    expect(match?.id).toBe(occurrence.id);
    expect(match?.reasons).toContain("valor igual");
    expect(match!.score).toBeGreaterThan(0.8);

    // Mesmo valor, mas outra conta ("luz"): não confunde.
    expect(await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 12_000, date: today, description: "Conta de luz", categoryId: home })).toBeNull();
    // Valor diferente em conta de valor fixo.
    expect(await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 12_500, date: today, description: "Internet" })).toBeNull();
    // Fora da janela de datas (mais de 10 dias antes do vencimento).
    expect(await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 12_000, date: addDays(due, -11), description: "Internet" })).toBeNull();
    // Até 20 dias depois do vencimento ainda casa (pagamento atrasado).
    expect((await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 12_000, date: addDays(due, 20), description: "Internet" }))?.id).toBe(occurrence.id);
    // Descrição genérica com valor exato.
    expect((await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 12_000, date: today, description: "Boleto" }))?.id).toBe(occurrence.id);
    // Tipo diferente.
    expect(await findMatchingScheduledPayment(fam.ctx, { type: "INCOME", amountCents: 12_000, date: today, description: "Internet" })).toBeNull();

    // Conta de valor variável: ±20% e palavras-chave da subcategoria ("luz" → Energia).
    const energySub = await subcategory(fam.householdId, "Energia");
    const energy = await createRecurring(fam.ctx, {
      description: "Neoenergia",
      amountCents: 18_000,
      isVariableAmount: true,
      subcategoryId: energySub.id,
      accountId: nubank.id,
      dayOfMonth: Number(addDays(today, 2).slice(8, 10)),
      startDate: today,
    });
    const energyOcc = await prisma.scheduledPayment.findFirstOrThrow({ where: { recurringTransactionId: energy.id }, orderBy: { dueDate: "asc" } });
    const luz = await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 19_870, date: today, description: "Conta de luz" });
    expect(luz?.id).toBe(energyOcc.id);
    expect(luz?.reasons).toContain("valor dentro da estimativa (±20%)");
    expect(await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 21_700, date: today, description: "Conta de luz" })).toBeNull();

    // O pipeline vincula o lançamento à ocorrência: ela deixa de ser candidata.
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 12_000, description: "Internet", date: today, accountId: nubank.id, categoryId: home }, { scheduledPaymentId: match!.id, source: "WHATSAPP_TEXT" });
    expect((await getBill(fam.ctx, occurrence.id)).status).toBe("PAID");
    expect(await findMatchingScheduledPayment(fam.ctx, { type: "EXPENSE", amountCents: 12_000, date: today, description: "Internet" })).toBeNull();
  });

  it("lembretes de vencimento e avisos de fatura fechada são emitidos uma única vez", async () => {
    const fam = await createFamily();
    await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    await createBill(fam.ctx, { description: "Internet", amountCents: 12_000, dueDate: addDays(today, 2) });
    await createBill(fam.ctx, { description: "Escola", amountCents: 90_000, dueDate: addDays(today, 10) });
    await createBill(fam.ctx, { description: "Energia", amountCents: 18_000, isEstimate: true, dueDate: today });

    const cfg = closedStatementCard(today);
    const card = await createCard(fam.ctx, { name: "Cartão Teste", closingDay: cfg.closingDay, dueDay: cfg.dueDay });
    await createTransaction(fam.ctx, { type: "EXPENSE", amountCents: 45_000, description: "Mercado", date: cfg.purchaseDate, creditCardId: card.id });

    const first = await runBillReminderJobs(new Date(), { householdId: fam.householdId });
    expect(first).toMatchObject({ billReminders: 2, statementNotices: 1 });
    const second = await runBillReminderJobs();
    expect(second).toMatchObject({ billReminders: 0, statementNotices: 0 });

    const bills = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "BILL_DUE", channel: "IN_APP", recipientMemberId: fam.husbandId }, orderBy: { body: "asc" } });
    expect(bills.map((b) => b.body)).toEqual(["Energia vence hoje: R$ 180,00, valor estimado.", `Internet vence em 2 dias (${formatDateBR(addDays(today, 2))}): R$ 120,00.`]);
    const statement = await prisma.notification.findFirstOrThrow({ where: { householdId: fam.householdId, type: "STATEMENT_AVAILABLE", recipientMemberId: fam.husbandId } });
    expect(statement.body).toMatch(/fechou em R\$ 450,00/);
    // Fatura disponível: padrão só no aplicativo; contas a vencer também vão ao grupo do WhatsApp.
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, channel: "WHATSAPP", type: "STATEMENT_AVAILABLE" } })).toBe(0);
    expect(await prisma.notification.count({ where: { householdId: fam.householdId, channel: "WHATSAPP", type: "BILL_DUE" } })).toBe(2);
  });

  it("itens de contas e cartões privados notificam apenas o titular, sem WhatsApp", async () => {
    const fam = await createFamily();
    const today = todayISO(TZ);
    const priv = await createAccount(fam.wifeCtx, { name: "Conta da Maria", visibility: "PRIVATE" });
    await createBill(fam.wifeCtx, { description: "Curso de inglês", amountCents: 30_000, dueDate: addDays(today, 1), accountId: priv.id });
    // O marido não enxerga a conta privada da esposa.
    expect((await listBills(fam.ctx, { start: today, end: addDays(today, 5) })).items).toHaveLength(0);
    expect((await listBills(fam.wifeCtx, { start: today, end: addDays(today, 5) })).items).toHaveLength(1);

    await runBillReminderJobs(new Date(), { householdId: fam.householdId });
    const notes = await prisma.notification.findMany({ where: { householdId: fam.householdId, type: "BILL_DUE" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ channel: "IN_APP", recipientMemberId: fam.wifeId });
    expect(notes[0]!.body).toBe(`Curso de inglês vence amanhã (${formatDateBR(addDays(today, 1))}): R$ 300,00.`);
  });

  it("API: contas a pagar e recorrências (sessão, validação e permissões)", async () => {
    const fam = await createFamily();
    const { nubank } = await createBasicAccounts(fam.ctx);
    const today = todayISO(TZ);
    const { token } = await createSession({ userId: fam.ctx.userId!, householdId: fam.householdId });

    const created = await api(billsRoute.POST, { token, path: "/api/v1/bills", method: "POST", body: { description: "IPTU", amountCents: 35_000, dueDate: addDays(today, 5) } });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const invalid = await api(billsRoute.POST, { token, path: "/api/v1/bills", method: "POST", body: { description: "X", amountCents: -1, dueDate: today } });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.code).toBe("VALIDATION_ERROR");

    const qs = `start=${today}&end=${addDays(today, 10)}`;
    const listed = await api(billsRoute.GET, { token, path: `/api/v1/bills?${qs}&status=PENDING&status=OVERDUE&includeStatements=false` });
    expect(listed.status).toBe(200);
    expect(listed.body.data.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(listed.body.data.totals.toPayCents).toBe(35_000);
    expect((await api(billsRoute.GET, { token, path: `/api/v1/bills?${qs}&status=PAID` })).body.data.items).toHaveLength(0);

    const paid = await api(billPayRoute.POST, { token, path: `/api/v1/bills/${id}/pay`, method: "POST", body: { accountId: nubank.id }, params: { id } });
    expect(paid.status).toBe(201);
    expect(paid.body.data.bill.status).toBe("PAID");
    expect(paid.body.data.transaction.amountCents).toBe(35_000);
    const undone = await api(billPayRoute.DELETE, { token, path: `/api/v1/bills/${id}/pay`, method: "DELETE", params: { id } });
    expect(undone.body.data.status).toBe("PENDING");
    expect((await api(billSkipRoute.POST, { token, path: `/api/v1/bills/${id}/skip`, method: "POST", params: { id } })).body.data.status).toBe("SKIPPED");
    expect((await api(billRoute.PATCH, { token, path: `/api/v1/bills/${id}`, method: "PATCH", body: { status: "PENDING" }, params: { id } })).body.data.status).toBe("PENDING");
    expect((await api(billCancelRoute.POST, { token, path: `/api/v1/bills/${id}/cancel`, method: "POST", params: { id } })).body.data.status).toBe("CANCELLED");
    expect((await api(billRoute.GET, { token, path: `/api/v1/bills/${id}`, params: { id } })).body.data.statusLabel).toBe("Cancelada");

    const rec = await api(recurringRoute.POST, {
      token,
      path: "/api/v1/recurring",
      method: "POST",
      body: { description: "Internet", amountCents: 12_000, accountId: nubank.id, frequency: "MONTHLY", dayOfMonth: 10, startDate: today },
    });
    expect(rec.status).toBe(201);
    const recId = rec.body.data.id as string;
    expect((await api(recurringRoute.GET, { token, path: "/api/v1/recurring?active=true" })).body.data.totals.monthlyExpenseCents).toBe(12_000);
    const patched = await api(recurringItemRoute.PATCH, { token, path: `/api/v1/recurring/${recId}`, method: "PATCH", body: { amountCents: 13_000 }, params: { id: recId } });
    expect(patched.body.data.amountCents).toBe(13_000);
    const toggled = await api(recurringToggleRoute.POST, { token, path: `/api/v1/recurring/${recId}/toggle`, method: "POST", body: {}, params: { id: recId } });
    expect(toggled.body.data.active).toBe(false);
    expect((await api(recurringItemRoute.GET, { token, path: `/api/v1/recurring/${recId}`, params: { id: recId } })).body.data.occurrences.every((o: { status: string }) => o.status === "CANCELLED")).toBe(true);
    expect((await api(recurringItemRoute.DELETE, { token, path: `/api/v1/recurring/${recId}`, method: "DELETE", params: { id: recId } })).status).toBe(200);

    // Sem sessão → 401; origem diferente → 403; somente leitura → 403.
    expect((await api(billsRoute.GET, { token: "x".repeat(40), path: "/api/v1/bills" })).status).toBe(401);
    const foreign = new NextRequest(new URL("/api/v1/bills", "http://localhost:3000"), {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "https://evil.example", host: "localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ description: "X", amountCents: 1, dueDate: today }),
    });
    expect((await billsRoute.POST(foreign, { params: Promise.resolve({}) })).status).toBe(403);
    await prisma.householdMember.update({ where: { id: fam.wifeId }, data: { role: "VIEWER" } });
    const viewer = await createSession({ userId: fam.wifeCtx.userId!, householdId: fam.householdId });
    expect((await api(billsRoute.POST, { token: viewer.token, path: "/api/v1/bills", method: "POST", body: { description: "X", amountCents: 1, dueDate: today } })).status).toBe(403);
    expect((await api(billsRoute.GET, { token: viewer.token, path: "/api/v1/bills" })).status).toBe(200);
  });
});
